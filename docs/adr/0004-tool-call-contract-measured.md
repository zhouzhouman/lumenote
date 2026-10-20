# ADR 0004：工具调用契约的实测结论（附 ADR-0003 第 3 条的修正）

- **状态**：已采纳
- **实测日期**：2026-10-16（本文档所有结论来自当日真实 API 调用）
- **实测脚本**：[scripts/agent/probe-tool-contract.ts](../../scripts/agent/probe-tool-contract.ts)
- **模型**：`deepseek-flash`，端点 `https://api.deepseek.com`
- **AI SDK 版本**：`ai@7.0.137`

---

## 背景

要为 Agent 功能实现多轮工具调用，必须在写业务代码之前把 API 契约钉死。
[ADR-0003](0003-deepseek-capability-constraints.md) 第 3 条记着：

> 带 tools 的请求，**后续每轮必须回传 `reasoning_content`**，否则 API 返回 400。

这条如果无条件成立，会显著改变设计（每轮都要保存并回传 reasoning）。
所以我写了一个独立的探针脚本实测，而不是基于文档描述直接开工。

---

## ⚠️ 对 ADR-0003 第 3 条的修正

**原表述「带 tools 就必须回传 reasoning_content」不准确。实测结论是：**

> 只有 **thinking 模式开启** 时，才必须回传 `reasoning_content`。
> **thinking 关闭时，不回传也完全正常。**

实测证据（探针 2 的三个变体，同一组消息、同一个工具结果）：

| 变体 | thinking | 是否回传 reasoning | 结果 |
|---|---|---|---|
| A | `disabled` | 否 | ✅ 成功，正常返回 `17 × 23 = 391` |
| B | `disabled` | 是（`ReasoningPart`） | ✅ 成功 |
| C | `enabled` | 否 | ❌ 失败：`The reasoning_content in the thinking mode must be passed back to the API` |

**这个修正的价值**：摘要任务本来就决策为 `thinking: 'disabled'`（见 ADR-0003），
所以**摘要类的 Agent 循环根本不需要碰 reasoning 回传这件事** ——
少一个状态、少一类 400 错误、少一段最容易写错的代码。

**为什么原表述会错**：它把「thinking 开」这个前提漏掉了。
这属于典型的「文档记了结论、但丢了前提条件」，而丢前提的结论
在下游会被过度泛化成"永远必须"，代价是多写一堆不需要的代码。

---

## 实测确认的其它契约

### 1. 多轮工具调用可以正常跑通

探针 3：一次请求内模型发起了 **3 次工具调用**（两次 `get_weather`、一次 `multiply`），
全部正确执行并汇总。SDK 侧用 `stopWhen: isStepCount(n)` 自动串起多步。

**但我们的 Agent 循环不会用 SDK 的自动多步**，理由见下方「决策」。

### 2. reasoning 的真实位置（仅 thinking 开启时才有）

探针 1（thinking 关闭）：`root.reasoning` 是空字符串，`providerMetadata.deepseek` 是**空对象**。
探针 4（thinking 开启）：`root.reasoningText` 有值（如 `"Result is 9999. Report it."`），
且 assistant 内容数组里出现 `type: 'reasoning'` 的 part。

**结论**：不要从 `providerMetadata.deepseek` 里找 reasoning（那里是空的）。
thinking 开启时，正式位置是 **assistant 内容的 `ReasoningPart`**。

### 3. `providerMetadata.deepseek` 是空对象

无论 thinking 开关，`providerMetadata.deepseek` 的 key 集都是空的。
ADR-0003 里「usage 的缓存字段多路兜底」仍然必要，但**不能指望从这个位置拿 reasoning**。

### 4. 模型不会幻觉出不存在的工具（护栏的实测依据）

探针 5：明确诱导模型调用 `delete_all_files`（工具集里没有），模型的反应是：

> "我没有名为 `delete_all_files` 的工具，因此无法执行这个操作。
> 我可用的工具只有两个：get_weather、multiply。"

**尝试调用的工具列表为空** —— 它没有伪造调用，而是明确说明能力边界。

**这是护栏设计的重要依据**：工具集白名单在 API 层就被强制，
模型无法调用未注册的工具。所以「只读工具」这条安全边界是**结构性**的，
不是靠提示词约束的。

---

## 决策

### 1. Agent 默认 `thinking: 'disabled'`

与摘要任务一致。理由：

- 文档分析 Agent 的核心工作是**检索 + grounding**，不是多步推理
- thinking 成本更高（reasoning token 也计费）、首字延迟更大
- **避开 `reasoning_content` 回传要求** → 循环状态机少一个维度

对应地，Agent 的 `buildSamplingParams` 走 thinking 关闭分支。
若将来要为某类任务开启 thinking，`LLMRequest` 已能承载多轮消息，
届时需要同时实现 reasoning 的保存与回传（这一点记在「后续」里）。

