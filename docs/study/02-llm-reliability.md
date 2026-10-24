# 02 · LLM 调用层：重试、熔断、降级、计费

> 目标：能准确回答"模型挂了会怎样""为什么这么重试""钱是怎么算出来的"。

---

## 1. 一句话版本

`streamWithFallback` 是一个"**一定会给你结果**"的函数：
单档内重试 3 次 → 换模型 → 全挂则**本地规则生成摘要**并标 `degraded=true`。

```
map-reduce.ts:140  streamWithFallback({request, userProvider, signal, onText})
  │
  ├─ sanitizeRequest          按模型能力裁掉 jsonMode/thinking/reasoningEffort
  ├─ buildFallbackChain       造 1~4 档候选
  │
  └─ for each attempt:
       ├─ getBreaker(`${provider}:${model}`).canRequest()   // 熔断就跳过这一档
       ├─ withRetry(fn, 3 次, 全抖动退避)
       │    └─ fn: 清空累积量 → provider.stream() → 消费事件（TTFT/onText/usage）
       ├─ recordSuccess / recordFailure
       └─ 空响应 → EMPTY_RESPONSE
  │
  └─ 全失败 → heuristicSummary() → degraded:true, usage 全 0
```

---

## 2. 候选链怎么造（`llm/registry.ts:137-177`）

优先级：**BYOK > MOCK_LLM > 站点链**

| 场景 | 链 |
|---|---|
| 用户自带 Key | **只有一条** `byok:<provider>/<model>`，绝不回落站点通道 |
| `MOCK_LLM=true` | 一条 `mock` |
| 站点默认 | `deepseek/$DEFAULT_MODEL` → 同厂 `$FALLBACK_MODEL` → `openai/gpt-4o-mini` |

**为什么 BYOK 不回落？**
用户填自己的 key 是因为"不想让站点付钱 / 想用指定模型"。偷偷用站点 key 重试，
既违背意图，也会让站点成本失控。所以失败时明确告诉用户"不会自动改用站点内置通道"
（`service.ts:220-225` 的两套 `degradedReason` 文案就是这么来的）。

**能力裁剪**（`registry.ts:186-214`）：`jsonMode` 不支持就置空、`thinking` 不支持改成 disabled、
`reasoningEffort` 在 thinking 关闭时无意义就置空。每次换档都要**重新裁剪**
（`service.ts:188-191`）—— 因为不同模型的 capabilities 不同。

---

## 3. 熔断器（`llm/breaker.ts`）

### 状态机

```
CLOSED ──连续失败≥5 或 (总请求≥10 且 错误率≥50%)──▶ OPEN(冷却 30s)
OPEN   ──冷却到期（读状态时惰性判断）──▶ HALF_OPEN
HALF_OPEN ──只放行 1 个探针（halfOpenInFlight 锁）──▶ 成功=继续保持；失败=OPEN(冷却 60s)
```

| 参数 | 值 |
|---|---|
| `failureThreshold` | 5 |
| `cooldownMs` | 30s（探针失败翻倍 60s） |
| `windowMs` / `errorRateThreshold` / `minRequestsForRate` | 60s / 0.5 / 10 |

### 三个必须知道的实现细节

**① 粒度是 `provider:model`，不是 provider**

```ts
// service.ts:87
const breaker = getBreaker(`${attempt.provider.name}:${attempt.model}`);
```

注释记录了真实 bug：只按 provider 记时，`deepseek-flash` 熔断会让 `deepseek-v4-pro`
在发请求前就被跳过 —— "降级链看起来四层，实际只有三层"。

**② `recordSuccess()` 不会把状态打回 `CLOSED`**

```ts
// breaker.ts:101-104
recordSuccess() { this.state.failureCount = 0; }   // 只清零计数
```

于是探针成功后状态停留在 `HALF_OPEN`，此后每个请求都走"单探针串行放行"。
**这是个实现缺口**（只有 `reset()` 能回 CLOSED），面试可以主动承认：
"设计意图是 HALF_OPEN → CLOSED，但 recordSuccess 没写状态回迁，退化成单探针串行"。

**③ 开闸时清空滑动窗口**（`trip()`）
否则旧数据会立刻让 HALF_OPEN 再次熔断，永远探不出去。

**④ 用户取消不算上游故障**：`recordAborted()` 只释放探针锁，不计失败。

---

## 4. 重试（`llm/retry.ts`）

### 全抖动退避（Full Jitter）

```ts
const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);  // 500,1000,2000… 上限 8000
return Math.floor(Math.random() * ceiling);                        // [0, ceiling)
```

| 参数 | 值 |
|---|---|
| `maxAttempts` | 3（= 1 次首调 + 2 次重试，最多睡 2 次） |
| `baseDelayMs` / `maxDelayMs` | 500 / 8000 |

