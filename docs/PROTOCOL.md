# 协议兼容性（feiyu-bridge/1）

本客户端实现 AstrBot 插件 `astrbot_plugin_feiyu_bridge` 的 `docs/PROTOCOL_V1.md`。协议权威实现位于：

```
C:\path\to\astrbot_plugin_feiyu_bridge\
  bridge/protocol.py
  bridge/auth.py
  bridge/service.py
  bridge/web.py
```

## 服务端版本同步（v0.1.2-dev）

- 协议仍为 `feiyu-bridge/1`，HTTP 路径、信封和 HMAC 规范化没有变化。
- `dsh_execute` 的模型可见 schema 已固定为 `prompt` + 可选 `timeout_seconds`；`session_key` 由服务端从 QQ 发送者与会话来源派生，模型不可选择。
- `dsh.workflow.run` 租约参数固定为 `prompt`、`session_key`、可选 `timeout_seconds`。
- `tests/vectors/workflow_v1.json` 提供合法参数与三类非法参数；客户端新增 `test/unit/workflow-vector.test.js` 逐项对照，不再自行推导会话身份。
- 服务端报告 52 项测试通过；客户端同步后 58 项测试通过。
- `6185 -> 6185` 是正式支持的本地转发方式，`16185` 只是可选的防冲突端口。

## 基础约定

- `protocol` = `feiyu-bridge/1`
- 所有请求/响应是 UTF-8 JSON
- 成功：`{ "ok": true, "protocol": "feiyu-bridge/1", "request_id": "...", "data": {...} }`
- 失败：`{ "ok": false, "protocol": "feiyu-bridge/1", "error": { "code": "...", "message": "...", "retryable": true|false } }`
- 服务端**不签名响应**；客户端校验协议 ID 和信封形状，并依赖 SSH 隧道或 HTTPS 的传输安全。

## 鉴权

每个请求两层：

1. AstrBot OpenAPI Key（scope 含 `plugin`）

   ```
   X-API-Key: abk_...
   ```

   AstrBot 4.29.4 也接受 `Authorization: Bearer` / `Authorization: ApiKey`，但本客户端固定发送 `X-API-Key`，避免与代理层的 Bearer 语义混淆。Dashboard 的 JWT 或仅聊天权限的 key 会被拒绝。

2. HMAC

   ```
   X-Feiyu-Client-Id: windows-dsh
   X-Feiyu-Timestamp: <Unix 秒>
   X-Feiyu-Nonce: <16-128 位 [A-Za-z0-9_-]>
   X-Feiyu-Signature: <小写 hex HMAC-SHA256>
   X-Request-Id: <可选，UUID>
   ```

规范化消息（6 行，`\n` 连接）：

```
FEIYU-BRIDGE-V1
<METHOD>
<PROTOCOL_PATH>
<timestamp>
<nonce>
<sha256_hex(raw_body_bytes)>
```

`PROTOCOL_PATH` 不含 AstrBot 前缀，例如 `/v1/heartbeat`、`/v1/tasks/<uuid>/result`。时间戳精确到秒，服务端允许 60 秒偏差；nonce 在服务端缓存中防重放。

客户端在内存中缓存 secret/API key 30 秒；收到 401/403 立即失效缓存。

## 端点

### POST /v1/heartbeat

请求：

```json
{
  "agent_version": "0.4.0",
  "capabilities": ["dsh.status.read", "dsh.workflow.run"],
  "active_task_id": null
}
```

响应 `data`：

```json
{
  "online": true,
  "state": "online",
  "last_heartbeat_age_seconds": 3,
  "capabilities": ["dsh.status.read", "dsh.workflow.run"],
  "agent_version": "0.4.0",
  "active_task": null,
  "queued_tasks": 0,
  "cancel_requested": false,
  "server_time": 1760000000
}
```

客户端每 7 秒发送一次（配置范围 5–10 秒），任务执行期间也发送。`cancel_requested === true` 时取消当前活动任务。

### POST /v1/tasks/lease

请求：`{ "wait_seconds": 20 }`。响应：

```json
{
  "task": {
    "task_id": "0f5f...uuid",
    "capability": "dsh.workflow.run",
    "arguments": { "prompt": "...", "session_key": "qq:123:456" },
    "state": "leased",
    "created_at": 1760000000,
    "deadline_at": 1760000060
  },
  "server_time": 1760000000
}
```

或 `{ "task": null, "server_time": ... }`。服务端同一时刻只租出一个任务。客户端只有在没有排队/执行中任务时才发起租约。

### GET /v1/tasks/<task_id>

返回任务状态，不包含 `arguments`。客户端 V1 不主动轮询该端点，保留给诊断/后续版本。

