import { z } from 'zod';
import { prisma } from '@/lib/db';
import { handleError, ok, fail } from '@/lib/api';
import { requireActor, requireUserId } from '@/lib/auth/authz';
import { recordAudit, auditContextFrom } from '@/lib/audit/log';
import { env } from '@/lib/env';
import {
  PROVIDERS,
  encryptSecret,
  maskApiKey,
  normalizeProvider,
  resolveModel,
  validateBaseUrl,
  invalidateCredentialCache,
  type ProviderId,
} from '@/lib/llm/credentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 用户自带 LLM 凭证（BYOK）的 CRUD。
 *
 * ## 这个接口的安全底线（改代码前请先读）
 *
 * 1. **密钥只进不出**。任何响应里都不出现明文，也不出现密文 ——
 *    只给掩码（sk-…a1b2）。所以下面的 select 是白名单式的，
 *    绝不要图省事写成 `include` 或裸 `findMany`。
 * 2. **所有查询都带 userId**，包括按 id 的更新与删除。
 *    这里的越权后果不是「看到别人的数据」，而是「改掉/删掉别人的 key」，
 *    或者更糟：把自己提交的 key 写到别人的账号上。
 * 3. **baseUrl 必须过校验**。它能决定服务端带着 key 去请求哪个地址。
 */

/** 出参形状：显式列出，任何新增字段都要先问「这个字段能不能给前端」 */
const PUBLIC_FIELDS = {
  id: true,
  label: true,
  provider: true,
  model: true,
  baseUrl: true,
  apiKeyHint: true,
  active: true,
  lastUsedAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CreateSchema = z.object({
  label: z.string().trim().min(1, '请填写名称').max(40, '名称过长'),
  provider: z.string().trim().min(1),
  /** 留空则用 provider 的默认模型 */
  model: z.string().trim().max(80).optional(),
  /** 仅自定义/中转场景需要 */
  baseUrl: z.string().trim().max(300).optional(),
  apiKey: z.string().trim().min(8, 'API Key 过短').max(400, 'API Key 过长'),
  /** 创建时是否直接启用。首个凭证默认启用 */
  active: z.boolean().optional(),
});

const UpdateSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  model: z.string().trim().max(80).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  /** 只在需要更换密钥时传；不传表示保持原密钥 */
  apiKey: z.string().trim().min(8).max(400).optional(),
  active: z.boolean().optional(),
});

/** 部署方是否允许用户自带 Key。关闭时整个功能不可用（含页面入口） */
function credentialsDisabled(): boolean {
  return !env().ALLOW_USER_CREDENTIALS;
}

/** GET：列出当前用户的凭证（掩码）+ 可选的 provider 元数据 */
export async function GET() {
  try {
    const userId = await requireUserId();

    if (credentialsDisabled()) {
      return fail('FORBIDDEN', '本站未开放「自带 API Key」功能，请联系管理员', 403);
    }

    const items = await prisma.apiCredential.findMany({
      where: { userId },
      select: PUBLIC_FIELDS,
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
    });

    const e = env();

    return ok({
      items,
      /** 站点侧是否仍然提供免费额度。BYOK 用户不受站点配额限制 */
      serverFallbackAvailable: Boolean(e.DEEPSEEK_API_KEY) || e.MOCK_LLM,
      mockMode: e.MOCK_LLM,
      /** 是否允许自定义接口地址（前端据此决定要不要显示该输入框） */
      allowCustomBaseUrl: e.ALLOW_CUSTOM_BASE_URL,
      /** 供前端渲染下拉与「去哪里申请 key」的指引 */
      providers: Object.values(PROVIDERS),
    });
  } catch (e) {
    return handleError(e);
  }
}