### 2. 不用 SDK 的自动多步，自己写循环

SDK 的 `stopWhen: isStepCount()` 能自动串起多步（探针 3 已验证），
但**我们要自己控制循环**，原因是我们需要 SDK 不提供的东西：

| 需求 | SDK 自动多步 | 自写循环 |
|---|---|---|
| 轨迹落库（每一步的工具、参数、耗时、token） | ❌ | ✅ |
| 单工具额度（`fetch_url` ≤ 3 次） | ❌ | ✅ |
| 死循环检测（相同工具+参数重复） | ❌ | ✅ |
| 预算中断后返回部分结果 | ❌ | ✅ |
| 工具报错交给模型处理而非中断 | 部分 | ✅ 可控 |

所以这些工具定义为**没有 `execute` 的 schema**，由我们的循环负责执行并落库。
这样「Agent 做了什么」才是可审计的 —— 而这正是本项目的定位。

### 3. 工具结果的消息形状（v7 实测）

```ts
// assistant 发起调用
{ role: 'assistant', content: [
    { type: 'tool-call', toolCallId, toolName, input }        // input，不是 v5 的 args
] }

// 工具结果回传
{ role: 'tool', content: [
    { type: 'tool-result', toolCallId, toolName, input,
      output: { type: 'json', value: <任意可序列化值> } }      // 必须包一层 output
] }
```

---

## 后果

**正面**：
- Agent 循环的状态机比预期简单（不需要处理 reasoning 回传）
- 工具白名单的安全边界是结构性的，有实测依据
- 契约已钉死，下游实现不会返工

**负面 / 待验证**：
- **流式下的工具调用尚未实测**。本探针只用 `generateText`（非流式），
  而最终产品要流式。流式下 `tool-call` 事件能否正确获取、参数是否完整，
  需要在阶段 1 用一个补充探针确认
- 探针 5 只测了一种诱导方式（工具名不存在）。**参数层面的诱导**
  （比如让 `fetch_url` 去访问内网地址）需要靠我们自己的 SSRF 校验，
  不能依赖模型自觉 —— 这属于阶段 2 的实现责任

---

## 后续

- **阶段 1 补充探针**：流式（`streamText` + `fullStream`）下的工具调用事件 ✅ 已完成
- 若将来开启 thinking：需实现 `ReasoningPart` 的落库与回传，
  并在多轮之间保持 reasoning 完整（否则重现探针 2 变体 C 的 400）
- 每季度复核：工具调用的请求/响应形状属于会随版本变化的部分，
  升级 `ai` 或 DeepSeek 模型时应重跑本探针

---

## 附：一个与契约无关但同样重要的实测发现（2026-10-16 评测阶段）

跑评测框架的回归报告时观测到：**同一个 prompt、同一个模型、
`temperature: 0.2`、`thinking: disabled`，两次运行的输出仍然不同。**

实测数据（4 个用例，两次运行之间没有任何 prompt 或参数变化）：

| 用例 | 两次输出的行级相似度 |
|---|---|
| 基础数值提取 | 90% |
| 防编造：文档中不存在的信息 | 58% |
| 方法归纳 | 94% |
| 跨段落归纳 | 74% |

### 这为什么重要

它直接否定了「参数一致 ⇒ 结果可复现」这个朴素假设 —— 而这个假设
**正是本项目「可追溯」定位的地基**。如果连同一份 prompt、同一组参数、
同一个模型名都不能得到同样的输出，那么「记录下参数就能复现结果」
就是一句空话。

### 因此本项目对「可复现」的表述必须精确到三层

| 层次 | 能否做到 | 说明 |
|---|---|---|
| **可追溯**（traceable） | ✅ 能 | 完整记录 prompt 版本、模型、参数、成本、轨迹。这一层是可靠的 |
| **可复现**（reproducible） | ❌ 做不到严格意义 | LLM 采样本身有随机性，同一输入不保证同一输出 |
| **可验证**（verifiable） | ✅ 部分能 | 用评测框架在**统计意义**上验证：通过率、证据链完整率、成本分布 |

**这条修正对面试与文档都至关重要**：声称「可复现」而拿不出确定性证据，
一旦被追问「那你重跑一次给我看」，当场就崩。正确的说法是
「**可追溯 + 可统计验证**」，并主动说明采样随机性这个客观限制。

### 顺带解释了为什么评测框架必须存在

既然单次运行不可复现，那么「改了 prompt 之后有没有变差」就**不能靠跑一次看**——
必须靠一组用例的统计结果。这也是本项目阶段 4 的动机：
661 个单测保证代码逻辑，评测用例集保证**质量没有退化**。

