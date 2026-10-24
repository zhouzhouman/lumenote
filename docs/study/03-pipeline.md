# 03 · 管线：分块、Map-Reduce、Prompt、引用

> 目标：能回答"长文怎么办""为什么这么切""为什么合并不会失真"。

---

## 1. 一句话版本

短文本单次调用；长文本切成 1200 token 的块，3 路并发跑 Map（每块出几条要点），
再把各块结果拼起来跑一次 Reduce 合并。**成本随长度线性增长，而不是平方。**

```
chunks.length === 1 ──▶ runSinglePass（省掉一次无意义的往返）
chunks.length  > 1 ──▶ Map(并发3, 每块 pointCount 条) ──▶ Reduce(合并去重)
```

---

## 2. 分块（`pipeline/chunk.ts`）

| 参数 | 值 | 说明 |
|---|---|---|
| 块大小 | **1200 tokens** | 不是字符数；用 `estimateTokens`（汉字 1 字≈1 token，英文 3.2 字符≈1） |
| 重叠 | **100 tokens**（≈320 字符） | 让上一块尾部出现在下一块开头 |
| 并发 | **3** | `CHUNK_CONCURRENCY` |
| 单段独占阈值 | `maxTokens*0.9` = **1080** | 一段自身就接近上限时独占一块，**不与重叠区拼接** |
| 优先级 | 段落 `\n{2,}` → 句末标点 → 硬切 | 尽量切在语义边界 |
| 末块去重 | 前 200 字符相同且 `minLen<400` 则跳过 | 防止重叠导致整块重复 |

### 为什么要有重叠？

分块会切断跨块的语义（一句话被劈成两半）。重叠让下一块能看到上一块的尾巴。
代价约 8% token，但**依赖前缀缓存**（hit 价是 miss 的 1/50），净成本接近于零。

> 这句话是面试的"深度信号"：不是"为了不切断语义"这么简单，
> 而是"重叠的成本被缓存定价结构抵消了"。

### 三个"超长"要分开讲（很容易答错）

| 场景 | 实际行为 |
|---|---|
| 用户输入 > 100,000 字符 | **直接拒绝**（422），不截断（`env.ts:121`） |
| 摘要超长 | 全量分块，块数没有上限 |
| 翻译/润色（`supportsChunking:false`） | 整篇作为 1 块送入，**代码里没有截断**；超模型上限会被上游 400 |

---

## 3. Map-Reduce（`pipeline/map-reduce.ts` + `runner.ts`）

### 并发实现：固定 worker 池，不是 `Promise.all(list)`

```ts
// chunk.ts:218-235
const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
  while (cursor < items.length) {
    const i = cursor++;                 // 共享游标
    results[i] = await fn(items[i], i);
  }
});
await Promise.all(workers);
```

**为什么不用 `Promise.all(items.map(fn))`？**
那等于"全部同时发"——100 个块就 100 个并发请求，直接打爆上游配额和本地连接池。
worker 池是"最多 3 个在飞"，内存与压力都可控。

### 每块的预算（`planMapBudget`）

```
perChunk = floor(4000 * 0.8 / chunkCount)      // 留 20% 给合并阶段
perChunk >= 200  → 5 条要点，不降级
否则             → max(3, floor(perChunk/40)) 条，degraded=true
```

| 块数 | 每块要点 | 是否降级 |
|---|---|---|
| 10 | 5（perChunk=320） | 否 |
| 40 | 3（perChunk=80） | 是 |

### Reduce 只做一层

输入是各块输出**按顺序拼接**（`join('\n\n')`），不做结构化去重；
指令要求"不超过 max(3, N) 条、去重、保持原文顺序"。没有递归 reduce。

**为什么不做递归？** 100 块的输出拼起来还是可能超长，但那已经是极端场景；
递归 reduce 的复杂度（分组、层级、失败回滚）远大于收益。

### 一个块的模型调用失败会怎样？

**不会中断整批**。因为 `streamWithFallback` 不抛错——它返回降级文本。
所以：单块失败 → 那一段是规则摘要 → Map 继续 → Reduce 照常。
真正会中断的只有 `ABORTED`（用户取消）和非 LLMError 异常。

### ⚠️ 一个容易讲错的点：Map 的降级不会写进 `Task.degraded`

```ts
// runner.ts:244
const anyDegraded = reduce.degraded;      // 只看 Reduce
```

Map 阶段的降级只写进 `UsageLog.meta`；`outputMeta.mapDegraded` 存的是**预算降级**（另一个概念）。
面试若问"单个分块降级了用户能看到吗"，正确答案是"看 `UsageLog.meta`，任务级 `degraded` 不会反映"。

---

## 4. Prompt 渲染（`pipeline/prompts/render.ts`）

### 变量优先级

```
用户传入（trim 后非空） > 变量定义的 default > 必填则抛错 > 空字符串
```

| 情况 | 行为 |
|---|---|
| 模板里有 `{{x}}` 但 `definitions` 里没有 x | **替换成空串**，不报警、不保留 `{{x}}` |
| 必填但没值 | 抛 `TemplateRenderError` → 归类 `INVALID_PARAMS` |
| enum 值不在白名单 / 数字格式不对 | 渲染前统一校验，一次性收集所有错误 |

