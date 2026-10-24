# 05 · 批次与审计：批量处理与合规留痕

> 目标：能回答"批量怎么控成本""为什么必须串行""审计为什么改不了"。

---

## 1. 批次状态机：**终态是反推出来的，不是过程中累加的**

```ts
// batch/runner.ts:177-189
if (forced) status = 'canceled';                                  // 取消优先
else if (succeeded > 0 && failed === 0 && skipped === 0) status = 'succeeded';
else if (succeeded === 0 && failed === 0) status = 'canceled';    // 一条没跑也没失败 = 全跳过
else if (succeeded === 0) status = 'failed';
else status = 'partial';
```

`finalize()` 用 `groupBy(status)` 数出来，`skipped = canceled + queued`。

**为什么要反推而不是边跑边累加？**
累加会出三类错误：① 取消时"有几条成功了"会被报成 partial，掩盖真实原因；
② 一条都没跑成（预算一开始就不够）会被报成 partial；③ 执行器崩溃时计数与实际任务状态不一致。
反推的真相来源永远是**子任务的实际状态**。

**防重入**：`runBatch` 只接受 `queued|running`（`after()` 重试可能调两次）；
取消接口对终态返回 409 `ALREADY_FINISHED`。

---

## 2. 为什么串行（面试常问"为什么不做并发"）

| 理由 | 说明 |
|---|---|
| **预算闸门会失效** | 10 条同时发出去时"还剩多少钱"来不及判断，只能事后发现超支 |
| 与既有约束一致 | 项目本来就有"同一用户同时 1 个进行中任务" |
| 场景不追求吞吐 | 内部流水线是"下班交 20 份、明早看结果"，**可预测的花费**比速度重要 |

代价：20 份 × 几十秒 = 十几分钟。**正确的提速方向是"分片 + 每片独立预算"，不是简单加并发。**

创建阶段也是串行 `await`：URL 条目会触发抓取，并发抓 20 个外部站点既不礼貌也容易触发对端限流。

---

## 3. 预算闸门与"软上限"

```ts
// batch/guard.ts:44-65
if (budgetCny == null || budgetCny <= 0) return continue;     // 未设预算 = 明确不限制
if (spentCny >= budgetCny) return stop('预算已用尽');
if (nextEstimateCny > budgetCny - spentCny) return stop('下一条预计超出剩余');
return continue;
```

**判定在发请求之前**，不是跑完再算。

| 概念 | 值 |
|---|---|
| 已花 | `usdToCny(batch.costUsd)`，**真实值**从 `UsageLog` 累加 |
| 预估 | 输入 token 取 `inputMeta.tokenCount`；输出 `pointCount>0 ? max(200, points*60) : 800` |

**软上限的含义**：闸门用预估值，真实值跑完才知道。实测：预算 ¥0.0025，跑完第 2 条实际花了 ¥0.0029，
第 3 条被拦下。最坏情况是"超出最后一条的偏差"，**不会级联超支**。
要变硬上限只能"每条跑完再校验 + 预留 20% 余量"，但会把可用预算越压越少 ——
所以选择**诚实标注**而不是假装精确。

**记账用真实值**：`accumulateCost()` 从 `UsageLog.estimatedCost` 读后 `increment`。
预估值只用于"跑之前要不要跑"。

---

## 4. 三类"没跑"必须分开（这是批次最核心的设计）

| 分类 | 落库形态 | 是否花钱 | 计入失败率 |
|---|---|---|---|
| `failed` | `Task.status='failed'` + 模型错误码 | 花了 | 是 |
| `skipped` | `Task.status='canceled'` + `errorCode='SKIPPED_BUDGET'` / `'CANCELED'` | **没花** | 否 |
| `queued` | 还没轮到（finalize 兜底并入 skipped） | 没花 | 否 |
| 创建即失败 | `createFailedTaskRecord` 落 `failed`，**不写 UsageLog、不占配额** | 没花 | 是 |

**为什么不能把 skipped 算进 failed？**
失败率会失真，用户会去排查根本不存在的模型问题。

**为什么"创建即失败"也要落一条记录？**
否则详情页"共 5 份只有 4 行"，用户会以为系统丢数据。

---

## 5. 输入解析（`batch/parse.ts`）

- 一个文本框，多份之间用**独占一行的 `---`** 分隔（兼容 `———`/`===`）
- 整块是一个 URL → 按链接抓取
- 首行 `# 标题` → 作为展示名，不进正文
- 上限：**20 份 / 单份 6 万字 / 合计 20 万字**
- 超限时**报具体是第几份**，不是静默截断

