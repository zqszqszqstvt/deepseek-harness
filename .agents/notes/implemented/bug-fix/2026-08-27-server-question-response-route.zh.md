# Agent Note: Server 问题应答路由

Status: implemented

[English](2026-08-27-server-question-response-route.md) | 中文

## Problem

多用户 Server 会通过每个用户的 SSE 端点推送审批请求和问题请求，但平台集成需要为每一种可应答请求提供经过身份验证的 HTTP 操作。审批答案和 `ask_user_question` 答案属于不同协议：审批携带一个封闭的结果值，问题则携带完整的一批选项选择和可选自定义文本。通过审批操作提交问题的 rpcId 会生成审批载荷，网关会拒绝该载荷，使问题及其回合一直处于等待状态。

## Decision

Server 公开 `POST /v1/users/:userId/questions/:rpcId`。其 JSON 正文采用网关的完整问题答案对象 `{ answers: [{ id, selected, custom? }] }`，而不是单个选项。该路由从 `userId` 派生会话 id，在标准 `client-response` 中回显路径里的 rpcId，把正文放在 `result.value.answer` 下，并返回网关 receipt（回执）。

Server 只校验自身的 HTTP 信封和 rpcId 长度限制。`ApiProxy.respond()` 继续负责问题 id、答案数量与顺序、重复选择、选项标签、单选与多选规则、自定义文本、会话归属、等待状态和重复应答。这样所有传输方式都与 Web 客户端一致，并防止 Server 专用校验发生漂移。

## Verification

Server 路由测试固定多问题答案批次、自定义文本、从 URL 派生的会话 id、跨用户拒绝、畸形 HTTP 正文以及网关 `bad-response` receipt 的传播。既有 ApiProxy 问题测试继续负责语义答案校验。

## Alternatives considered

**复用审批路由。** 否决，因为审批结果和结构化问题答案的载荷不兼容，并且分别属于独立的等待登记表。

**接受一个 `{ selected, custom }` 答案。** 否决，因为一次 `ask_user_question` 调用可以包含多个问题，并以一个完整答案批次原子地完成。

**在 Server 路由重复问题校验。** 否决，因为网关已经持有等待请求及其准确问题；第二套实现可能与 Web 和其他客户端接受或拒绝不同的答案。

## Consequences

平台后端可以把 SSE `question/requested` 帧的 rpcId 和完整答案批次提交到对应用户路由来回答问题。在其他用户路由下猜测 rpcId 会携带错误的派生会话 id，并被网关拒绝。无效或过期答案会返回网关 receipt，而不会完成等待中的问题。
