# dsh-bridge-obsidian 帧协议 v1（draft）

两包共同实现的契约。传输细节（hello 状态机、路由注册方式）对齐 dsh-bridge-browser 已验证实现；本文先固定语义层。

## 1. 传输与认证

- WS 端点：dsh web server 上注册 `/obsidian/bridge`（exact/prefix 按宿主 API 定）。
- 认证：连接后在时限内客户端发 `hello`；非回环连接 token 不对 → `close(4002, 'bad token')`；超时未发 → `close(4001, 'hello timeout')`；协议版本不符 → `close(4003, 'bad version')`。
- 通过后桥回 `hello.ok`（携带 vault 名与能力回显）。
- 单活跃客户端：新连接认证成功后，旧连接 `close(4009, 'replaced')`（一个 vault 客户端在线即可；多 vault 是后续版本）。
- 心跳：服务端 WS ping，30s 间隔，连续 2 次无响应断开。
- 帧格式：JSON 文本帧 `{ v: 1, t: "<type>", p: <payload> }`；请求/响应靠 `rid` 关联，工具调用靠 `callId` 关联。

## 2. 帧

### 客户端 → 桥
| type | payload | 响应 |
|---|---|---|
| `hello` | `{ token, client, vaultName }` | `hello.ok` |
| `chat.new` | `{ rid }` | `{ rid, ok, sessionId }` 或 `{ rid, ok:false, error }` |
| `chat.prompt` | `{ rid, sessionId, text }` | 经 `chat.event…chat.done` 流式返回；错误走 `chat.error` |
| `chat.cancel` | `{ sessionId }` | 无直接响应；以 `chat.done(stopReason:'cancelled')` 收尾 |
| `permission.response` | `{ requestId, outcome:'selected'\|'cancelled', optionId? }` | — |
| `tool.result` | `{ callId, ok, result?, error? }` | — |

### 桥 → 客户端
| type | payload |
|---|---|
| `hello.ok` | `{ vaultName }` |
| `chat.event` | `{ sessionId, seq, event }`；`event.kind ∈ text\|thinking\|tool_call\|tool_result\|status\|usage`，text/thinking 带 `{text}`，tool_call 带 `{callId,name,argsText}` |
| `chat.done` | `{ sessionId, stopReason }` |
| `chat.error` | `{ sessionId?, message }` |
| `permission.request` | `{ requestId, sessionId, toolCall:{name,title}, options:[{optionId,name,kind}] }` |
| `tool.call` | `{ callId, name, args }` |

重连语义：客户端指数退避自动重连；会话在 host 内存续，重连后沿用 `sessionId` 直接 `chat.prompt`；若桥回 `chat.error`（未知会话）客户端置为新会话。

## 3. 模型面工具（obsidian_*，defineTool 注册）

统一输出契约 `{ text }`（单文本 ContentBlock，对齐 dsh-browser TEXT_OUTPUT）；错误也以文本返回，便于模型自纠。

| 工具 | 参数 | 行为 |
|---|---|---|
| `obsidian_list_notes` | `folder?`, `limit?=200`, `offset?=0` | 列 vault 内 md 文件（相对路径 + 大小 + 修改时间） |
| `obsidian_read_note` | `path`, `from_line?=1`, `max_chars?=20000` | 读笔记内容（Vault API `cachedRead`），行号标注 |
| `obsidian_write_note` | `path`, `content`, `mode:'overwrite'\|'append'='overwrite'` | 写笔记（Vault API create/modify）；结果文本回执写入字节数 |
| `obsidian_search_vault` | `query`, `limit?=20` | 大小写不敏感全文搜索，返回 `path:行号:行片段` |

约定：
- `path` 一律 vault 相对路径；执行器规范化，越界/绝对路径按错误文本返回。
- 工具调用超时 30s（可配）；超时回错误文本。
- 客户端本地执行器负责 `write` 的人工审批（设置项 `writeApproval: 'ask'|'auto'`，默认 `ask`）——审批发生在客户端执行前，桥与 DSH 层无感。DSH 层对该工具的宿主审批策略由桥创建会话时定（见实现）。

## 4. 会话桥接（实现注记）

- 桥收到 `chat.new/chat.prompt` 后经 `ctx.sessionController` 创建/驱动会话（与 Web GUI 同一套模型/凭据/插件）。
- 会话事件订阅 → 转 `chat.event`；结束 → `chat.done`。
- `obsidian_*` 工具 handler：`tool.call` 派发到当前活跃连接 → 带 `callId` 等待 `tool.result`；无客户端在线时返回错误文本 "Obsidian client not connected"。
