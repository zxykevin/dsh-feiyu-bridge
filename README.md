# dsh-feiyu-bridge (Windows)

DSH Desktop 侧的 Feiyu Bridge 客户端。它作为 Cordis 插件运行在现有 DSH Desktop Host 内，主动连接 VPS 上的 AstrBot `astrbot_plugin_feiyu_bridge`，领取经过认证的任务，调用本机 DSH Agent，并把结果回传。

```text
QQ 用户
  -> AstrBot (VPS)
  -> astrbot_plugin_feiyu_bridge (feiyu-bridge/1)
  -> SSH 本地转发 127.0.0.1:6185
  -> dsh-feiyu-bridge（本插件，出站 HTTP，不监听端口）
  -> ctx.agents 专用 Bridge 会话
  -> DSH Agent
  -> 结果原路返回 QQ
```

- 协议版本：`feiyu-bridge/1`
- 插件版本：`0.4.0`
- 状态：会话生命周期、重启恢复与真实工具调用已在隔离 Host 验证（2026-11-05）；79 个自动化测试通过；生产 desktop profile 需重载插件后生效。历史部署记录与跨系统 E2E 见 [`docs/REAL_E2E_REPORT.md`](docs/REAL_E2E_REPORT.md) 和 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

## 设计边界

- 复用当前 DSH Desktop Host：不启动第二个 DSH 实例，不调用 GUI 内部 RPC，不暴露 `60236`。
- 只发出站 HTTP 请求；不在 Windows 上监听任何端口。
- 使用专用 Bridge 会话，不向用户正在操作的 GUI 会话插入任务。
- 会话哈希基于可选的服务端 `origin`（若提供）与必填 `session_key`；不同 QQ 用户不共享上下文。
- 会话 ID 形如 `feiyu-bridge-v2-<hash>`，重建时追加 `-gN`。会话创建时写入真实 `cwd` 与 `agentPreset`，因此 DSH 重启后仍能被 Workspace 索引并在会话列表中出现；配置中的 `cwd` 必须是绝对路径，`null` 会在执行任务前失败关闭（`CONFIG_ERROR`）。
- 启动时扫描已持久化会话：跳过已归档、`cwd` 不匹配或其他 preset 的会话；仅在会话不存在/损坏时创建下一代，其他 resume 失败直接上报，绝不静默创建重复会话。
- Bridge 会话创建时：
  - 先挂载 DSH agent preset（`agent.preset` 为 `null` 时使用 DSH 默认 preset；生产 desktop profile 显式配置为 `standard`），使文件工具进入该 Agent 的 scope；
  - 再用 `agentCtx.tools.restrict({ allow: config.agent.tools })` 收窄工具；默认是 `read` / `write` / `edit`，生产 desktop profile 现显式加入 `pwsh`；
  - 审批策略强制为 `never`（需要人工批准的动作直接拒绝），不修改桌面 Agent 的审批设置；
  - 服务端能力必须在本机 capability 注册表中存在，且参数经过本地校验。
- 协议层仍只注册 `dsh.status.read` / `dsh.workflow.run`，不接受 shell/PowerShell/SSH 类 capability；生产 desktop profile 例外地允许 Agent 在任务内部调用 `pwsh` 工具。
- 工具调用必须产生真实的 `tool/call` 与 `tool/result` 事件才算执行；只在正文里输出 DSML/伪工具文本会被识别为未执行并报错，工具失败也不会被当作成功返回。
- 每个 Bridge 任务开始前都会把会话权限固定为 `agent.permissionPreset` + 审批 `never`；默认是 `workspace-write`，即使 GUI 把会话切到 `danger-full-access`，下一次任务也会先收回。生产 desktop profile 当前显式选择 `danger-full-access`，因此不再受工作区边界限制。
- 生产 desktop profile 同时允许 `pwsh` 与 `danger-full-access`，这意味着被攻破的 VPS 或绕过身份校验的 QQ 消息可以在整台 Windows 上执行命令、读写任意文件。只应在完全信任 VPS 与 QQ 认证链路、且本机没有敏感数据时使用；安全默认值仍是 `workspace-write` + `read/write/edit`。

