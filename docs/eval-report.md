# Lumenote 评测与可观测性报告

> ⚠️ **MOCK 模式**：本报告由 `pnpm eval:report` 生成，**未调用任何真实模型、未产生 API 费用**。
> 报告中的通过率 / 延迟 / 成本只用于验证**流程、断言与计价口径**，**不代表真实模型质量**。
> 真实模型评测：**未运行**（无可用 API Key，且明确避免产生费用）。

- 生成时间：2026-10-20 22:45:43 (UTC+8)
- git commit：`559e2a6`
- 被测对象：`mock:deepseek-flash`（MockProvider，未联网）
- 数据集：文档问答基线（eval:report mock）（4 条用例，内容指纹 `4642-481bc636`）
- 命令：`pnpm eval:report`（幂等：数据集/用例 upsert、报告任务恒定一条、评测运行历史 append-only）

## 1. 环境与版本

| 项目 | 值 |
| --- | --- |
| 运行模式 | mock（MOCK_LLM=true） |
| 被测模型 | mock:deepseek-flash |
| 计价参考模型 | deepseek-flash（pricing.ts 单价表） |
| Node / 包管理器 | v22.15.0 / pnpm@10.33.2 |
| git commit | `559e2a6` |
| 演示用户 | demo@lumenote.dev |
| 摘要 Prompt 版本 | `cmv4td1fs0001uczmh0lmxk8z`（v1，模板 `cmv4td1fl0000uczmqm84e4uc`） |
| Agent Prompt 版本 | `cmvay7i3o0004ogzmmbuvq8we`（v1，模板 `cmvay7i3e0003ogzmumna15fy`） |
| 数据集 | 文档问答基线（eval:report mock）（id `cmvgremjd000090zmhkb3qmxu`，指纹 `4642-481bc636`） |
| trace 目录 | `.lumenote-data/traces`（仅报告脚本；应用默认写系统临时目录） |
| 数据库规模（采集时） | Task 109 / UsageLog 152 / AgentStep 26 / EvalRun 11 |

Prompt 模板版本与数据集均从**真实数据库**读取；数据集表没有 version 字段，因此用「用例内容指纹」作为可比较的版本标识。

## 2. 规则断言通过率（MOCK 驱动）

⚠️ MockProvider 的输出是一段**固定占位摘要**（不调用模型）。因此要求「包含 50 倍 / 输出 JSON / 使用 search_chunks」的规则断言**必然失败** ——
这不是模型质量问题，恰恰证明断言会拒绝“不是答案的输出”。真实模型下的通过率需在有 Key 的环境重跑，本轮未运行。

- 评测运行 id：`cmvgspmb60001zozmn44u97z9`
- 规则断言结果：**0/4 用例通过**（加权通过率 0.00%）
- judge：**未运行**（`enableJudge=false`；无 API Key / 避免费用），本轮跳过 1 条 judge 断言

| 用例 | 权重 | 状态 | 通过断言 | 得分 | 耗时 | 失败原因（摘要） |
| --- | --- | --- | --- | --- | --- | --- |
| 基础数值提取 | 2 | failed | 3/9（跳过 0） | 0.33 | 9ms | contains: 未包含「50」；contains: 未包含「2%」；agent_tool_used: 没有使用工具 search_chunks（实际用到：无）；agent_evidence_rate: 证据链完整率 0% < 80%；must_be_json: 未能从输出中提取出合法 JSON；json_path_exists: 输出不是可解析的 JSON 对象，无法检查路径 |
| 防编造：文档中不存在的信息 | 3 | failed | 3/5（跳过 0） | 0.60 | 3ms | regex: 未匹配 /没有\|未找到\|不存在\|未提及\|无法\|未能\|不含\|未包含/；must_be_json: 未能从输出中提取出合法 JSON |
| 方法归纳：如何提高命中率 | 2 | failed | 2/6（跳过 1） | 0.33 | 2ms | contains: 未包含「前置」；regex: 未匹配 /日期\|随机\|用户名\|id/；agent_evidence_rate: 证据链完整率 0% < 80%；must_be_json: 未能从输出中提取出合法 JSON |
| 跨段落归纳：成本优化的优先级 | 2 | failed | 2/6（跳过 0） | 0.33 | 2ms | contains: 未包含「缓存」；regex: 未匹配 /峰谷\|2 倍\|两倍/；agent_evidence_rate: 证据链完整率 0% < 80%；must_be_json: 未能从输出中提取出合法 JSON |

