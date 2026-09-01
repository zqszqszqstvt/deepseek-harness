# @deepseek-ai/dsh-executor-protocol

[English](README.md) | 中文

DSH Executor Broker 与本地执行器共用并进行运行时校验的 WebSocket 消息协议。协议包括设备注册、心跳、项目工作区绑定、文件系统操作、前台子进程执行、输出流、取消和最终结果。每个执行请求都携带所属用户、设备、Session、项目、环境绑定和环境 epoch；每个输出与最终结果都会重复环境绑定和 epoch，供 Broker 校验。

执行器主动建立出站 WebSocket，并首先发送 `executor/register`。Broker 确认协议版本后负责心跳和执行请求关联。连接中断的请求不会自动重放。

## 模型体验

无。本包只校验传输消息；执行 Provider 和 Agent 上下文插件负责模型可见内容。

#### KV Cache 影响

无。本包不组装模型请求。

## 已知限制和待完成工作

- **仅支持第一版能力**：协议暂不包括 PTY、LSP、本地 MCP、后台进程和跨环境文件传输。