**为什么不做文件上传？** PDF/DOCX 解析是另一个量级的工作；内部材料常常是从邮件/IM/Word 复制的文本，粘贴比找文件快。

---

## 6. 审计：不可篡改是**数据层契约**

| 设计 | SQL 事实 | 目的 |
|---|---|---|
| `userId` 可空 + `ON DELETE SET NULL` | migration | 删账号时操作记录**不能消失**；离职账号做过什么正是最先要查的 |
| `actorEmail NOT NULL` | 快照 | 人都不在了也要说清是谁 |
| **无 `updatedAt` / `deletedAt`** | 只有 `createdAt` | 数据层不给软删字段，应用层也不提供改删接口 |
| `audit.export` 也留痕 | — | 只记"谁看了业务"却不记"谁把记录拷走"是自相矛盾 |

**写入永不抛异常**（`recordAudit` 吞错只打 error）。这是**权衡不是无懈可击**：
合规级要求"写失败即拒绝业务"（两阶段提交），本项目选可用性优先，并写进已知限制。

**彻底不可篡改需要部署侧**：独立数据库账号只授 `INSERT`，或写入 WORM 存储。

### meta 脱敏（导出会给外部审计方，密钥不能跟着出去）

```ts
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|verif(y|ication)[-_]?code)/i;
```

递归剔除 + 字符串截断 200 + 数组只留标量最多 20 + 深度 >4 丢弃 + 空对象归一为 null。
局限：**拦不住起错名的字段**，调用方仍需自觉。

### 可见性

`auditor` 看全员，其他人强制 `{userId}` —— 条件在 SQL 层，不由前端决定。
分页用 `createdAt < before` 的 keyset。导出上限 5000 条（全量归档走数据库备份，不走 HTTP）。

---

## 7. 导出：两个真实 bug 的教训

**① 中文文件名不能直接进 HTTP 头**

```
TypeError: Cannot convert argument to a ByteString (character 25209「批」)
```

HTTP 头只能是 ByteString（≤0xFF）。中文批次名拼进 `filename="批次.csv"`，
在 `new Response()` 那一刻抛错 → 用户看到 500。而这个产品的主要用户是中文用户，
等于**导出功能默认坏**。

修法：`contentDisposition()` = ASCII 兜底名 + RFC 5987 的 `filename*=UTF-8''…`。
`asciiFilename` 把非 ASCII 换 `_`、清理引号反斜杠、压缩连续下划线、全下划线回落 `download`。

**② 审计必须先构造 Response 再记账**

原来是"先记账再构造"，于是那次 500 在审计里留下了 `batch.export success`。
**记录与事实相反，比缺一条记录更糟。**

CSV 还要加 `\uFEFF` BOM，否则 Excel 打开中文乱码。

---

## 8. 动手练习

1. **验证预算闸门**：设 `budgetCny` 为只够一条，观察第 2 条起变 `canceled + SKIPPED_BUDGET`。
2. **验证软上限**：对比 `batch.costUsd` 与实际 `UsageLog` 之和。
3. **验证终态反推**：手工把某条任务的 status 改成 `canceled`，重跑 finalize 看批次状态变化。
4. **验证导出**：用中文批次名导出，检查响应头两个 filename 字段。

---

## 9. 面试问答

**Q：批量处理怎么控成本？**
> 三层：① 创建时整批预检额度（不够就整批拒绝，不跑到一半停）；
> ② 执行时每条发请求前用预估成本判断够不够，不够就把剩余标 `SKIPPED_BUDGET`（不发请求不花钱）；
> ③ 记账用 `UsageLog` 的真实值累加。预算是软上限——预估与实际有偏差，最坏是最后一条超一点。

**Q：为什么批次要串行？并发不是更快吗？**
> 因为预算是"花到上限就停"，并发时闸门在起跑瞬间就失效了。而且项目本来就有
> 单用户并发 1 的约束。提速的正确做法是分片 + 每片独立预算，不是加并发。

**Q：审计日志怎么保证不被篡改？**
> 数据层：`userId` 用 SET NULL 保留 `actorEmail` 快照；没有 `updatedAt`/`deletedAt`；
> 应用层不提供任何改删接口。但严格说只能做到"应用层不改"——有 DB 写权限的人还能改行，
> 彻底方案是独立账号只授 INSERT 或 WORM。写入失败是吞异常的，这也是已知权衡。

**Q：为什么"跳过"和"失败"要分开？**
> 因为跳过**没花钱**、失败**花了钱**。混在一起会让失败率失真，
> 用户会拿失败率去排查模型问题，而实际上只是预算不够。