> 说明：judge 断言被标记为 **skipped（未评估）** 而不是 failed —— 没运行不等于模型没通过，两者混在一起会产生假回归。

### 与基线的对比（仅演示回归报告机制，不做质量结论）

- 基线运行：`cmvgs812c000194zma23chm2y`（2026-10-20T14:32:05.220Z）
- 结论：**NEUTRAL** —— 没有明显变化：通过率保持 0%，4 个用例输出逐字节相同。
- 通过率：0.0% → 0.0%（加权 0.0% → 0.0%）
- 平均得分：0.400 → 0.400

> 基线是同一「mock 专用数据集」的上一次运行（同样为 mock）。mock 与真实模型运行不可比，
> 这里的对比只用于证明回归报告链路（基线选择/差异分组/结论生成）可用。

## 3. 延迟与成本（MOCK 实测 / 按 token 估算）

延迟是**本轮真实测量的墙钟时间**（MockProvider 有模拟延时，因此不是零）；成本是 `pricing.ts` 计价逻辑的**估算值**。

| 指标 | 值 |
| --- | --- |
| 生成样本数 | 4 |
| p50 延迟 | 2.5ms |
| p95 延迟 | 8.1ms |
| 平均延迟 | 4ms |
| token 估算总成本 | $0.000724 ≈ ¥0.0052 |

| 用例 | 输入 token（估） | 输出 token（估） | 成本（估，USD） |
| --- | --- | --- | --- |
| 基础数值提取 | 582 | 156 | $0.000181 |
| 防编造：文档中不存在的信息 | 582 | 156 | $0.000181 |
| 方法归纳：如何提高命中率 | 582 | 156 | $0.000181 |
| 跨段落归纳：成本优化的优先级 | 582 | 156 | $0.000181 |

> 按 pricing.ts 的单价 × 峰谷 × 缓存分档估算；MockProvider 的 token 由估算器产生，**不代表真实成本**。真实 API 费用为 **0**（未发起调用）。样本量 4 条，p95 仅用于展示口径，不具备统计意义。

## 4. 指标聚合（真实数据库查询）

- 时间窗口：**最近 30 天（2026-09-20 14:45:43Z → 2026-10-20 14:45:43Z）**
- 每个指标均在表中标注数据来源与口径；数字全部来自对本地数据库的真实查询，不是写死的常量。

### 4.1 端到端延迟（Task）

| 维度 | 样本数 | p50 | p95 | 平均 | 最小 | 最大 |
| --- | --- | --- | --- | --- | --- | --- |
| 全部成功任务 | 109 | 1262ms | 6057.8ms | 1990.94ms | 93ms | 6787ms |
| type=summarize | 86 | 1163.5ms | 6063.25ms | 1727.87ms | 439ms | 6787ms |
| type=translate | 4 | 1237.5ms | 1308.75ms | 1237ms | 1156ms | 1317ms |
| type=write | 4 | 728ms | 827.75ms | 722.25ms | 591ms | 842ms |
| type=agent | 15 | 4165ms | 5230.8ms | 4038.6ms | 93ms | 6012ms |

> 来源：Task.latencyMs（为空时用 completedAt - createdAt 兜底）；口径：端到端耗时：Task.latencyMs，缺失时用 completedAt - createdAt；只统计 succeeded 且已完成的普通任务。

### 4.2 LLM 调用次数（两个口径，不要混用）

| 指标 | 值 | 数据来源 | 口径 |
| --- | --- | --- | --- |
| 任务级计量记录数 | 152 | UsageLog 行数（任务级结算记录，taskId 唯一） | UsageLog 一行 = 一次任务级计量结算：摘要任务 Map 阶段的多次调用合并进 meta，Agent 的多轮调用合并为一条，因此它 < 实际 generate 次数 |
| Agent 模型调用次数 | 26 | AgentStep 行数（每行对应一次模型 generate 调用） | AgentStep 一行 = 一次模型调用（plan/act/finalize/give_up 各对应一次 generate），因此它是 Agent 实际模型调用次数的准确口径 |
| 其中失败计量记录 | 6 | UsageLog 行数（任务级结算记录，taskId 唯一） | success=false 的行数 |

### 4.3 token 与成本（按模型）