## 能力

| capability | 用途 | 是否调用 Agent |
| --- | --- | --- |
| `dsh.status.read` | 返回在线状态、协议、客户端 ID、Agent 会话统计、传输状态、限制 | 否 |
| `dsh.workflow.run` | 接收 `prompt` + `session_key`，在专用 Bridge 会话中执行一轮 Agent，返回文本结果 | 是 |

`workflowRun.requireSessionKey` 默认 `true`，因此服务端必须为每个 QQ 用户/会话传稳定的 `session_key`。缺少该字段会被本地拒绝。

## 快速开始（不接触 desktop profile）

```powershell
cd 'C:\path\to\dsh-feiyu-bridge'
npm test                 # 79/79
npm run mock             # 仅启动 Mock Server，默认 127.0.0.1:6199
```

Mock Server 使用固定测试密钥（不是生产密钥）：

- API key：`abk_mock_openapi_key_1234567890`
- Bridge secret：`mock-bridge-secret-0123456789abcdef`（32 字符）
- client id：`windows-dsh`

让插件连接 Mock 时，把 `server.baseUrl` 设为 `http://127.0.0.1:6199/feiyu-bridge/`，把 `auth.bridgeSecret` / `auth.apiKey` 设为上面的测试值（仅本地测试），或通过环境变量提供。

如果要实际执行 `dsh.workflow.run`，还需要给 Bridge 会话配置模型，例如 `agent.provider: deepseek-account`、`agent.model: deepseek-flash`（可选 `agent.reasoningEffort: low`）。新建的空会话没有默认模型时会报 `has no provider/model`。文件工具由 DSH agent preset 提供，建议同时设置 `agent.preset: standard`；不同 DSH 版本若没有默认 preset，需要显式指定可用的 preset id。

常用 Mock 管理接口（仅本机测试）：

```text
GET  /__mock/state
GET  /__mock/results
POST /__mock/enqueue     { "capability": "...", "arguments": {...} }
POST /__mock/cancel      { "task_id": "..." }
POST /__mock/unavailable { "unavailable": true }
POST /__mock/reset
```

## 凭据

插件配置只保存**引用**，不保存明文。默认引用：

- `FEIYU_BRIDGE_SECRET`：HMAC 共享密钥，至少 32 字符
- `FEIYU_ASTRBOT_API_KEY`：AstrBot OpenAPI key，需要 `plugin` scope

写入 `%USERPROFILE%\.dsh\.credentials.yaml`：

```yaml
refs:
  FEIYU_BRIDGE_SECRET: "<至少 32 字符的随机密钥>"
  FEIYU_ASTRBOT_API_KEY: "abk_<AstrBot plugin scope key>"
```

也可以使用同名环境变量。开发调试允许在配置里写 `auth.bridgeSecret` / `auth.apiKey`，但会打印一次警告，生产环境不要这样做。

## 配置

完整默认值和校验范围见 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。最小配置示例：

```json
{
  "server": {
    "baseUrl": "http://127.0.0.1:6185/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/"
  },
  "auth": {
    "clientId": "windows-dsh",
    "bridgeSecretRef": "FEIYU_BRIDGE_SECRET",
    "apiKeyRef": "FEIYU_ASTRBOT_API_KEY"
  },
  "capabilities": {
    "statusRead": true,
    "workflowRun": {
      "enabled": true,
      "maxPromptChars": 8000,
      "requireSessionKey": true
    }
  }
}
```

## 安装与卸载

见 [`docs/INSTALL.md`](docs/INSTALL.md)。要点：

- 使用 `plugin_manager install_bundle` 安装绝对路径 `C:\path\to\dsh-feiyu-bridge`。
- 安装会修改 desktop profile，必须由用户明确批准。
- 安装后重启 DSH。
- 卸载使用 `plugin_manager remove_bundle`，然后重启 DSH。

## 协议摘要

详见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

