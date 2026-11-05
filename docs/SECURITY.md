# 安全模型与风险

## 信任边界

```
QQ 用户  --不可信-->  AstrBot / VPS  --SSH 隧道-->  Windows DSH
```

- **QQ 用户不可信**：身份、内容、频率都由服务端校验。Windows 端不信任服务端传来的 `origin` 字段，只把它当作会话隔离输入。
- **VPS 是半可信的**：它能决定给 Windows 发什么 prompt，因此必须假设“被攻破的 VPS 可以向 Agent 提问”。Windows 端的防线是：最小工具集（仅工作区文件读写）、审批拒绝、能力白名单、参数校验、会话隔离、超时和大小限制。
- **本机 DSH 用户是可信的**：不修改桌面 Agent 的审批策略，不向用户当前会话插入任务。

## 强制限制

### 1. 协议 capability 仍无命令执行入口

插件只注册两个 capability：

- `dsh.status.read`：只读状态；
- `dsh.workflow.run`：把 `prompt` 交给专用 Bridge 会话的一轮 Agent。

不存在 shell、PowerShell、SSH、文件读写、浏览器、截图、系统管理等 capability。生产 desktop profile 虽然允许 Agent 使用 `pwsh` 工具，但那是 `dsh.workflow.run` 内部的一轮 Agent 行为，不是新的协议 capability。服务端送来的 capability 名必须同时满足：

- 服务端 `allowed_capabilities`；
- 客户端能力注册表；
- 客户端 capability 正则和拒绝子串（`shell/ssh/powershell/pwsh/cmd/terminal/...`）。

### 2. Bridge 会话的工具与沙箱（默认最小权限）

创建会话时先挂载 DSH agent preset（`agent.preset` 为 `null` 时使用 DSH 默认 preset；生产配置为 `standard`），再执行 `agentCtx.tools.restrict({ allow: [...config.agent.tools] })`。安全默认值是 `['read', 'write', 'edit']`，工作范围受 `agent.cwd` 约束；shell、PowerShell、网络、浏览器、子 Agent、调度等工具不在允许列表内，高风险工具名还会在配置阶段被拒绝，除非显式设置 `agent.allowHighRiskTools: true`。

工具白名单之外还有独立的一层沙箱约束：Bridge 在**每个任务开始前**通过 `permissionPresets.set(session, config.agent.permissionPreset)` 固定沙箱，并重新固定审批 `never`；`permissionPresets` 不可用时失败关闭。默认 `permissionPreset` 是 `workspace-write`，所以 GUI 中把会话切到 `danger-full-access` 后，下一次任务会先收回。

**生产 desktop profile 是显式的高风险例外**：`agent.permissionPreset: danger-full-access`、`agent.allowHighRiskTools: true`、`agent.tools` 包含 `pwsh`。这意味着被注入的 prompt 可以执行任意 PowerShell 命令并读写整台 Windows 上的文件，不再受 `agent.cwd` 约束；工具白名单仍会阻止未列出的工具，但 `pwsh` 本身足以绕过文件边界。只有在完全信任 VPS、QQ 身份校验和本机数据边界时才应使用该配置。

模型在正文里输出的伪工具文本不会被执行，只有真实 `tool/call` / `tool/result` 事件才算执行。

### 3. 审批策略为拒绝

Bridge 会话的审批策略被设为 `never`。在 DSH 中 `never` 的含义是“**不弹审批，直接拒绝需要审批的动作**”，不是“自动批准”。

- 不修改 `dsh-user-approval` 的全局配置；
- 不修改桌面 Agent 的审批设置；
- 不使用 `ctx.approval.request()` 伪造本地用户确认；
- 远程任务无法冒充本地用户点击“允许”。

如果某个动作仍然需要审批，结果是任务失败并返回 `AGENT_ERROR`（`blocked`），而不是提权。

### 4. 参数二次校验

客户端对 `arguments` 做与服务端同构的检查：

- 只允许 JSON 对象，深度 ≤ 16，标量值；
- 递归拒绝 `argv/cmd/command/executable/powershell/script/shell/ssh/terminal` 等键；
- `dsh.workflow.run` 只接受 `prompt`、`session_key`、`timeout_seconds`，未知键拒绝；
- `prompt` 非空、无 NUL、长度受限；
- `session_key` 格式受限，默认必填。

### 5. 会话隔离

会话 ID 由以下内容的 SHA-256 前缀生成：

```
origin（若服务端提供，AstrBot UMO）
 \n session_key
```

若服务端不提供 `origin`，则只使用 `session_key`。不同 QQ 用户不会共享 Agent 上下文的前提是服务端为每个用户/会话生成稳定且不冲突的 `session_key`；客户端默认拒绝缺失 `session_key` 的任务。仅依赖模型生成的 `session_key` 时，仍存在用户诱导碰撞的残余风险，应在 AstrBot 侧根据真实用户身份派生该值（见 `docs/PROTOCOL.md` 联调问题 4）。