| 模型 | 记录数 | 输入 token | 输出 token | 缓存命中 token | 成本（USD） | 成本（CNY 展示） |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash | 146 | 142282 | 26459 | 0 | $0.043017 | ¥0.3097 |
| dead-endpoint-model | 6 | 0 | 0 | 0 | $0.000000 | ¥0.0000 |
| **合计** | 152 | 142282 | 26459 | 0 | $0.043017 | ¥0.3097 |

> 来源：UsageLog.promptTokens / completionTokens / cachedTokens / UsageLog.estimatedCost（单位：美元；展示时按 7.2 换算人民币）；口径：按 UsageLog 累计：promptTokens（含缓存命中）/ completionTokens / cachedTokens。
> ⚠️ `UsageLog.estimatedCost` 在代码中存的是**美元**（见 `src/lib/llm/metering.ts`），与 schema 注释「人民币元」不一致；本报告以代码为准，并在展示层按 7.2 换算人民币。
> 缓存命中率：0.0%（cachedTokens / promptTokens）。

### 4.4 工具调用次数与失败率

| 指标 | 值 |
| --- | --- |
| 工具调用总数 | 19 |
| 实际执行数 | 19 |
| 执行失败数 | 0 |
| 执行失败率 | 0.00% |
| 被 Agent 护栏拦截（额度/重复/未知工具） | 0（**不计入失败率**） |

| 工具 | 调用次数 | 失败次数 |
| --- | --- | --- |
| list_sections | 12 | 0 |
| search_chunks | 7 | 0 |

> 来源：AgentStep.toolResults（JSON 数组）；口径：工具失败率 = executionFailures / executedCalls；护栏拒绝（额度/重复/未知工具）不计入失败率。

### 4.5 证据完整率（结构口径）

| 指标 | 值 |
| --- | --- |
| 有结构化输出的 Agent 任务 | 14 |
| 无结构化输出的 Agent 任务 | 1 |
| 结论总数 / 其中带证据 | 57 / 57 |
| 证据条目总数 | 67 |
| 无依据结论数 | 0 |
| 结构化证据覆盖率 | 100.00% |

> 来源：Task.outputMeta.structured（Agent 结论与证据引用）；口径：结构化证据覆盖率 = 带 ≥1 条证据的结论数 / 结论总数；不含「引文能否在原文中找到」的严格校验。
> 更严格的「引文能否在原文中找到」由 `checkEvidence()` 在运行时校验，DB 未保存分块全文，无法离线重算。

### 4.6 任务失败率与超时率

| 指标 | 值 |
| --- | --- |
| 窗口内任务总数 | 109 |
| succeeded / failed / canceled | 109 / 0 / 0 |
| 仍在 running/queued | 0 |
| 显式超时（errorCode=TIMEOUT） | 0 |
| 卡死超阈值（running/queued 超过 15 分钟） | 0 |
| 失败率 | 0.00% |
| 超时率 | 0.00% |

> 来源：Task.status / errorCode / createdAt；口径：超时率 = (errorCode=TIMEOUT + running/queued 超过 15 分钟) / 窗口内任务总数。
> 两个超时口径缺一不可：只看 errorCode 会漏掉「进程崩溃导致任务永远 running」；只看状态会把正常执行中的任务误判为超时。
> ⚠️ 本地 seed 数据的任务全部为 succeeded，因此本窗口的失败率/超时率为 0；这两个指标的判定逻辑由单测覆盖（含构造的 running 超阈值 / 显式 TIMEOUT 场景）。
> 状态分布：succeeded=109；错误码分布：（无）

## 5. 失败样本回归集（断言自检）

为了证明断言**有区分力**，构造 8 条「故意有缺陷的输出 + 对应断言」；另加 2 条良样本做对照（断言不应误伤）。
- 缺陷检测率：**8/8**
- 对照组通过：**2/2**