- 外层：AstrBot OpenAPI key，放在 `X-API-Key` 头（需 `plugin` scope）。
- 内层：`X-Feiyu-Client-Id`、`X-Feiyu-Timestamp`（秒）、`X-Feiyu-Nonce`、`X-Feiyu-Signature`。
- 签名串：`FEIYU-BRIDGE-V1\nMETHOD\nPROTOCOL_PATH\ntimestamp\nnonce\nsha256(body)`。
- 端点：`/v1/heartbeat`、`/v1/tasks/lease`、`/v1/tasks/<id>/result`、`/v1/tasks/<id>/cancelled`、`/v1/status`。
- 客户端只领取任务，不主动轮询任务列表；同一时刻只执行一个任务。

## 安全模型

详见 [`docs/SECURITY.md`](docs/SECURITY.md)。

- 双重认证：AstrBot API key + HMAC；时钟偏差 60 秒；nonce 防重放。
- 双重能力校验：服务端 `allowed_capabilities` + 本地 capability 注册表。
- 双重参数校验：服务端拒绝命令形参数键；本地再次拒绝。
- 专用会话：默认 `read` / `write` / `edit` + 审批 `never` + 每次任务前固定 `workspace-write` 沙箱；生产 desktop profile 现显式启用 `pwsh` 与 `danger-full-access`。
- 会话隔离：默认要求服务端传 `session_key`。
- 出站限制：默认只允许 loopback、禁止重定向、响应体大小上限。
- 日志不记录 prompt、结果、API key 或完整对话。

## 测试与验证

见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)。

```powershell
npm test
node -e "import('./src/index.js').then(m => console.log(m.name, m.inject, typeof m.apply))"
```

已验证：配置、协议校验、HMAC 固定向量、Mock Server、Transport、Dispatcher、Agent Adapter、插件入口装配、取消/超时/重连/幂等；在 DSH 自带 Cordis 4.1.0 中以 fake services 完成挂载；在隔离 Host 中验证了心跳、`dsh.status.read`、`dsh.workflow.run`、真实 `write`/`read` 工具调用、`danger-full-access` 下真实 `pwsh` 写出工作区外文件并读回、工具错误回传、同 `session_key` 重启后恢复（turn 2、同一 session id、无重复生成）；归档/缺失会话重建由单元测试覆盖。历史隔离 AstrBot 4.29.4 跨系统 E2E 见 [`docs/REAL_E2E_REPORT.md`](docs/REAL_E2E_REPORT.md) 与 [`docs/RECOVERY_RECHECK.md`](docs/RECOVERY_RECHECK.md)。

尚未验证：Host 重启时正在执行中的任务如何恢复；生产环境的长任务取消/超时复验；生产 Host 重启后 `danger-full-access` + `pwsh` 的实机生效复验（隔离 Host 已验证）。Bridge 会话默认使用 `read` / `write` / `edit`，审批为 `never`，并且每次任务前把沙箱固定为 `agent.permissionPreset`（默认 `workspace-write`）；生产 desktop 显式配置为 `danger-full-access` 并加入 `pwsh`，这是有意关闭文件边界的高风险选择。如果为空会话未指定模型，需要配置 `agent.provider` / `agent.model`，否则 DSH 会报 `has no provider/model`。

## 目录

```text
src/
  index.js                  Cordis 入口
  config.js                 配置解析与校验
  runtime.js                长轮询、心跳、结果投递、重连
  core/
    auth.js                 HMAC 签名与凭据解析
    protocol.js             协议校验与错误映射
    errors.js               结构化错误
    dispatcher.js           单并发任务调度
    capability-registry.js  能力注册表
  transport/
    transport.js            传输接口
    http-longpoll.js        HTTP 实现
  capabilities/
    status-read.js          dsh.status.read
    workflow-run.js         dsh.workflow.run
  agent/
    agent-adapter.js        适配器接口
    dsh-agent-adapter.js    ctx.agents 实现
mock/server.js              Mock Server
test/                       单元 + 集成测试
docs/                       安装、配置、协议、安全、验证文档
```

## 许可

MIT，见 [`LICENSE`](LICENSE)。