### POST /v1/tasks/<task_id>/result

```json
{
  "status": "succeeded",
  "result": {
    "value": "Agent 的最终文本",
    "session_key": "qq:123:456",
    "turn": 7,
    "truncated": false,
    "usage": { "input_tokens": 100, "output_tokens": 20 }
  }
}
```

或：

```json
{
  "status": "failed",
  "error": { "code": "AGENT_ERROR", "message": "...", "retryable": true }
}
```

只允许对 leased 任务提交。服务端对相同结果做幂等；不同的终态结果返回 `TASK_ALREADY_TERMINAL`。

### POST /v1/tasks/<task_id>/cancelled

客户端在任务被服务端取消（心跳 `cancel_requested`）或本地 deadline 到期后调用。服务端幂等确认。

### GET /v1/status

返回 `data`：`{ protocol, ...body_status }`。客户端只在诊断时使用；`dsh.status.read` 能力读取的是本地运行时状态，不依赖该端点。

## 客户端错误码

服务端可能返回下列代码；客户端会保留 `code`、`message`、`retryable`，并按 `retryable` 决定是否重试结果回传。

| code | HTTP | 含义 | 客户端行为 |
| --- | --- | --- | --- |
| `AUTH_CLIENT_REJECTED` | 401 | client_id 不匹配 | 标记离线，停止回传，等待重连 |
| `AUTH_INVALID_SIGNATURE` | 401 | 签名错误 | 同上 |
| `AUTH_TIMESTAMP_EXPIRED` | 401 | 时间偏差 > 60s | retryable |
| `AUTH_REPLAY` | 401 | nonce 重放 | 标记离线，重新生成 nonce |
| `AUTH_INVALID_NONCE` | 401 | nonce 格式非法 | 标记离线 |
| `AUTH_INVALID_TIMESTAMP` | 401 | 时间戳格式非法 | 标记离线 |
| `BRIDGE_NOT_CONFIGURED` | 409/503 | 服务端未配置 secret/client | 不重试 |
| `BODY_OFFLINE` | 409 | 心跳超时 | retryable |
| `CAPABILITY_DENIED` | 409 | 能力不在白名单 | 任务失败，不重试 |
| `CAPABILITY_UNAVAILABLE` | 409 | 客户端未上报该能力 | retryable |
| `QUEUE_FULL` | 429 | 服务端队列满 | retryable |
| `IDEMPOTENCY_CONFLICT` | 409 | 幂等键冲突 | 任务失败，不重试 |
| `TASK_NOT_FOUND` | 404 | 任务不存在/已清理 | 丢弃结果 |
| `TASK_NOT_LEASED` | 409 | 任务未租给本客户端 | 丢弃结果 |
| `TASK_TIMEOUT` | 409 | 服务端判定超时 | 丢弃结果/ack |
| `TASK_CANCELLED` | 409 | 服务端取消 | 丢弃结果/ack |
| `TASK_ALREADY_TERMINAL` | 409 | 已有终态 | 丢弃结果 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超限 | 任务失败，不重试 |
| `INVALID_REQUEST` | 400 | 请求非法 | 任务失败，不重试 |
| `INVALID_TASK_ID` | 400/404 | task_id 不是合法 UUID | 丢弃，不重试 |
| `TASK_NOT_CANCELLED` | 409 | 任务并未处于取消态 | 停止 ack，不重试 |
| `INVALID_RESULT` | 400 | 结果形状非法 | 任务失败，不重试 |
| `BRIDGE_SHUTTING_DOWN` | 503 | 服务端退出中 | retryable |
| `INTERNAL_ERROR` | 500 | 服务端内部错误 | retryable |

AstrBot OpenAPI 中间件的 401 形状是 `{"status":"error","message":"Missing API key"}`，不是 bridge 信封；客户端会把它显示为 `AUTH_CLIENT_REJECTED: Missing API key`。

## 能力映射

| 协议 capability | 本地实现 | 参数 | 说明 |
| --- | --- | --- | --- |
| `dsh.status.read` | `src/capabilities/status-read.js` | 无 | 返回本地运行时与 Agent 状态，不调用 Agent |
| `dsh.workflow.run` | `src/capabilities/workflow-run.js` | `prompt` 必填；`session_key` 默认必填；`timeout_seconds` 可选 | 在专用 Bridge 会话中执行一轮 Agent |

`dsh.workflow.run` 的 `session_key` 由服务端根据真实 QQ 发送者和 AstrBot
会话来源生成，当前格式为 63 字符的 `qq:<sha256-prefix>`。客户端不会用
prompt 内容做会话隔离；不同 `session_key` 产生不同会话哈希。