### 6. 网络

- 默认只允许 loopback `baseUrl`，防止误把任务发到公网；
- 不监听端口；
- 不使用 GUI 的内部 RPC，不暴露 `60236`；
- 使用现有 SSH 隧道，不修改 SSH 配置、防火墙或新增公网端口；
- HTTP 客户端 `redirect: 'error'`，避免被重定向到非预期主机；
- 响应体有大小上限，读取过程流式计数。

### 7. 凭据

- 插件配置只保存 credential ref 名称；
- 密钥从 `ctx.credentials.resolve()` 或环境变量读取；
- 日志启动时注册 secret 并做脱敏，同时屏蔽 `Bearer ...` 与 `X-API-Key` 值；
- 不记录 prompt、结果文本、屏幕内容；
- 401/403 时立即失效内存缓存，下一轮重新解析。

## 传输安全

服务端**不签名响应**。客户端能验证的是：

- TLS/SSH 隧道的机密性与完整性；
- 响应信封的 `protocol`、`ok`、`data/error` 形状；
- 错误码与 `retryable`。

客户端**不能**验证响应确实来自持有共享 secret 的服务端。若隧道被本机恶意进程劫持，攻击者可以伪造响应。缓解措施是只监听 `127.0.0.1`、限制本机进程权限、使用独立隧道端口。若未来需要端到端响应认证，应升级协议并加入服务端签名。

## 数据落盘

DSH 会话是持久化的。Bridge 任务会把以下内容写入会话日志：

- 用户消息（即服务端 prompt）；
- Agent 的 assistant 消息、工具调用参数与工具结果（`read` / `write` / `edit`）；
- turn 状态。

这意味着：

- 有审计价值；
- 也可能把 QQ 用户的敏感内容写到本机磁盘；
- 会话按 `idleDisposeMs` 回收的是 Agent 实例，不一定是磁盘记录。

如果合规要求“不落盘”，需要在 DSH 会话持久化层处理，而不是在本插件里删除日志。

## 资源限制

| 限制 | 默认 |
| --- | --- |
| 并发任务 | 1 |
| 本地队列 | 1 |
| prompt 字符数 | 8000 |
| 请求体 | 256 KiB |
| 结果体 | 256 KiB |
| 响应体 | 1 MiB |
| 单任务超时 | 30 s（服务端可到 120 s） |
| 待回传结果 | 50 条 / 10 分钟 |
| Bridge 会话 | 64 个，空闲 30 分钟回收 |

## 已知风险

1. **Prompt 注入仍可能泄露上下文或改写工作区文件**
   文件工具不等于任意命令执行，但模型可以读取工作目录内的文件，也可以创建/覆盖文件。Agent 的系统提示、工作目录说明、项目规则可能包含本机信息；恶意 prompt 可能诱导模型复述或写入。不要把敏感信息放进 Bridge 会话可见的工作目录/规则文件。

2. **服务端被攻破**
   攻击者可以消耗本机 Agent 配额、诱导模型输出、探测会话上下文。防护是能力白名单和会话隔离，不是“完全无影响”。

3. **响应未签名**
   见“传输安全”。

4. **进程崩溃丢失待回传结果**
   结果队列在内存中，只有正常 `stop()` 会尽力 flush。DSH 崩溃/断电会丢失已完成但未回传的结果；服务端会按自己的超时处理。

5. **会话复用**
   同一 `session_key` 的后续任务会看到之前任务的上下文。这是有意的多轮体验，也意味着服务端必须正确划分 `session_key`。

6. **审批 `never` 导致功能受限**
   需要审批的动作会失败。这是安全默认值，不应为了跑通而改成自动批准。

7. **依赖 DSH 内部 API**
   `ctx.agents.create/resume`、`agentPresets.mount`、`tools.restrict`、`permissionPresets.set`、`setApprovalPolicy` 以及会话事件格式属于 DSH 内部接口，版本升级可能变化。`dsh.compatibility.dshReleases` 目前只声明 `0.2.2-rc.1`。

8. **版本兼容**
   已在 DSH 0.2.2-rc.1 隔离 Host 中验证真实 `tool/call`、`tool/result`、重启后同一 session 恢复与工具错误回传。preset 名称和文件工具集合由 DSH 部署决定；若 profile 没有 `standard` preset，需要在 `agent.preset` 显式指定，或由 `agent.tools` 配置匹配实际可用工具。

## 事件日志中不应出现的内容

- `FEIYU_BRIDGE_SECRET`、`FEIYU_ASTRBOT_API_KEY` 的明文；
- 完整 prompt / 完整结果；
- 屏幕截图、文件内容；
- 任何 API key / Bearer token。

`createLogger` 会对已注册 secret、`Bearer ...` 和 `X-API-Key` 值做替换；新增日志字段时需要继续遵守这条规则。
