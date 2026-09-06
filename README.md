# dsh-bridge-obsidian

把 DeepSeek Harness (DSH) 网关桥接到 Obsidian：在 Obsidian 内与 DSH 会话聊天（流式、思考、工具调用、审批），agent 通过 `obsidian_*` 工具读写**客户端本地 vault**（经 Obsidian Vault API 执行），不触碰 NAS 侧同步存储。

```
Obsidian (PC)                                KaitNAS — dsh-web
┌───────────────────────────┐                ┌──────────────────────────────────────┐
│ dsh-obsidian-plugin       │  WS + token    │ @yuxianglin/dsh-bridge-obsidian      │
│  ├─ 聊天面板(流式/思考/工具)│◄──────────────►│  ├─ /obsidian/bridge + hello 帧 token │
│  ├─ 审批弹窗              │  自定义帧协议   │  ├─ chat.* → ctx.sessionController    │
│  └─ vault 工具执行器       │◄──tool.call───│  └─ obsidian_read/write/search/list   │
│     (Obsidian Vault API)  │──tool.result──►│     (defineTool → 中继客户端执行)      │
└───────────────────────────┘                └──────────────────────────────────────┘
```

## 组件

| 包 | 说明 |
|---|---|
| `packages/bridge-obsidian` | DSH 桥插件（web profile bundle）：WS 载体 + 工具注册 + 会话桥接 |
| `packages/obsidian-plugin` | Obsidian 插件：连接管理、vault 工具执行器、聊天面板 |

## 设计要点

- agent 大脑在 NAS（会话、模型、凭据、OpenViking 记忆全复用 host 运行时）
- 文件操作中继回 Obsidian 客户端用 Vault API 执行——vault 的唯一写层是客户端本地副本
- WS 传输名按 dsh-bridge-browser 同款：hello 帧 bearer token，非回环缺 token `close(4002)`
- 公网（雷池后）WS 被拦属已知约束；P3 规划 HTTP POST + SSE fallback
