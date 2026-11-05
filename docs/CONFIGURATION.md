# 配置参考

插件配置是 JSON 对象。`resolveConfig` 会拒绝未知字段和越界值，避免拼写错误静默生效。

## 完整默认值

```json
{
  "server": {
    "baseUrl": "http://127.0.0.1:6185/api/v1/plugins/extensions/astrbot_plugin_feiyu_bridge/",
    "allowNonLoopback": false,
    "requestTimeoutMs": 15000,
    "leaseWaitSeconds": 20
  },
  "auth": {
    "clientId": "windows-dsh",
    "bridgeSecretRef": "FEIYU_BRIDGE_SECRET",
    "apiKeyRef": "FEIYU_ASTRBOT_API_KEY",
    "bridgeSecret": null,
    "apiKey": null
  },
  "runtime": {
    "heartbeatIntervalMs": 7000,
    "queueSize": 1,
    "resultRetryMs": 2000,
    "resultRetryMax": 8,
    "pendingResultTtlMs": 600000,
    "pendingResultMax": 50,
    "reconnectInitialMs": 1000,
    "reconnectMaxMs": 30000,
    "reconnectFactor": 2
  },
  "limits": {
    "payloadBytes": 262144,
    "resultBytes": 262144,
    "responseBytes": 1048576
  },
  "tasks": {
    "defaultTimeoutMs": 30000,
    "maxTimeoutMs": 86400000,
    "idempotencyTtlMs": 600000
  },
  "capabilities": {
    "statusRead": true,
    "workflowRun": {
      "enabled": true,
      "maxPromptChars": 8000,
      "requireSessionKey": true
    }
  },
  "agent": {
    "cwd": null,
    "provider": null,
    "model": null,
    "reasoningEffort": null,
    "preset": null,
    "tools": ["read", "write", "edit"],
    "permissionPreset": "workspace-write",
    "allowHighRiskTools": false,
    "idleDisposeMs": 1800000,
    "maxSessions": 64
  },
  "logging": {
    "level": "info"
  }
}
```

## server

| 字段 | 说明 |
| --- | --- |
| `baseUrl` | AstrBot 扩展路由前缀，必须以 `/` 结尾。默认经 SSH 本地转发到 VPS 的 6185。 |
| `allowNonLoopback` | 默认 `false`。只有明确要直连远端时才改为 `true`；直连必须用 HTTPS 或可信隧道。 |
| `requestTimeoutMs` | 单次请求在租约等待之外的超时，1000–120000。 |
| `leaseWaitSeconds` | 长轮询租约等待，0–25；服务端会再夹到 25 秒。 |

`baseUrl` 不允许内嵌用户名/密码，也不允许 query/hash。

## auth

| 字段 | 说明 |
| --- | --- |
| `clientId` | 与 AstrBot 配置的 `client_id` 完全一致，默认 `windows-dsh`。允许 `[A-Za-z0-9._:-]`，最长 64。 |
| `bridgeSecretRef` | HMAC 共享密钥的 credential ref，默认 `FEIYU_BRIDGE_SECRET`。解析后必须 >= 32 字符。 |
| `apiKeyRef` | AstrBot OpenAPI Key 的 credential ref，默认 `FEIYU_ASTRBOT_API_KEY`。解析后必须 >= 8 字符。 |
| `bridgeSecret` | 仅开发用明文回退；设置后打印一次警告。生产不要使用。 |
| `apiKey` | 仅开发用明文回退；设置后打印一次警告。生产不要使用。 |

凭据解析顺序由 DSH 的 `ctx.credentials.resolve(ref)` 决定：`.credentials.yaml` 的 `refs`、进程环境、dotenv。插件不写凭据文件。

`.credentials.yaml` 示例：

```yaml
refs:
  FEIYU_BRIDGE_SECRET: "0123456789abcdef0123456789abcdef"
  FEIYU_ASTRBOT_API_KEY: "abk_xxxxxxxxxxxxxxxxxxxxxxxx"
```

## runtime

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `heartbeatIntervalMs` | 7000 | 5000–10000，服务端离线判定为 25 秒。 |
| `queueSize` | 1 | 本地待执行队列长度；服务端本身也只允许一个活动任务。 |
| `resultRetryMs` | 2000 | 结果回传失败后的重试间隔。 |
| `resultRetryMax` | 8 | 超过后丢弃该结果并记录警告。 |
| `pendingResultTtlMs` | 600000 | 内存中待回传结果的保留时间。 |
| `pendingResultMax` | 50 | 待回传结果数量上限，超出丢弃最旧的。 |
| `reconnectInitialMs` | 1000 | 指数退避初始值。 |
| `reconnectMaxMs` | 30000 | 指数退避上限。 |
| `reconnectFactor` | 2 | 退避倍数。 |

## limits

`payloadBytes` 对应服务端 `max_payload_bytes`（默认 262144）；`resultBytes` 不得超过 `responseBytes`。结果文本超出 `resultBytes` 时会被 UTF-8 安全截断，并带 `truncated: true`。

## tasks