/** POST：新增凭证 */
export async function POST(req: Request) {
  try {
    const actor = await requireActor();
    const userId = actor.userId;
    if (credentialsDisabled()) {
      return fail('FORBIDDEN', '本站未开放「自带 API Key」功能', 403);
    }
    const body = CreateSchema.parse(await req.json());

    const provider = normalizeProvider(body.provider);
    if (!provider) {
      return fail('VALIDATION_ERROR', '不支持的模型服务', 422, {
        provider: '请选择模型服务',
      });
    }

    let resolvedBaseUrl: string | null = null;
    if (body.baseUrl) {
      const check = validateBaseUrl(body.baseUrl);
      if (!check.ok) {
        return fail('VALIDATION_ERROR', check.message ?? '接口地址不合法', 422, {
          baseUrl: check.message ?? '接口地址不合法',
        });
      }
      resolvedBaseUrl = check.url!;
    } else if (provider === 'custom') {
      return fail('VALIDATION_ERROR', '自定义服务必须填写接口地址', 422, {
        baseUrl: '自定义服务必须填写接口地址',
      });
    } else if (!PROVIDERS[provider].baseUrl) {
      return fail('VALIDATION_ERROR', '该服务缺少默认接口地址，请手动填写', 422, {
        baseUrl: '请填写接口地址',
      });
    }

    // 首个凭证自动启用，减少一步操作
    const existingCount = await prisma.apiCredential.count({ where: { userId } });
    const shouldActivate = body.active ?? existingCount === 0;

    const created = await prisma.$transaction(async (tx) => {
      // 同一用户最多一个启用：先全部关掉，再启用新的。
      // 放在事务里，避免中途失败留下「两个都启用」的状态。
      if (shouldActivate) {
        await tx.apiCredential.updateMany({
          where: { userId, active: true },
          data: { active: false },
        });
      }

      return tx.apiCredential.create({
        data: {
          userId,
          label: body.label,
          provider,
          // 统一走 resolveModel：用户不填时给出一个确定的默认值，
          // 避免请求里出现空模型名（上游会返回 400，用户完全看不懂）
          model: resolveModel(provider, body.model),
          baseUrl: resolvedBaseUrl,
          apiKeyEncrypted: encryptSecret(body.apiKey),
          apiKeyHint: maskApiKey(body.apiKey),
          active: shouldActivate,
        },
        select: PUBLIC_FIELDS,
      });
    });

    invalidateCredentialCache(created.id);

    /*
     * 凭证变更是审计里最该有的一条：它决定「谁的额度在被用」。
     * meta 只记 provider / model / label —— 密钥本体绝不进审计
     * （recordAudit 里还有一层键名黑名单兜底）。
     */
    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'credential.create',
      targetType: 'credential',
      targetId: created.id,
      meta: { provider, model: created.model, label: created.label },
      context: auditContextFrom(req),
    });

    return ok(created, { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}

/** PATCH：更新凭证（改名称/模型/地址/密钥，或切换启用状态） */
export async function PATCH(req: Request) {
  try {
    const actor = await requireActor();
    const userId = actor.userId;
    if (credentialsDisabled()) {
      return fail('FORBIDDEN', '本站未开放「自带 API Key」功能', 403);
    }
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return fail('VALIDATION_ERROR', '缺少凭证 id', 422);

    const body = UpdateSchema.parse(await req.json());

    // ⚠️ findFirst + userId：绝不使用 update({ where: { id } })，
    // 那会让任何人拿到别人的凭证 id 就能改掉它
    const current = await prisma.apiCredential.findFirst({ where: { id, userId } });
    if (!current) return fail('NOT_FOUND', '凭证不存在', 404);

    const provider = (normalizeProvider(current.provider) ?? 'custom') as ProviderId;

    let baseUrl: string | null | undefined;
    if (body.baseUrl !== undefined) {
      if (!body.baseUrl) {
        baseUrl = null; // 清空 → 回到内置默认地址
      } else {
        const check = validateBaseUrl(body.baseUrl);
        if (!check.ok) {
          return fail('VALIDATION_ERROR', check.message ?? '接口地址不合法', 422, {
            baseUrl: check.message ?? '接口地址不合法',
          });
        }
        baseUrl = check.url!;
      }
    }

    // 换 key 时同时刷新密文与掩码。两者必须一起更新，
    // 否则掩码会指向旧 key，用户以为没换成功
    const keyPatch = body.apiKey
      ? { apiKeyEncrypted: encryptSecret(body.apiKey), apiKeyHint: maskApiKey(body.apiKey) }
      : {};

    const updated = await prisma.$transaction(async (tx) => {
      if (body.active === true) {
        await tx.apiCredential.updateMany({
          where: { userId, active: true, NOT: { id } },
          data: { active: false },
        });
      }

      return tx.apiCredential.update({
        where: { id },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.model !== undefined ? { model: resolveModel(provider, body.model) } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...keyPatch,
        },
        select: PUBLIC_FIELDS,
      });
    });

    // 配置变了，必须让缓存失效（缓存键是 id，内容却已经不同）
    invalidateCredentialCache(id);

    /*
     * 改 key 比删 key 更值得留痕：删了只是不能用了，改了可能是「把额度
     * 指到别人的通道」。meta 只记「改了哪些字段名」，不记值。
     */
    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'credential.update',
      targetType: 'credential',
      targetId: id,
      meta: { fields: Object.keys(body).sort(), model: updated.model },
      context: auditContextFrom(req),
    });

    return ok(updated);
  } catch (e) {
    return handleError(e);
  }
}

/** DELETE：删除凭证 */
export async function DELETE(req: Request) {
  try {
    const actor = await requireActor();
    const userId = actor.userId;
    if (credentialsDisabled()) {
      return fail('FORBIDDEN', '本站未开放「自带 API Key」功能', 403);
    }
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return fail('VALIDATION_ERROR', '缺少凭证 id', 422);

    // deleteMany 天然带条件且不会因找不到而抛错：越权时返回 404 而不是 500
    const result = await prisma.apiCredential.deleteMany({ where: { id, userId } });
    if (result.count === 0) return fail('NOT_FOUND', '凭证不存在', 404);

    invalidateCredentialCache(id);

    await recordAudit({
      userId: actor.userId,
      actorEmail: actor.email,
      action: 'credential.delete',
      targetType: 'credential',
      targetId: id,
      // 只记 id，不记被删凭证的 provider/model —— 删除后这些值已不可查，
      // 想追溯「删的是哪条」可以对着更早的 credential.create 记录看
      context: auditContextFrom(req),
    });

    return ok({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