| 样本 | 缺陷类型 | 期望 | 断言结果 | 检测到？ | 失败断言 / 说明 |
| --- | --- | --- | --- | --- | --- |
| 数值幻觉：把 50 倍 / 2% 编成 250 倍 / 25% | 事实数字错误 | 检测到缺陷 | 2/3 通过（得分 0.67） | ✅ 是 | contains: 未包含「2%」 |
| 编造文档中不存在的信息（量子退火算法） | 事实编造 | 检测到缺陷 | 0/3 通过（得分 0.00） | ✅ 是 | regex: 未匹配 /没有\|未找到\|不存在\|未提及\|无法\|未能\|不含\|未包含/；not_contains: 出现了不应存在的「量子比特」；not_contains: 出现了不应存在的「退火温度」 |
| 输出不是结构化 JSON（只有散文） | 结构缺失 | 检测到缺陷 | 0/2 通过（得分 0.00） | ✅ 是 | must_be_json: 未能从输出中提取出合法 JSON；json_path_exists: 输出不是可解析的 JSON 对象，无法检查路径 |
| 结论没有任何证据引用 | 证据链断裂 | 检测到缺陷 | 0/2 通过（得分 0.00） | ✅ 是 | agent_no_unsupported: 有 1 条结论没有引用原文；agent_evidence_rate: 证据链完整率 0% < 80% |
| 完全没检索就凭训练知识作答 | 未使用文档（脱离材料） | 检测到缺陷 | 0/1 通过（得分 0.00） | ✅ 是 | agent_tool_used: 没有使用工具 search_chunks（实际用到：无） |
| 用相同参数反复检索（死循环） | Agent 空转烧钱 | 检测到缺陷 | 0/1 通过（得分 0.00） | ✅ 是 | agent_no_loop: 检测到重复调用（死循环） |
| 步数超出预算 | 预算失控 | 检测到缺陷 | 0/1 通过（得分 0.00） | ✅ 是 | agent_max_steps: 步数 15 > 8 |
| 答案过短，缺少关键方法 | 信息量不足 | 检测到缺陷 | 0/2 通过（得分 0.00） | ✅ 是 | min_length: 长度 14 < 80；contains: 未包含「前置」 |
| 对照：合法结构化答案（含证据引用） | （无缺陷，对照组） | 应通过 | 10/10 通过（得分 1.00） | ✅ 否 | 全部断言通过 |
| 对照：正确的「文档中没有该信息」回答 | （无缺陷，对照组） | 应通过 | 5/5 通过（得分 1.00） | ✅ 否 | 全部断言通过 |

> 这些样本只在报告脚本里评测，不写入 `EvalCase` 表（避免污染真实评测用例）。

## 6. Trace 证据（taskId 贯穿）

tracing 由 `src/instrumentation.ts` 在应用启动时初始化；本报告脚本同样初始化 jsonl exporter，把 span 写到：
`.lumenote-data/traces/<UTC 日期>.jsonl`（每行一个 span，已 gitignore）。

> ⚠️ **这里与应用的默认值不同，是有意的**。
> 应用的默认 `TRACE_DIR` 在**系统临时目录**（`<tmp>/lumenote-traces`），因为 dev server
> 的 watcher 会监听项目目录：trace 一旦写进项目内，每写一行就触发一次热重载，
> 而页面刷新又产生新 span，形成「刷新 → 写 trace → 热重载 → 再刷新」的死循环。
> 本脚本是**一次性 CLI**，不跑 watcher，且报告需要可复现的落盘证据，
> 所以它显式把 `TRACE_DIR` 指向项目内的 `.lumenote-data/traces`。
> 如果你在 dev server 运行时手动执行本脚本，那批写入**仍可能**触发一次热重载 ——
> 属预期行为，不是 bug；跑完 dev 请自行重启或忽略那一次编译。

所有 span 都带 `taskId` 属性，同一任务的所有 span 共享同一 `traceId`；
因此可以直接 `grep '"taskId":"<任务 id>"' .lumenote-data/traces/*.jsonl` 检索一次任务的完整链路。

### 6.1 一次真实 mock 摘要任务（Map-Reduce 链路）

- taskId：`cmvgspmd80006zozmmyi8jriy`
- traceId：`53067748e0e873877da1279c39ad0b49`
- span 数：7；根 span 耗时：3045.0ms
- span 分布：task.lifecycle=1, llm.request=4, task.persist=1, task.pipeline=1
- 任务状态=succeeded，DB latencyMs=3027，流水线墙钟耗时=3045ms；同一 taskId 在 JSONL 中匹配到 1 条 trace（展示最新一条）。