`defaultTimeoutMs` 是服务端未给 `timeout_seconds` 时的任务超时；`maxTimeoutMs` 是本地硬上限（默认 24 小时），同时受任务 `deadline_at` 约束。异步任务可超过 300 秒，但不会超过服务端为该任务持久化的 deadline。`idempotencyTtlMs` 用于本地缓存已完成任务，避免重复执行。

## capabilities

| 字段 | 说明 |
| --- | --- |
| `statusRead` | 启用 `dsh.status.read`。 |
| `workflowRun.enabled` | 启用 `dsh.workflow.run`。 |
| `workflowRun.maxPromptChars` | prompt 最大字符数，默认 8000。字符数不是字节数。 |
| `workflowRun.requireSessionKey` | 默认 `true`。强制服务端为每个 QQ 用户/会话传 `session_key`，防止上下文串用。 |

## agent

| 字段 | 说明 |
| --- | --- |
| `cwd` | Bridge 会话的工作目录，必须是绝对 Windows 路径。`null` 仅表示沿用 DSH 默认值，但 Bridge 在执行任务时会失败关闭（`CONFIG_ERROR`），因为无 `cwd` 的会话不会被 Workspace 索引，重启后也无法在会话列表恢复。 |
| `preset` | 负责提供工具的 DSH agent preset，默认 `null`（使用 DSH 默认 preset）。桌面 profile 通常应设为 `standard`。若显式配置但 DSH 没有 `agentPresets` 服务，任务会以 `CONFIG_ERROR` 失败。 |
| `provider` | Bridge 会话使用的 provider，例如 `deepseek-account`。必须与 `model` 同时配置；都为 `null` 时要求 DSH 已有默认模型选择，否则 agent 会报 `has no provider/model`。 |
| `model` | Bridge 会话使用的模型，例如 `deepseek-flash`。必须与 `provider` 同时配置。 |
| `reasoningEffort` | 可选推理强度，例如 `low`；只有同时配置了 `provider` 和 `model` 才允许。 |
| `tools` | 授予 Bridge 会话的工具名允许列表，默认 `['read', 'write', 'edit']`。这些工具由 `agent.preset` 挂载后进入 Agent scope，再被 `tools.restrict` 收窄；DSH 会按实际工具名校验，未知名称直接失败。 |
| `permissionPreset` | 每次任务前固定的沙箱/权限 preset，默认 `workspace-write`。可选 `workspace-write` 或 `danger-full-access`；后者会让 Bridge 会话读写 `cwd` 之外的路径，属于显式高风险配置。生产 desktop profile 当前为 `danger-full-access`。 |
| `allowHighRiskTools` | 默认 `false`。开启后仍不推荐；这条只是允许把高风险工具写进 `tools`，不是协议能力。生产 desktop profile 当前为 `true`，并在 `tools` 中加入了 `pwsh`。 |
| `idleDisposeMs` | 会话空闲多久后 dispose，默认 30 分钟。dispose 只释放内存句柄，不删除持久化会话。 |
| `maxSessions` | 同时保留的 Bridge 会话上限；达到上限先回收最久未用的空闲会话。 |

会话 ID 为 `feiyu-bridge-v2-<sha256前缀>`；当已持久化会话缺失、损坏、已归档、`cwd` 不匹配或 preset 不匹配时，会创建 `-g1`、`-g2` 等下一代，而不是复用错误会话。其他 resume 失败（存储不可用、会话被其他进程占用）会直接上报，不会静默新建。

Bridge 在每次任务开始前通过 `permissionPresets` 把该会话固定为 `agent.permissionPreset` + 审批 `never`。默认是 `workspace-write`：如果 GUI 把会话切到 `danger-full-access`，下一次任务会先收回；`permissionPresets` 服务不可用时任务以 `GUARD_UNAVAILABLE` 失败关闭。生产 desktop profile 显式配置为 `danger-full-access`，因此会主动固定到全权限，不再收回。工具白名单、审批策略与沙箱模式是三层独立约束；在 full-access 下，`write`/`pwsh` 仍可绕过 `cwd` 文件边界。

高风险工具（`run_code`、`pwsh`、`bash`、`shell`、`terminal`、`fs*`、`subagent`、`workflow`、`mcp`、`ssh`、`cmd`、`web`、`browser`、`computer`、`screenshot`、`present` 等）在 `allowHighRiskTools=false` 时会被配置校验直接拒绝。

## logging

`silent | error | warn | info | debug`。日志会屏蔽已知密钥、`Bearer ...` 和 `X-API-Key: ...`，不会记录 prompt、结果文本或屏幕内容。

## 配置校验边界

- `heartbeatIntervalMs`：5000–10000
- `leaseWaitSeconds`：0–25
- `requestTimeoutMs`：1000–120000
- `maxPromptChars`：1–64000
- `agent.tools`：不得重复；名称必须能被当前 preset/全局工具注册表解析
- `agent.preset`：`null` 或 1–64 字符的 preset id
- `agent.provider` / `agent.model`：必须同时配置或同时为 `null`；`agent.reasoningEffort` 只有二者都配置时才允许
- `agent.cwd`：`C:\...`、`C:/...` 或 UNC 路径，或 `null`；Bridge 实际执行任务时要求非 `null`
- `baseUrl`：http/https，无凭据、无 query/hash，非 loopback 需显式允许