**为什么用全抖动而不是固定 1s/2s/4s？**
上游故障时所有客户端会同时重试（惊群）。随机化把重试打散到窗口内，
上游压力是"平滑上升"而不是"每隔 1 秒一个尖峰"。

### 哪些错误值得重试（`llm/types.ts` 的 `classifyError`）

| 特征 | code | retryable |
|---|---|---|
| 429 | `RATE_LIMITED` | ✅ |
| ≥500 | `UPSTREAM_ERROR` | ✅ |
| 网络类（ECONNRESET/ETIMEDOUT/EAI_AGAIN） | `NETWORK_ERROR` | ✅ |
| 超时 | `TIMEOUT` | ✅ |
| 401/403 | `UNAUTHORIZED` | ❌（重试也是错） |
| 402 | `INSUFFICIENT_BALANCE` | ❌（钱不够，重试无意义） |
| 400 | `BAD_REQUEST` | ❌ |
| 内容过滤 | `CONTENT_FILTER` | ❌ |

**这张表是整个可靠性行为的总开关**：写错一个 `retryable`，要么白烧钱，要么该重试的不重试。

### 两个容易漏的细节

**① 每次重试必须重置累积量**

```ts
// service.ts:116-120
text = ''; usage = null; finished = false; ttftMs = null;
```

不重置 → 第一次的半截文本已经 `onText` 推给前端，重试后再推一遍 = 用户看到重复内容，
且第一次的 usage 被覆盖 → **漏计费**。

**② 第一轮之前就检查 signal**

```ts
// retry.ts:77
if (signal?.aborted) throw new LLMError('已取消', 'ABORTED', false);
```

不提前检查 → 用户点了停止，第一次请求仍会真实发出并花钱。

---

## 5. 降级：最后一档不是报错，是规则摘要（`llm/budget.ts:184-229`）

全链失败后调用 `heuristicSummary(extractSourceText(prompt))`：

| 能力 | 做法 |
|---|---|
| 剥正文 | 砍掉最后一个 `</document>` 之后的指令段 → 去标签 → 丢参数头 → 归一空白 |
| 摘要 | 句子打分（位置权重 + 含数字 +0.3 + 关键词命中 +0.2，再乘长度归一）→ 按原文顺序重排 |
| 要点数 | 用户要 3 条就给 3 条编号列表（**形式承诺必须兑现**） |
| 输出标记 | `degraded: true`，`usedLabel: 'local/heuristic'`，usage 全 0 |

**为什么"按原文顺序重排"？**
挑句是按分数挑的，但输出乱序读起来是断的。注释写了这一点。

**代价与取舍**：降级结果质量明显差，但用户拿到的是"有内容 + 明确标记降级"，
而不是一个红色报错。这是产品判断：**部分结果 > 无结果**。

---

## 6. 计费：三个维度容易算错（`llm/pricing.ts`）

```ts
cost = cached/M * hit价 * peak + uncached/M * miss价 * peak + output/M * 输出价 * peak
```

| 维度 | 细节 |
|---|---|
| **缓存分档** | `deepseek-flash`：hit 0.003 / miss 0.15（**差 50 倍**） |
| **峰谷 2 倍** | UTC 01-04 ∪ 06-10（北京 09-12 ∪ 14-18），且**北京工作日**且非法定节假日 |
| **未知模型** | 按 `$1/1M` 保守高估，**不返回 0**（返回 0 会让仪表盘失真） |

### 峰谷判断的两个坑（注释里都是真实事故）

```ts
// pricing.ts:93-97
const utcHour = date.getUTCHours();
if (!PEAK_HOURS_UTC.has(utcHour)) return false;
const bj = new Date(date.getTime() + 8 * 3600_000);
const bjDay = bj.getUTCDay();
if (bjDay === 0 || bjDay === 6) return false;         // 必须用北京时间
return !CN_HOLIDAYS.has(beijingDateKey(date));
```

- 多加一道 `getUTCDay()` 周末判断 → UTC 周日 01:00（北京周一早高峰）被判非高峰，**成本低估一半**
- 汇率写死在三个地方（`* 7.2`）→ 详情页与仪表盘差 7.2 倍。现在库里**只存美元**，展示时才 `usdToCny()`

### 计量（`llm/metering.ts`）

| 设计 | 原因 |
|---|---|
| `UsageLog.taskId @unique` | 一任务一条用量，幂等靠唯一约束（P2002 → `skipped:true`） |
| Map 阶段写 `taskId: null` | 唯一约束不允许一任务多条；最终成本以 Reduce 那次为准 |
| 写库失败不抛 | "用户要的是摘要，不是账单" |
| P95 TTFT 取"最近 100 条最慢"再升序取高位 | 写成 `floor(len*0.05)` 会得到第 5 百分位，指标系统性偏乐观 |
| 平均延迟分母用 `_count.latencyMs` 而非 `_all` | Map 阶段没写延迟，用总数会稀释均值 |

