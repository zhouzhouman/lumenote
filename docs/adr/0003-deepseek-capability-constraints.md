# ADR 0003：DeepSeek 能力约束与实现取舍

- **状态**：已采纳
- **核对日期**：2026-10-11（本文档基于当日实查官方文档）

---

## 背景

本 ADR 的存在意义是**记录纠正**。

最初的设计基于既有印象，假设了以下能力。实查官方文档后发现**其中五条全部是错的**。
如果不写下来，下一个人（可能是三个月后的我）会重复同样的错误假设。

---

## 被纠正的错误假设

| 曾经的假设 | 实际情况|
|---|---|
| 模型是 `deepseek-chat` / `deepseek-reasoner` | 已换代为 `deepseek-flash` / `deepseek-v4-pro`，旧名已下线 |
| `deepseek-reasoner` 不支持 Function Calling | thinking 与非 thinking 下**均支持** |
| 没有 prompt caching 计费 | **有**，且cache hit 与 miss 差 50 倍 |
| strict JSON Schema 可用 | 需 `https://api.deepseek.com/beta`，**仅 beta** |
| `temperature` 总有效 | thinking 下**静默忽略** |

最后一条是最危险的：写上去不报错，接口返回 200，但参数完全不起作用。
这种「静默失效」不主动查文档根本发现不了。

---

## 核对后的关键约束

### 1. 模型已换代

```
deepseek-flash      V4.1-Flash，低成本，适合摘要等批量任务
deepseek-v4-pro     更强、更贵
```

配置项：`DEFAULT_MODEL` / `FALLBACK_MODEL`。

⚠️ **模型名与定价都会变**。升级前应重新核对官方文档，
并同步更新 `src/lib/llm/pricing.ts` 中的 `PRICING` 表。

### 2. thinking 模式默认开启，effort 默认 high

```
thinking: { type: 'enabled' | 'disabled' }   默认 enabled
reasoningEffort                               默认 high
```

**thinking 开启时，以下参数被静默忽略**：

```
temperature
presence_penalty
frequency_penalty
```

而 `top_p` **仅在 thinking 生效**，且取值范围仅 **0.95–1.0**。

### 3. Tool Calls 的隐藏要求

带 tools 的请求，**后续每轮必须回传 `reasoning_content`**，否则 API 返回 400。

这是最容易踩的坑：第一次调用正常，模型发起工具调用后，
第二轮如果只传content 不传 reasoning_content，就会 400。

> ⚠️ **2026-10-16 修正（详见 [ADR-0004](0004-tool-call-contract-measured.md)）**
>
> 上面这条**漏了前提条件**，实测表明它只在 **thinking 模式开启** 时成立：
>
> | thinking | 回传 reasoning | 结果 |
> |---|---|---|
> | `disabled` | 否 | ✅ 正常 |
> | `enabled` | 否 | ❌ 400 `The reasoning_content in the thinking mode must be passed back` |
>
> 因为摘要任务决策为 thinking 关闭，**摘要类流程完全不需要处理 reasoning 回传**。
> 原文这种「丢掉前提条件的结论」在下游会被泛化成「永远必须」，
> 代价是多写一堆本不需要的代码 —— 记录下来引以为戒。
>
> 另：thinking 开启时 reasoning 的正式位置是 assistant 内容的 `ReasoningPart`，
> **不是** `providerMetadata.deepseek`（实测那里是空对象）。

### 4. JSON Output 的限制

- prompt 中**必须含 "json" 字样**，否则不生效
- **可能偶发返回空 content** —— 因此 JSON 解析必须容错，
  失败时应降级而非崩溃

### 5. 计价的三个维度

```
cache hit / miss 分档：flash 相差 50 倍（$0.003 vs $0.15 / 1M）
峰谷分时：高峰为低谷 2 倍
输入输出不同价：输出约为输入 miss 的 4 倍
```

---

## 决策

### 摘要任务一律`thinking: 'disabled'`

摘要是需要「快速、忠实、便宜」的任务，thinking 带来的收益远小于它的成本与延迟：

