# dsh-bridge-obsidian

> Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) to Obsidian: chat with a **real DSH session** inside Obsidian and let the agent read/write your vault through Obsidian's own Vault API. English | 中文

把 DeepSeek Harness 网关桥接到 Obsidian：在 Obsidian 内与 DSH 会话聊天（流式回复、模型切换、历史恢复、提问弹窗），agent 通过 `obsidian_*` 工具读写**客户端本地 vault**——对话可存档为笔记，skills 放在 vault 里按需加载。

```
Obsidian (Windows / macOS / Linux / 手机*)                KaitNAS — dsh-web
┌───────────────────────────┐                             ┌──────────────────────────────────────┐
│ dsh-obsidian-plugin       │  WS + token                 │ @yuxianglin/dsh-bridge-obsidian      │
│  ├─ 聊天面板               │◄───────────────────────────►│  ├─ /obsidian/bridge（hello 帧认证）   │
│  ├─ 审批弹窗/提问弹窗       │   自定义帧协议               │  ├─ chat.* → Typert Gateway 会话中继  │
│  ├─ vault 工具执行器       │◄────────tool.call───────────│  ├─ obsidian_read/write/search/list  │
│  │    (Obsidian Vault API) │────────tool.result─────────►│  │    （defineTool → 中继客户端执行）  │
│  └─ 会话存档 / skills 扫描 │                             │  └─ skills 清单 → agent.inject       │
└───────────────────────────┘                             └──────────────────────────────────────┘
```

`*` 手机端见下文「移动端」。

## 为什么这样设计

- **agent 大脑在 NAS**：桥创建的是真实 DSH host 会话——与 Web GUI 同一套模型配置、凭据、skills、记忆插件（OpenViking 上下文注入同样生效）
- **vault 只在客户端写**：`obsidian_write_note` 经桥回传到 Obsidian、用 Vault API 执行——写的是你正打开的那份本地 vault，实时热加载，再由你的同步机制自然扩散；**绝不直接写 NAS 侧同步存储**
- **双重把关**：模型主动提问（ask_user_question）→ Obsidian 弹窗（面板未打开会自动弹出）；agent 写笔记 → 写审批门（可关）；桥创建的会话才接收提问，Web GUI 会话互不干扰

## 安装

### 1. DSH 端桥插件（NAS / Linux）

**方式 A：一键脚本（推荐）**

```bash
git clone https://github.com/superfat1988/dsh-bridge-obsidian.git
cd dsh-bridge-obsidian
bash scripts/setup-dsh.sh
```

脚本做四件事（幂等，可重复执行）：构建 `packages/bridge-obsidian` → 注册进 `~/.dsh/profiles/web`（dependencies + bundles）→ profile 内 `pnpm install` → 打印重启命令与 token 路径。完成后：

```bash
systemctl --user restart dsh-web.service   # 按脚本打印的命令执行
curl http://127.0.0.1:3080/obsidian/bridge-config   # 应返回 {"wsUrl":"ws://.../obsidian/bridge"}
```

**方式 B：按 DSH 标准插件流程手动安装**

monorepo 同时包含 DSH 桥与 Obsidian 插件，`dsh plugin add github:...` 直装仓库根不可用（与 dsh-browser 相同的限制），手动流程如下：

```bash
git clone https://github.com/superfat1988/dsh-bridge-obsidian.git
cd dsh-bridge-obsidian/packages/bridge-obsidian
pnpm install && pnpm run build          # 产出 lib/index.js + lib/protocol.js
```

编辑 `~/.dsh/profiles/web/package.json`，两处：

```jsonc
{
  "dependencies": {
    // ... 其它插件
    "@yuxianglin/dsh-bridge-obsidian": "link:/绝对路径/dsh-bridge-obsidian/packages/bridge-obsidian"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其它 bundle
        "@yuxianglin/dsh-bridge-obsidian"
      ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，并重启 `dsh-web`。

### 2. 配置网关 token

桥首次启动会**自动生成 256-bit token** 并持久化（`chmod 0600`）：

```bash
cat ~/.dsh/obsidian-bridge-token
```

把这个值填进 Obsidian 插件设置即可。要固定 token（多端共用/脚本化部署），在启动环境设置后重启：

```ini
# ~/.config/systemd/user/dsh-web.service.d/override.conf
[Service]
Environment=DSH_OBSIDIAN_TOKEN=你的固定token
```

> ⚠️ 注意区分：`~/.dsh/ext-bridge-token` 是 **dsh-browser 浏览器桥**的 token，与本项目无关。拿错会 `close(4002, 'bad token')`。

### 3. Obsidian 桌面端（Windows / macOS / Linux）

**方式 A：下载 Release（推荐）**

从 [Releases](https://github.com/superfat1988/dsh-bridge-obsidian/releases) 下载 `dsh-obsidian-plugin-<版本>.zip`，解压出的 `dsh-bridge-obsidian-plugin/` 文件夹（含 `main.js`、`manifest.json`、`styles.css`）整体放入：

```text
<你的vault>/.obsidian/plugins/dsh-bridge-obsidian-plugin/
```

**方式 B：源码编译（Windows 原生，无需 WSL）**

```powershell
git clone https://github.com/superfat1988/dsh-bridge-obsidian.git
cd dsh-bridge-obsidian\packages\obsidian-plugin
pnpm install
pnpm run build          # 产出 main.js（esbuild，纯 JS，无原生依赖）
```

把 `main.js`、`manifest.json`、`styles.css` 三个文件复制到上述插件目录。

**启用与配置**：Obsidian 设置 → 第三方插件 → 开启「DSH Bridge」→ 插件设置里填：

| 设置 | 值 |
|---|---|
| DSH 服务地址 | `http://<NAS的IP>:3080`（局域网 / ZeroTier / Tailscale 均可，见下文远程访问） |
| 桥接 Token | 第 2 步的 `obsidian-bridge-token` 内容 |
| 写入前询问 | 推荐开启：agent 写笔记前弹窗确认 |
| 会话存档 | 每轮自动追加 / 仅手动 / 关闭 |