### system prompt 也渲染（这是个修过的 bug）

```ts
// context.ts:94-103
const { content: _content, ...safeValues } = userValues;   // 正文不能进 system
return renderTemplate(ctx.systemPrompt, safeValues, ctx.variables);
```

早先 system 原样透传，模型收到字面量 `{{style}}`/`{{targetLang}}`，**用户选项全程无效**。
同时刻意把 `content` 剔除：否则 system 每次请求都变，**前缀缓存全失效**。

### 只渲染一次 system，user prompt 每块重渲

- system 渲染一次、所有分块复用 → 逐字节一致 → 命中前缀缓存
- user prompt 每块重渲（换 `content`）

### 双层包裹（面试可以聊的安全细节）

user prompt 模板里本身写了 `<document>{{content}}</document>`，
外面又套一层 `wrapUntrusted(userPrompt)`，并且把正文里的 `</document>` **换成全角**，
防止攻击者提前闭合标签。

为什么换全角而不是加反斜杠？因为 `<\/document>` 在聊天 prompt 里**不是转义**，
模型读到的仍是结束标签，边界照样闭合（测试锁了这个 bug）。

> 这也是为什么降级时必须用 `extractSourceText` 剥壳——prompt 里有两层标签。

---

## 5. 引用与证据（只有 Agent 有）

普通摘要/翻译/润色的产物**没有引用结构**。Agent 的结论里每条可以带 `{source, quote}`：

```ts
// agent/evidence.ts:92-101
if (content.includes(ev.quote)) { verified++; exact++; continue; }              // 精确
if (normalizeForMatch(content).includes(normalizeForMatch(ev.quote))) {        // 归一化兜底
  verified++; normalized++; continue;
}
missing.push({ ...ev, reason: '引用的原文片段未在该分块中找到' });
```

| 档 | 规则 |
|---|---|
| 精确 | 子串直接命中 |
| 归一化 | 去空白 + 统一中英文标点 + 小写后再命中 |
| 失败 | 记入 `missing`，**不影响结论展示**，只降 rate |

`rate = verified / total`，写进 trace span 与 UI 徽标。

**为什么不用 LLM 判官？**
"结论对不对"需要领域知识；"有没有依据"可以零成本、完全确定性地判定。
这个拆分本身就是设计能力。

---

## 6. 管线里两个"防回退"的护栏（都来自真实事故）

**① 准备阶段兜底只在未终态时补写 failed**

```ts
// lifecycle.ts:93-97
// 变量校验抛错但没落库 → 任务永久卡 running → 占住并发额度 → 之后全部 429
```

**② 类型非法显式失败，不回落 summarize**

```ts
// lifecycle.ts:137-143
throw new LLMError(..., 'UNSUPPORTED_TASK_TYPE', false, 422)
```

回落会让"翻译任务"变成"摘要任务"，界面显示成功、内容全错——这是最难发现的 bug 类型。

---

## 7. 动手练习

1. **观察分块**：写个脚本调 `chunkText(text, {maxTokens:1200, overlapTokens:100})`，
   打印每块的首尾 20 字，确认重叠区真的存在。
2. **观察预算降级**：`planMapBudget(10, 4000)` vs `planMapBudget(100, 4000)`，看返回值差异。
3. **观察渲染**：故意传一个模板里不存在的变量，确认输出是空串而非 `{{x}}`。
4. **观察降级摘要**：直接调 `heuristicSummary(长文本, {maxPoints:3})`，看是否按原文顺序编号。

---

## 8. 面试问答

**Q：为什么要 Map-Reduce，不能一次性塞给模型吗？**
> 三个原因：① 模型上下文有上限，超了直接 400；② 超长输入成本按 token 线性涨，
> 而一次性输出质量会随长度下降（中间内容容易被忽略）；③ 分块后可以并发，
> 墙钟时间从"线性"变成"线性/3"。代价是合并可能丢细节，所以 Reduce 要求"保持原文顺序"。

**Q：分块重叠会不会重复计费？**
> 会多花约 8% 输入 token，但因为 DeepSeek 有前缀缓存（命中价是未命中的 1/50），
> 重叠部分基本都在缓存里，净成本接近零。这是"用缓存定价结构抵消重叠成本"的设计。

**Q：合并阶段怎么保证不丢信息？**
> 说实话，不能完全保证。Reduce 是一层合并，输入是各块文本拼接，指令要求去重并保持顺序。
> 极端情况下细节会丢。更严格的做法是让 Map 输出结构化 JSON（带来源块号），
> Reduce 做确定性归并——但那样对模型输出格式的鲁棒性要求高得多。

**Q：如果某个分块的模型调用失败了，整篇就废了吗？**
> 不会。调用层对失败是"返回降级文本"而不是抛错，所以那一块会变成规则摘要，
> 其余块正常，最后照常合并。用户看到的是一篇质量不均匀的摘要，而不是报错。
> 但这个降级只记在 `UsageLog.meta` 里，任务级 `degraded` 标志反映不出来——这是缺口。