## 安全校验的双层实现

1. 服务端（`bridge/protocol.py`）：
   - capability 正则与永久拒绝子串；
   - 参数键递归拒绝 `argv/cmd/command/...`；
   - 参数深度 ≤ 16，只允许 JSON 标量；
   - 服务端 `allowed_capabilities` 白名单。

2. 客户端（`src/core/protocol.js` + `src/config.js`）：
   - 同样的 capability 正则与拒绝子串；
   - 同样的参数键递归拒绝与深度限制；
   - 本地能力注册表只注册两个能力；
   - 参数 schema 只接受白名单键，拒绝未知键；
   - Bridge 会话工具允许列表为空，审批策略 `never`。

不能只靠 prompt 约束；即使模型输出危险指令，执行层也没有对应工具。

## 与 Codex 联调确认

以下事项已在隔离 AstrBot 4.29.4、服务端 `v0.1.2-dev` 和真实
`feiyu-dev` DSH Host 之间完成验证：

1. **AstrBot 扩展路由前缀与本地转发端口（已确认）**
   服务端支持任意 loopback 本地转发端口。客户端默认 `6185`；本次为避免与生产隧道冲突使用 `16187 -> 隔离 VPS 16187 -> 容器 6185`，完整插件路由与双重认证已验证。

2. **API Key 的获取方式与 scope 名称（已确认）**
   在 AstrBot 4.29.4 的 dashboard API-key 页面创建，或通过 `POST /api/v1/api-keys`（dashboard/system 认证）创建；只使用 `plugin` scope，并通过 `X-API-Key` 发送。`chat` scope 或 dashboard JWT 会被拒绝。

3. **`allowed_capabilities` 的实际配置值（已确认）**
   隔离服务端只配置 `dsh.status.read`、`dsh.workflow.run`，心跳返回的有效能力与之完全一致；服务端拒绝扩展到其他能力。

4. **`session_key` 的生成规则（已确认）**
   服务端从经过验证的 QQ 发送者和 AstrBot 会话来源确定性地派生 `session_key`，格式为 `qq:<sha256-prefix>`，共 63 字符；同一用户/会话稳定，不同用户或不同会话不同。模型只看到 `prompt` 和可选 `timeout_seconds`，不能选择或伪造 `session_key`。客户端在 `requireSessionKey: true` 下拒绝缺失的 key；若租约附带可选 `origin`，还会把它并入本地会话哈希。

5. **任务超时与 deadline 的语义（已确认）**
   服务端 `deadline_at` 是 epoch 秒且权威。客户端取剩余 deadline、本地 `maxTimeoutMs` 和参数超时的最小值。本次真实 Agent 长任务在 2 秒 deadline 后进入 `timed_out`；客户端终止 Agent，并可对该终态确认 `/cancelled`。

6. **取消的时序（已确认）**
   服务端标记 `cancelled` 后由心跳返回 `cancel_requested=true`；真实长任务已验证 Agent 被终止并确认 `/cancelled`。重复确认保持幂等。若结果先完成，则成功结果作为先到达的终态获胜。

7. **结果幂等（已确认）**
   服务端对 `{status,result,error}` 的 canonical JSON 做 SHA-256。真实 Agent 结果的相同请求体重试返回 `succeeded`；冲突结果返回 `TASK_ALREADY_TERMINAL`，不会产生 `IDEMPOTENCY_CONFLICT`。

8. **响应签名（已确认）**
   当前服务端不签名响应。若后续增加签名，需要协议升级并在客户端启用验证；V1 明确不做。

9. **能力心跳的时机（已确认）**
   客户端在启动后立即上报能力并持续心跳。服务端按最近一次心跳集合与服务端白名单取交集；断线 35 秒后报告离线，恢复隧道后自动重连并把心跳年龄恢复到约 0 秒。

10. **错误码扩展**
    客户端对未知 code 按 `retryable` 字段处理；若服务端新增 code，请同时给出 `retryable`，否则默认按不可重试的结果丢弃。

11. **`dsh.workflow.run` 的参数 schema 与模型可见描述（已确认）**
   服务端 `v0.1.2-dev` 已把 `dsh_execute` 模型可见 schema 固定为 `prompt`（必填）和可选 `timeout_seconds`；`session_key` 由服务端派生并写入租约，不再是模型参数。客户端只接受租约参数 `{"prompt": string, "session_key": string, "timeout_seconds"?: number}`，未知键拒绝。双方已用 `tests/vectors/workflow_v1.json` 对齐；该向量覆盖合法参数、缺失 session_key、旧 `workflow` 字段和模型自选 session_key 四类情况。