点「连接」→ 侧栏鲸鱼图标打开聊天面板。

### 4. 移动端（实验性，未充分验证）

`manifest.json` 声明 `isDesktopOnly: false`，插件为纯 JS（无 Node 依赖），理论可在 Obsidian 移动端加载：把插件目录同步/复制到手机 vault 的 `.obsidian/plugins/dsh-bridge-obsidian-plugin/` 后启用。**但移动端 WebSocket 可用性、后台连接行为尚未系统验证**，属 P3 计划项，欢迎反馈。

## 使用

- **聊天**：Enter 发送，Shift+Enter 换行；流式回复、思考块、工具调用行
- **模型选择**：输入框下方下拉框，数据来自 DSH host 的 `modelCatalog`（所有可用 provider/模型）；当前会话立即生效，新对话自动沿用
- **历史会话**：时钟图标 → 从 DSH host 会话列表恢复（durable 历史，重启不丢）
- **会话存档**：每轮自动追加到 vault `Deepseek Harness/<日期> <标题>.md`（frontmatter 含 sessionId/model）；或手动「存档当前对话」
- **vault skills**：在 vault 放置 `Deepseek Harness/skills/<技能名>/SKILL.md`（格式兼容 Copilot V4 / Claude skills，frontmatter 的 `description` 即触发条件）→ 命令「重新扫描 vault Skills」→ 模型按 description 判断、按需用 `obsidian_read_note` 读取执行
- **vault 工具**：`obsidian_list_notes / read_note / write_note / search_vault`，路径一律 vault 相对路径

## 远程访问

dsh-web 默认监听 `0.0.0.0:3080`（或按你的 `--host` 参数）。远程场景推荐：

- **ZeroTier / Tailscale**：服务地址填虚拟网 IP（如 `http://192.168.191.64:3080`）——私网直连，WebSocket 不经 WAF，已实测
- **公网反代（雷池/SafeLine 等）**：**WebSocket 升级会被 WAF 拦截**（2026-09 确认），当前不可用于桥接；HTTP+SSE fallback 在 Roadmap

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `close(4002, 'bad token')` | token 错。确认用的是 `~/.dsh/obsidian-bridge-token`（不是浏览器桥的 `ext-bridge-token`），且已粘贴到插件设置 |
| `close(4001, 'hello timeout')` | 连上了但没发 hello——检查插件版本与网络中间盒 |
| 一直「未连接」 | 服务地址不通：浏览器先开 `http://<NAS>:3080/obsidian/bridge-config` 应返回 JSON；不通则查监听（`ss -tlnp \| grep 3080`）与防火墙 |
| 提示「无 Obsidian 客户端连接」 | 模型调 vault 工具时插件离线——打开 Obsidian 并确认已连接后再试 |
| 公网域名连不上 WS | SafeLine 等 WAF 拦 WebSocket 升级，属已知限制，走 ZeroTier/Tailscale |

## 安全模型

- 桥路径自带 bearer token 认证（常时比较），**无 loopback 捷径**；`/api` 信任围栏不受影响
- 特权网关方法（settings/credentials/host.*）对非回环连接保持拒绝（与 `/api` 围栏镜像，防漂移）
- agent 对 NAS 的核心工具（bash/fs）权限瀑布由 host 沙箱策略管理，桥不二次弹窗；vault 写入的把关在客户端写审批门
- vault skills 内容按 untrusted data 处理（注入文本带防注入声明），只从约定目录读取

## Roadmap

- [ ] 手机端 WS 可用性验证与适配
- [ ] 公网 HTTP POST + SSE 传输 fallback（穿透 WAF）
- [ ] ask_user_question 批量问题 / multiSelect / 自定义输入
- [ ] NAS 侧工具权限转发到客户端审批
- [ ] @笔记提及与当前笔记上下文注入

## License

MIT