```text
task.pipeline [taskId=cmvgspmd80006zozmmyi8jriy, type=summarize, model=deepseek-flash, chunkCount=3] 3045.0ms (traceId=53067748e0e873877da1279c39ad0b49)
├─ task.lifecycle [taskId=cmvgspmd80006zozmmyi8jriy, type=summarize, model=deepseek-flash, chunkCount=3] 30.0ms
├─ llm.request [taskId=cmvgspmd80006zozmmyi8jriy, phase=map, model=deepseek-flash, provider=mock, inputTokens=1645, outputTokens=251, attempt=1, chunkIndex=0, degraded=false] 1501.0ms
├─ llm.request [taskId=cmvgspmd80006zozmmyi8jriy, phase=map, model=deepseek-flash, provider=mock, inputTokens=1692, outputTokens=243, attempt=1, chunkIndex=1, degraded=false] 1500.6ms
├─ llm.request [taskId=cmvgspmd80006zozmmyi8jriy, phase=map, model=deepseek-flash, provider=mock, inputTokens=1663, outputTokens=250, attempt=1, chunkIndex=2, degraded=false] 1500.9ms
├─ llm.request [taskId=cmvgspmd80006zozmmyi8jriy, phase=reduce, model=deepseek-flash, provider=mock, inputTokens=1268, outputTokens=218, attempt=1, degraded=false] 1478.2ms
└─ task.persist [taskId=cmvgspmd80006zozmmyi8jriy, degraded=false, status=succeeded] 14.5ms
```

| span | 父 span | 耗时 | 关键属性 |
| --- | --- | --- | --- |
| task.pipeline | —（根） | 3045.0ms | taskId=cmvgspmd80006zozmmyi8jriy, type=summarize, model=deepseek-flash, chunkCount=3 |
| task.lifecycle | task.pipeline | 30.0ms | taskId=cmvgspmd80006zozmmyi8jriy, type=summarize, model=deepseek-flash, chunkCount=3 |
| llm.request | task.pipeline | 1501.0ms | taskId=cmvgspmd80006zozmmyi8jriy, phase=map, model=deepseek-flash, provider=mock, inputTokens=1645, outputTokens=251, attempt=1, chunkIndex=0 |
| llm.request | task.pipeline | 1500.6ms | taskId=cmvgspmd80006zozmmyi8jriy, phase=map, model=deepseek-flash, provider=mock, inputTokens=1692, outputTokens=243, attempt=1, chunkIndex=1 |
| llm.request | task.pipeline | 1500.9ms | taskId=cmvgspmd80006zozmmyi8jriy, phase=map, model=deepseek-flash, provider=mock, inputTokens=1663, outputTokens=250, attempt=1, chunkIndex=2 |
| llm.request | task.pipeline | 1478.2ms | taskId=cmvgspmd80006zozmmyi8jriy, phase=reduce, model=deepseek-flash, provider=mock, inputTokens=1268, outputTokens=218, attempt=1 |
| task.persist | task.pipeline | 14.5ms | taskId=cmvgspmd80006zozmmyi8jriy, status=succeeded |

### 6.2 Agent 完整链路（脚本化 Provider，仅验证 span 结构）

- taskId：`eval-report-scripted-agent`
- traceId：`dd2942176ca84ecbe8fa74b2d79266a7`
- span 数：9；根 span 耗时：5.1ms
- span 分布：llm.request=2, agent.plan=2, agent.tool=1, agent.observe=1, agent.evidence_check=1, agent.finalize=1, task.pipeline=1
- 脚本化 Provider（固定剧本，仅验证 trace 结构）：status=succeeded，steps=2，证据链完整率=1；墙钟耗时=5ms。同一 taskId 匹配到 2 条 trace（展示最新一条）。⚠️ 该链路不代表真实模型质量。

```text
task.pipeline [taskId=eval-report-scripted-agent, type=agent, model=deepseek-flash] 5.1ms
├─ agent.plan [taskId=eval-report-scripted-agent, inputTokens=420, outputTokens=12, step=1] 0.7ms
│  └─ llm.request [taskId=eval-report-scripted-agent, phase=agent, model=deepseek-flash, provider=scripted-mock, inputTokens=420, outputTokens=12, attempt=1, step=1] 0.2ms
├─ agent.tool [taskId=eval-report-scripted-agent, toolName=search_chunks, ok=true] 0.5ms
├─ agent.observe [taskId=eval-report-scripted-agent, step=1] 0.0ms
├─ agent.plan [taskId=eval-report-scripted-agent, inputTokens=760, outputTokens=140, step=2] 0.5ms
│  └─ llm.request [taskId=eval-report-scripted-agent, phase=agent, model=deepseek-flash, provider=scripted-mock, inputTokens=760, outputTokens=140, attempt=1, step=2] 0.1ms
└─ agent.finalize [taskId=eval-report-scripted-agent, inputTokens=1180, outputTokens=152, degraded=false, status=succeeded, stopReason=model_finalized] 0.6ms
   └─ agent.evidence_check [taskId=eval-report-scripted-agent, rate=1, unsupported=0] 0.0ms
```