---

## 7. 预算：三层闸门（`llm/budget.ts`）

| 层 | 函数 | 作用 |
|---|---|---|
| 1 | `clampInput(prompt, 100k tokens)` | 按比例截断（**当前无调用点**，见下） |
| 2 | `planMapBudget(chunkCount, 4000)` | 每块分到几个要点、多少 token |
| 3 | `estimateTaskCost()` | 跑之前估成本（批次预算闸门用它） |

### `planMapBudget` 的下限陷阱（值得单独讲）

```ts
const perChunk = Math.floor((totalMergeBudget * 0.8) / chunkCount);   // 4000*0.8/n
if (perChunk >= 5 * 40) return { perChunkPoints: 5, perChunkMaxTokens: 200, degraded: false };
const fairShare = Math.max(1, perChunk);
const floor = Math.min(120, fairShare);        // ← 关键：不能突破 fairShare
```

反例：`chunkCount=100` 时 `perChunk=32`。若写成 `max(120, ...)`，
实际输出上限变成 `100×120=12000`，是预算的 **3 倍** —— "预算彻底失效"。

### 一个诚实标注的死代码

`clampInput` / `applyInputBudget` 已实现但**没有任何调用点**；
`lifecycle.ts:190` 注释写"截断到模型能承受的长度"，实际 `:199` 是整篇作为 1 块，没裁。
翻译/润色是 `supportsChunking:false`，所以超长文本**真的不会被截断**。
面试若被追问"超长文本怎么办"，正确回答是：
"摘要走全量分块（块数无上限）；翻译/润色整篇送，超过模型上限会由上游报 400；
`clampInput` 写了但没接上，这是缺口。"

---

## 8. 三个已知实现缺口（主动说出来加分）

| 缺口 | 位置 | 后果 |
|---|---|---|
| `recordSuccess()` 不回 `CLOSED`，`successCount` 是死字段 | `breaker.ts:101` | HALF_OPEN 成终态，退化为单探针串行 |
| 先 `recordSuccess` 再抛 `EMPTY_RESPONSE`，catch 又 `recordFailure` | `service.ts:161-165` | 同一次尝试对熔断器记了一成一败 |
| `OpenAIProvider` 丢弃 `messages`/`tools`，`cachedTokens` 恒 0 | `adapters/openai.ts:57-67` | 跨厂降级时多轮/工具静默丢失，成本偏保守 |

---

## 9. 动手练习

1. **看退避是不是真随机**：`node -e` 里连调 20 次 `computeDelay(2)`，观察分布。
2. **看错误分类**：构造 `{status:402}` 与 `{status:500}` 分别走 `classifyError`，确认 `retryable` 不同。
3. **看计费**：`computeCostUsd({model:'deepseek-flash',promptTokens:1e6,cachedTokens:1e6,completionTokens:0})` 应得 $0.003。
4. **看熔断**：连续 `recordFailure()` 6 次，观察 `canRequest()` 从 true 变 false，30s 后变 true。

---

## 10. 面试问答

**Q：模型超时了，你的系统会做什么？**
> 先按错误类型判断：超时是 `TIMEOUT`、`retryable=true`。于是同一档内退避重试，
> 最多 3 次（500ms→1s 的全抖动窗口）。仍失败就换下一档模型（同厂换型号 → 跨厂 gpt-4o-mini）。
> 全链失败不报错，而是用本地规则摘要并标 `degraded=true`，同时熔断器记失败，
> 连续 5 次后该模型 30 秒内直接被跳过。

**Q：为什么要全抖动，不用固定间隔？**
> 上游故障时所有请求会同时重试形成尖峰。全抖动把重试点随机撒在 `[0, ceiling)` 里，
> 上游看到的是平滑压力。代价是最后一次可能等 8s，但换来的是不把对方打死。

**Q：熔断和重试不是重复了吗？**
> 粒度不同。重试是"这一次请求再试几次"，熔断是"这一段时间别再试"。
> 没有熔断，100 个请求 × 3 次重试 = 300 次打一个已经挂了的服务，这叫"重试放大故障"。

**Q：成本怎么算才不会算错？**
> 三个维度：输入要分缓存命中/未命中（价差 50 倍）、时间段分峰谷（2 倍）、输出单独价。
> 库里只存美元，人民币只在展示时换算——历史上三处硬编码 `*7.2` 导致过 7.2 倍误差。
> 未知模型按 $1/1M 高估，绝不按 0 计（按 0 会让仪表盘失真）。
