# Qwen Gate API 稳定性分析 — 最终版

> 更新: 2026-07-21 (Phase 5 — 无缝账户切换完成)
> 测试状态: **241 pass, 0 fail** ✅
> 状态: 所有 P0/P1 问题已修复，P2 设计局限已识别

---

## Phase 1-3: 已修复的核心问题 ✅

### 根因 1: 工具描述函数缺失 return
- `chatHelpers.ts:272` 已添加 `return`

### 根因 2: Unicode 字符编码损坏
- 不存在于当前代码 — 使用 `'★'` (U+2605)

### 根因 4: Thinking 内容回传
- `chatHelpers.ts:135-138` 三重清理：THINK_TAG_STRIP_RE + THINKING_PREFIX_LINE_RE + THINK_TAG_INCOMPLETE_RE

### RateLimited 账户禁用 — 所有 SSE 路径
- 7 条路径均能正确禁用账户并触发无缝切换

### 循环检测死代码
- `buildInitialStreamState` 已包含 `recentChunks`/`loopStreak` 初始化

---

## Phase 3: 子代理审计修复 ✅

| # | 问题 | 修复 |
|---|------|------|
| 1 | `FUNCTION_BLOCK_RE` `$` 吞掉后续工具调用 | 移除 `$` 备选方案 |
| 2 | `toolCallDepth` 永久卡住 | `CHUNK_STUCK_THRESHOLD=20` 安全阀 |
| 3 | `pendingChunk` 缓冲缺少工具标签预检 | `looksLikeTag` + `looksLikePrefix` 预检 |
| 4 | `CANONICAL_PARAM_NAMES` 重复定义 | `xmlToolParser.ts` 统一导出 |
| 5 | 循环检测中文文本误报 | 辅助检查：≥15 字符公共前缀 或 ≥1 共享行 |
| 6 | Force-release 内容被 `cleanThinkTags` 剥离 | `filterContentPipeline` 调用前转义 `<` 为 `&lt;` |

---

## Phase 5: 无缝账户切换 ✅

### 流式路径
- `processStreamData` 检测 RateLimited → `'retry_account'` 信号
- `runStreamLoop` 返回 `{retryAccount: true}`
- `handlePostStreamCompletion(skipPostStream=true)` 跳过内容输出
- `chatCompletions` retry loop 重试最多 3 次

### 非流式路径
- `parseQwenResponse` SSE error/delta error → `retrySignal.needsRetry`
- `processContentChunks` flush 路径 → `retrySignal.needsRetry`
- `chatCompletions` retry loop 重试

### Anthropic 路径
- 流式：`handleAnthropicStream` 检测 SSE error/delta error + 禁用账户
- 非流式：`anthropicMessages` 传递 `retrySignal`，重试一次

---

## Phase 5 审计: 本轮新修复 ✅

### Anthropic 流式 RateLimited 检测
- 新增 `data.error` 和 `delta.status=error` 检测
- RateLimited 时调用 `setAccountDisabled` + `break` 终止流

### Anthropic 非流式 retrySignal
- `NonStreamingContext` 传入 `retrySignal`
- RateLimited 时重试一次（重新调用 `setupAnthropicSession` + `handleNonStreamingRequest`）

---

## 仍存在的设计局限（P2 — 非紧急）

### 1. 双通道工具调用
工具描述通过 3 种格式发送：`feature_config.local_mcp`、system prompt 文本、顶层 `tools` 字段。`local_mcp` 单独使用偶尔失败，所以需要冗余。

### 2. 消息历史扁平化
Qwen API 只接受单条 message，所有历史压缩到 `<user>`/`<assist>`/`<tool-result>` 标签中。

### 3. XML 解析不支持嵌套
如果 Qwen 输出嵌套工具调用（罕见），内层调用会被丢弃。

### 4. System Prompt 冲突
默认 system prompt 为 Qwen Codex 风格，可能与客户端 system prompt 产生指令冲突。

### 5. Anthropic 流式无 retry loop
`handleAnthropicStream` 检测到 RateLimited 后终止流但不触发自动重试。需要 `anthropicMessages` 层面添加 retry loop（类似 `chatCompletions`）才能在流式中无缝切换账户。当前仅记录日志 + 禁用账户。

---

## RateLimited 检测路径（完整 9 条）

| # | 端点 | 路径 | 触发条件 | 行为 |
|---|------|------|----------|------|
| 1 | OpenAI | HTTP 错误响应 `qwen.ts` | `response.ok=false` + `code=RateLimited` | 禁用 + `setupSession` 重试 |
| 2 | OpenAI | 流式 SSE `data.error` | msg 含 RateLimited 关键词 | 禁用 + `retrySignal` → retry loop |
| 3 | OpenAI | 流式 SSE `delta.status=error` | `delta.code=RateLimited` 或 msg | 禁用 + `retrySignal` → retry loop |
| 4 | OpenAI | 流式 Post-stream flush | `parseQwenErrorPayload` → RateLimited | 禁用 |
| 5 | OpenAI | 非流式 SSE `data.error` | msg 含 RateLimited 关键词 | 禁用 + `retrySignal` → retry loop |
| 6 | OpenAI | 非流式 SSE `delta.status=error` | `delta.code=RateLimited` 或 msg | 禁用 + `retrySignal` → retry loop |
| 7 | OpenAI | 非流式 flush | `parseQwenErrorPayload` → RateLimited | 禁用 + `retrySignal` → retry loop |
| 8 | Anthropic | 流式 SSE error | msg 含 RateLimited 关键词 | 禁用 + break |
| 9 | Anthropic | 非流式 | `retrySignal` → 重试一次 | 禁用 + 重试 |

---

## 测试覆盖

```
241 pass / 0 fail / 308 expect() calls
Ran 241 tests across 16 files
```

覆盖范围：流式/非流式处理、工具调用解析（XML + local_mcp）、循环检测、pendingChunk 缓冲、force-release、RateLimited 禁用+重试、Anthropic 转换、上下文窗口检查、token 估算。