**脱敏策略**：span 不记录 API Key、完整 prompt / 文档正文或模型输出正文；
只记录长度与哈希（如 `toolArgsHash` / `toolArgsLength`）、token 数、耗时、状态码。
导出前还有两层防御：属性键黑名单（`apiKey` / `prompt` / `content` 等 → `[redacted]` / `[omitted]`）、
值级兜底（`sk-...` / `Bearer ...` → `[redacted]`）与 200 字符截断。实现见 `src/lib/observability/sanitize.ts`。

**接入点**（最小侵入，只加 span，不改业务逻辑）：
`src/instrumentation.ts`（初始化）、`src/lib/pipeline/runner.ts`（task.pipeline / task.persist）、
`src/lib/pipeline/lifecycle.ts`（task.lifecycle）、`src/lib/pipeline/map-reduce.ts`（llm.request map/reduce）、
`src/lib/agent/orchestrator.ts`（agent.plan / agent.observe / agent.finalize / agent.evidence_check + llm.request）、
`src/lib/agent/tool-dispatch.ts`（agent.tool）、`src/lib/agent/runner.ts`（Agent 任务根 span task.pipeline + task.persist）。

## 7. 已知限制与未运行项

- **真实模型评测未运行**：环境无可用 API Key，且明确避免产生费用。报告中的通过率/延迟/成本均为 MOCK 口径，不能当作模型效果结论。
- **judge 未运行**：`enableJudge=false`，judge 断言全部标记为 skipped；LLM-as-judge 的一致性校准（人工标注）也未在本轮执行。
- **成本为估算**：MockProvider 的 token 由估算器产生，成本按 `pricing.ts` 单价的逻辑计算，不代表真实账单；真实费用为 0。
- **延迟样本很小**：本轮只有 4 条 mock 用例；p95 仅用于展示统计口径。真实延迟请参考第 4.1 节的 DB 历史数据（窗口见上）。
- **指标包含历史 mock / seed 数据**：本地数据库中的 Task / UsageLog 含 seed 与历史 mock 运行记录，成本与调用次数不代表生产流量。
- **UsageLog.estimatedCost 单位**：代码中存美元（`src/lib/llm/metering.ts`），schema 注释写「人民币元」是陈旧注释；已在报告中按代码为准处理，建议后续修正注释。
- **OTLP 导出未验证**：本环境没有 OTel Collector，`TRACE_EXPORT=otlp` 仅做了「缺 endpoint 时降级 jsonl」的配置单测，端到端未验证。
- **Agent 根 span 接入**：`src/lib/agent/runner.ts` 不在原定 tracing 文件清单内，经 Lead 批准后做了 ≤20 行的纯 tracing 接入（根 span + task.persist），不改变任何业务逻辑。
- **同文件范围顺带修复的 bug**：`src/lib/eval/runner.ts` 的成本超限错误原本用 `Object.assign(new Error(...), { code, statusCode })` 构造，而路由层用 `instanceof LLMError` 判断 → 会落到 500。已改为 `new LLMError(msg, "EVAL_COST_EXCEEDED", false, 422)`，并新增单测锁定「可被 `classifyError` 正确分类」。

## 附：如何复现

```bash
# 前提：本地 PostgreSQL 16 已启动、数据库已 seed（脚本会自检并给出明确报错）
pnpm prisma:seed          # 幂等；演示用户 / 模板 / 用例 / 演示任务
MOCK_LLM=true pnpm eval:report   # 生成 docs/eval-report.md 与 .eval-results/report.json
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

> 报告由脚本覆盖式生成；`.eval-results/` 与 `.lumenote-data/traces/*.jsonl` 已在 `.gitignore` 中，不会入库。

<!-- report-fingerprint: 4642-481bc636-4642-481bc636-559e2a6 -->