- 成本上升（thinking 的 reasoning token 也计费）
- 首字延迟显著增加（要等推理完才开始输出）
- `temperature` 被忽略 → 0.3 的稳定性设置失效

**决策理由**：摘要不需要推理。`thinking` 适合的是「需要多步分析」的任务，
而摘要是「提取 + 压缩」，本质是判别式任务。

翻译与写作功能另议（那里thinking 可能反而有用）。

对应实现在 `src/lib/llm/adapters/deepseek.ts` 的 `buildSamplingParams()`。

### 稳定内容必须前置以命中前缀缓存

因为 cache hit 与 miss 差 50 倍，prompt 开头的一段必须逐字节稳定。

**这不是风格问题，是直接决定成本的。**

所以 `render.ts` 明确保证：system prompt（模板的一部分）放最前且尽量稳定，
用户输入放后面。`tests/render.test.ts` 里有一条测试专门锁定这个不变量：

```ts
const stableLen = '你是一个专业摘要助手。\n要求：忠实原文。\n风格：'.length;
expect(a.slice(0, stableLen)).toBe(b.slice(0, stableLen));
```

### 计价逻辑自己实现，不信单一数值

DeepSeek 的计价维度太多（缓存分档 × 峰谷 × 输入输出），
且会随时间调整。自己实现的好处是**维度透明**，便于在 UI 上解释成本构成。

`src/lib/llm/pricing.ts` 里的 `PRICING` 表**必须随官方定价更新**，
表格上方有核对日期注释。

峰谷判定里硬编码了中国法定节假日表（2026/2027）——
法定节假日不上高峰，因为没人上班提交任务。

### 不依赖 strict JSON Schema

因为需要 beta 端点，而 beta 端点的稳定性没有保证。

当前摘要任务用自然语言输出，不需要 JSON。
未来若需要结构化输出，用 `response_format: { type: 'json_object' }`
（需 prompt 含 "json"）并**对空 content 做降级处理**。

---

## 关键细节

### 采样参数必须区分 thinking 开关

```ts
if (thinkingOn) {
  if (req.reasoningEffort) params.reasoningEffort = req.reasoningEffort;
} else {
  if (req.temperature !== undefined) params.temperature = req.temperature;
}
```

分开写而不是「都传上去」—— 因为 thinking 模式下 temperature 会被静默忽略，
传上去等于误导后来人以为它生效了。

### usage 的缓存字段多路兜底

不同厂商/版本的usage 字段名不一致：

```
cachedInputTokens / cacheHitInputTokens / promptTokensDetails.cachedTokens
```

适配器里做多字段兜底。**成本统计失效不会报错，只会让账单悄悄离谱**，
所以这类「静默失效」必须专门防。

### 未知模型不能按 0 计

```ts
// 未知模型返回一个保守的高估计值，而不是 0
const fallback = ((promptTokens + completionTokens) / 1_000_000) * 1.0;
```

按 0 计是最危险的失败模式 —— 成本仪表盘显示「几乎免费」，
不会引起任何注意，直到账单出来才发现。已有测试锁定这条。

---

## 后果

**正面**：

- 摘要任务的成本可预测（thinking 关闭 + 缓存命中率高）
- 成本仪表盘能解释「为什么这次贵」（缓存命中 /峰谷 / 模型）
- 避免了 thinking 下的静默参数失效

**负面**：

- 定价表需要人工维护，随官方调整可能过期
- 节假日表需要每年更新
- 不使用 JSON 输出，限制了后续的自动化处理能力

---

## 后续

- **建立定期核对机制**：定价与模型名是本项目唯一「必然会过期」的部分。
  建议每季度核对一次官方文档，更新 `PRICING` 与本文档的核对日期。
- **接入用量告警**：若某用户缓存命中率长期偏低，说明 prompt 前缀不稳定，
  应主动告警而不是等账单出来。
- **翻译/写作功能重新评估 thinking**：
  写作类任务可能确实需要 reasoning，与摘要的策略应当不同。