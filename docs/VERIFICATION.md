# 验证记录

最近更新：2026-11-05

## 验证环境

- Windows x64
- DSH Desktop `0.2.2-rc.1`（Electron 44.7.0）
- 当前 shell Node `v24.15.0`
- 工作目录 `C:\path\to\workspace`
- 生产 profile：`%USERPROFILE%\.dsh\profiles\desktop`
- 本轮隔离 profile：`%USERPROFILE%\.dsh\profiles\feiyu-verify`
- 隔离 Host：`127.0.0.1:6198`
- Mock Server：`127.0.0.1:6200`（脚本 `tmp_mock_verify.mjs`，验证后已删除）
- 本轮未修改 VPS 上的 AstrBot 插件，未启动第二个桌面 GUI，未新增公网监听

`feiyu-verify` 从 `web` 模板创建，使用官方 CLI 安装本插件：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& '<DSH_HOME>\DeepSeek Harness.exe' '<DSH_HOME>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile feiyu-verify --from-default-profile web
& '<DSH_HOME>\DeepSeek Harness.exe' '<DSH_HOME>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' plugin --profile feiyu-verify add 'C:\path\to\dsh-feiyu-bridge'
```

## 自动化测试

```powershell
cd 'C:\path\to\dsh-feiyu-bridge'
npm test
```

结果：**79/79 pass**（`node --test --test-isolation=none "test/**/*.test.js"`，约 7 秒）。

> Windows 沙箱下 Node 测试运行器的子进程管道会触发 `spawn EPERM`，因此脚本固定使用 `--test-isolation=none`，在当前进程内运行全部测试文件。

| 测试文件 | 覆盖内容 |
| --- | --- |
| `test/unit/config.test.js` | 默认值、AstrBot 路由、未知键、loopback、URL、心跳/lease 边界、密钥长度、高风险工具、`permissionPreset`、模型路由成对校验 |
| `test/unit/protocol.test.js` | 任务 UUID/时间归一化、capability 与参数 denylist、深度与非 JSON 值、envelope、UTF-8 截断 |
| `test/unit/auth.test.js` | 六行签名串、秒级时间戳、nonce、凭据引用/缓存/开发回退/缺失失败 |
| `test/unit/dispatcher.test.js` | 单并发 FIFO、幂等重放、过期、未知能力、队列满、排队/执行中取消、超时、shutdown、结果过大 |
| `test/unit/agent-adapter.test.js` | fake `ctx.agents`：v2 会话创建 + preset 挂载 + 默认 `restrict({allow:['read','write','edit']})`、审批 `never`、GUI 放宽沙箱后的回收、显式 `danger-full-access` + `pwsh` 的固定与不可收窄、重启恢复最新 generation、归档/缺失重建、`cwd` 缺失失败关闭、preset 缺失/不匹配、BUSY、真实 `tool/call`/`tool/result` 提取、工具失败与 DSML 误判、取消、失败 turn 映射、模型路由透传、稳定标题 |
| `test/unit/http-transport.test.js` | AstrBot 401 `{status,message}` 映射、桥接 409 envelope 保留 code/message/retryable、`X-API-Key` 与 HMAC 头（禁止 Bearer） |
| `test/unit/vectors.test.js` | 与 AstrBot 发布的固定 HMAC 向量逐字节一致 |
| `test/integration/hmac-vector.test.js` | 读取 `tests/vectors/hmac_v1.json`，验证 canonical/body hash/signature；Mock 端验证有效签名、篡改、过期、重放 |
| `test/unit/workflow-vector.test.js` | 读取服务端 `tests/vectors/workflow_v1.json`，验证合法租约参数被接受、缺少 `session_key`/带 `workflow` 字段/模型自选会话三类非法参数被拒绝 |
| `test/integration/runtime.test.js` | Mock + 真实 HTTP Transport + Runtime：状态读取、执行、未知能力、取消 + ack、deadline 超时、403 重连、错误密钥失败关闭 |
| `test/integration/plugin-entry.test.js` | `apply()` 装配与 `ctx.effect` 清理 |

## 插件入口冒烟

```powershell
node -e "import('./src/index.js').then(m => console.log(m.name, m.inject, typeof m.apply, typeof m.Config))"
```

结果：`dsh-feiyu-bridge [ 'agents', 'tools', 'approval', 'credentials', 'sessionPersistence', 'workspaceRegistry', 'agentPresets', 'sessionTitle', 'permissionPresets' ] function undefined`。

说明：普通 Node 下无法解析 `@deepseek-ai/schemastery`，因此 `Config` 为 `undefined`，这是预期降级；在 DSH Host 内由运行时解析。`apply`、`inject`、`name` 三个 Cordis 必需导出均可用。

## 真实 Cordis 运行时挂载

使用 DSH 自带的 Cordis 4.1.0，在 `ELECTRON_RUN_AS_NODE` 模式下以 fake services 挂载插件（不启动 GUI、不读取 desktop profile）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& '<DSH_HOME>\DeepSeek Harness.exe' 'C:\path\to\dsh-feiyu-bridge\tools\mount-cordis.mjs'
```

结果：

```json
{"mounted":true,"name":"dsh-feiyu-bridge","inject":["agents","tools","approval","credentials","sessionPersistence","workspaceRegistry","agentPresets","sessionTitle","permissionPresets"],"effects":true}
```

## 2026-11-05 会话生命周期与真实工具复验

隔离 profile `feiyu-verify` 配置：

```yaml
- id: dsh-feiyu-bridge
  name: dsh-feiyu-bridge
  config:
    server:
      baseUrl: 'http://127.0.0.1:6200/feiyu-bridge/'
    auth:
      clientId: windows-dsh-verify
      bridgeSecret: 'mock-bridge-secret-0123456789abcdef'
      apiKey: 'abk_mock_openapi_key_1234567890'
    agent:
      cwd: 'C:/path/to/workspace'
      preset: standard
      tools: [read, write, edit]
      provider: deepseek-account
      model: deepseek-flash
      reasoningEffort: low
    logging:
      level: debug
```

### 真实工具调用

任务 `9a62d60a-3fbb-4088-8b3a-b710ee3b4e5a`（`session_key: verify-tools-4`）要求用 `write` 创建文件，返回：

```text
Created the file.

- Absolute path: C:\path\to\workspace\dafeiyu_first_note.txt
- File size: 31 bytes
```

文件实际存在，长度 31，内容 `Feiyu bridge real tool test OK.`。

解码会话 `feiyu-bridge-v2-c66f1b476d961bb4487eac2f`（16 个 zstd frame、36 条记录）确认是真实执行而非文本声称：

| seq | 事件 | 内容 |
| --- | --- | --- |
| 20 | `tool/call` | `write`，callId `call_00_rjvh2NolhgRGbpqDaBZK1246` |
| 21 | `tool/result` | `isError:false`，带路径元数据，`sourceEventSeqs:[20]` |
| 26 | `tool/call` | `read` |
| 27 | `tool/result` | `isError:false`，读回 1 行内容 |
| 34 | `turn/end` | `{"kind":"completed"}` |

第一轮真实任务曾经失败，错误为：

```text
CONFIG_ERROR: tools.restrict() names unknown global tools "read", "write", "apply_patch", "edit"; known global tools: working_directory
```

根因是 DSH 文件工具位于 agent preset 的 scope，不在根级 `tools` 注册表。修复为先 `agentPresets.mount(agentCtx, presetId)`，再 `agentCtx.tools.restrict(...)`，并在创建会话时把 `agentPreset` 写入 header。

### 会话持久化与重启恢复

任务 `4c2be191-0b34-4ff0-85a0-eeee50593712`（`session_key: verify-persist-1`）返回 `PERSIST_ONE`，turn 1。会话 header：

```json
{"type":"session","version":4,"id":"feiyu-bridge-v2-c8682d8ad4aaf5a8422c7d81","createdAt":1793837537109,"cwd":"C:/path/to/workspace","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

它位于工作区目录 `<workspace-session-dir>`，而不是 `_no-cwd`。

重启 Host 后，同一 `session_key` 的任务 `0ddea7af-a9c5-4dbf-b89b-eb949ea90954` 返回 `PERSIST_TWO`，`turn: 2`；session id 不变，未创建 `-g1`。

### 权限与沙箱边界

Bridge 会话可以在 GUI 中打开，因此 UI 的权限选择器可能改变该会话的权限。工具名白名单只能阻止未授权工具，不能阻止白名单内的 `write` 在 full-access 下写出工作区，所以 Bridge 在每个任务开始前执行：

```js
permissions.set(session, config.agent.permissionPreset);
// permissionPresets.set 会把 approval 重置为 ask，随后必须重新固定 never
setApprovalPolicy(session, 'never');
```

`permissionPresets` 不可用时失败关闭（`GUARD_UNAVAILABLE`），不会在无法确认沙箱的情况下执行任务。默认 `permissionPreset` 是 `workspace-write`；对应测试 `a permission preset widened in the GUI is pinned back before the next bridge task` 验证 GUI 放大后会被收回。生产 desktop profile 显式配置为 `danger-full-access`，对应测试 `a configured danger-full-access sandbox is pinned and cannot be narrowed by the GUI` 验证该模式会被主动固定，且 GUI 收窄也会被覆盖。因此 Bridge 工具白名单、审批策略和文件沙箱三层都与 UI 的当前选择解耦，但 full-access 是有意关闭文件边界的高风险配置。

隔离 `feiyu-verify` Host 上的真实全权限任务 `492cd4f7-bd19-4d83-83f8-167bbd860898`（`session_key: verify-full-1`）要求用 `pwsh` 写入工作区外的 `%TEMP%\feiyu_full_access_probe.txt`，再读回内容。返回 `succeeded` / `FULL_ACCESS_OK`，文件长度 16。解码会话 `feiyu-bridge-v2-eb771dc26fbe475599888812` 可见：

```text
seq 5  permission/preset danger-full-access
seq 6  sandbox/mode danger-full-access
seq 20 tool/call   pwsh Set-Content ...
seq 23 tool/result isError=false "(no output)"
seq 28 tool/call   pwsh Get-Content ...
seq 31 tool/result isError=false "FULL_ACCESS_OK\r\n"
seq 37 turn/end    completed
```

这证明 `pwsh` 不是模型文本模拟，而是真实的 `tool/call` → `tool/result`；同时证明 full-access 下可以写出 `agent.cwd`。生产 desktop 重启加载 `0.3.0` 后才使用同一配置。

### 会话标题

任务 `43908e8a-03cc-4bba-aee1-f51282bbb490`（`session_key: verify-title-2`）创建会话 `feiyu-bridge-v2-f014fef8a931ce4c9ae8f9b0`。解码 seq 3 得到：

```json
{"title":"Feiyu Bridge verify-title-2","messageSeqs":[],"source":{"kind":"user"}}
```

标题不再沿用旧的 `Reply with DEPLOY_OK only`，也不是首轮 prompt 自动标题。`feiyu-bridge-v2-f014fef8a931ce4c9ae8f9b0` 在 Host 重启后继续 turn 2（任务 `e1ad1068-cdb9-410c-8c80-ed5379c2dca7`），标题保持不变。

### 工具错误回传

任务 `4191ee39-57ec-406c-82ca-c320aadb5a0c`（`session_key: verify-tools-err`）要求读取不存在的文件。返回：

```text
state: failed
code: AGENT_ERROR
message: tool "read" failed (FS_NOT_FOUND); the task produced no usable answer
retryable: true
```

失败的 `tool/result` 不会被最终文本掩盖为成功。

### DSML 伪工具调用

单元测试覆盖：

- `raw DSML transcript is rejected as a non-executed tool call`
- `an earlier DSML attempt is not hidden by a clean final sentence`

模型如果在任一 assistant 消息中输出 `<||DSML|| ...>` / `<｜｜DSML｜｜ ...>`，Bridge 返回不可重试的 `AGENT_ERROR`，不把文本当作执行成功。

## 历史验证（2026-11-04）

- 隔离 profile `feiyu-dev`，Host `127.0.0.1:6198`，Mock `127.0.0.1:6199`。
- 验证心跳、`dsh.status.read`、`dsh.workflow.run`、同 `session_key` 上下文复用、不同 key 隔离、服务端取消、deadline 超时、断线重连、Host 停止后的离线判断、错误 API key 失败关闭。
- 首次 `dsh.workflow.run` 因空会话没有模型选择失败，错误为 `agent "<id>" has no provider/model`；通过 `agent.provider` / `agent.model` / `agent.reasoningEffort` 与 `agentOptions` 透传修复。
- 真实隔离 AstrBot 4.29.4 跨系统 E2E 见 [`REAL_E2E_REPORT.md`](REAL_E2E_REPORT.md)；恢复复验见 [`RECOVERY_RECHECK.md`](RECOVERY_RECHECK.md)。

## 生产部署（2026-11-04）

- 服务端：AstrBot 4.29.4 + `astrbot_plugin_feiyu_bridge v0.1.2-dev`；`client_id=windows-dsh`；`allowed_capabilities` 为 `dsh.status.read`、`dsh.workflow.run`；`authorized_sender_ids` 保持原有一个账号。
- Windows：通过 `plugin_manager install_bundle` 安装到 desktop profile；配置经 `cordis.patch.yml` 注入 `baseUrl`、`clientId`、`provider/model`；凭据只写入 `.credentials.yaml` 的 `refs`。
- 生产本地转发：`127.0.0.1:6185 -> VPS 127.0.0.1:6185`；该转发不是插件的一部分，需要独立保持运行。
- 验收：服务端 `online=true`，能力为两项；授权 QQ 的 `dsh_execute` 返回 `DEPLOY_OK`。
- 回滚备份：服务端配置 `.bak-deploy-20261104-2305`；desktop profile 备份在 `%USERPROFILE%\.dsh\backups\feiyu-deploy-20261104\`；凭据文件备份为 `.credentials.yaml.bak-feiyu-deploy-20261104`。

## 尚未验证

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 真实 QQ / NapCat 触发 `dsh_execute` | 已验证 | 生产授权 QQ 已返回 `DEPLOY_OK` |
| Host 重启后的空闲会话恢复 | 已验证 | 2026-11-05 隔离 Host：同 `session_key` 重启后 turn 2，session id 不变，无重复 generation |
| Host 重启时正在执行的任务 | 未验证 | 只验证了空闲会话恢复；执行中崩溃/重启的未完成任务恢复仍需单独测试 |
| 生产长任务取消/超时复验 | 未验证 | 隔离环境已通过；生产仅验证了单轮 `DEPLOY_OK` |
| 真实工具调用 | 已验证 | 2026-11-05 隔离 Host：真实 `write` 创建 31 字节文件，`read` 读回；会话日志含 `tool/call` + `tool/result` |
| GUI 放宽 Bridge 权限后的沙箱回收 | 单元已验证 | 默认 `workspace-write` 下，会话被切到 `danger-full-access` 后，下一任务先固定回 `workspace-write` + 审批 `never`；尚未在真实 GUI 中手工切换复验 |
| 生产 `danger-full-access` + `pwsh` | 隔离已验证 | 隔离 Host 任务 `492cd4f7-bd19-4d83-83f8-167bbd860898` 已用 `pwsh` 写出并读回工作区外文件（`FULL_ACCESS_OK`，16 字节），事件含真实 `tool/call`/`tool/result`；生产 desktop 重启加载 `0.3.0` 后生效，这台机器将没有文件系统边界 |
| 服务端响应签名 | 不适用 | 协议未要求，客户端不校验 |

## 当前环境与凭据

- 生产凭据已写入 `.credentials.yaml` 的 `refs`（`FEIYU_BRIDGE_SECRET`、`FEIYU_ASTRBOT_API_KEY`），未写入插件配置、代码或 Git；部署前文件备份为 `.credentials.yaml.bak-feiyu-deploy-20261104`。
- 隔离测试使用的 DPAPI 凭据文件仍存在，不应提交、复制或贴入聊天；待清理测试容器时一并删除。
- desktop profile 已安装 `dsh-feiyu-bridge`；生产本地转发 `127.0.0.1:6185` 需要独立保持运行。
- 隔离测试容器与 `16187` 隧道仍在运行，按部署约定保留，生产验收通过后单独清理；当前没有公网监听。
- 2026-11-05 的 `feiyu-verify` Host、Mock 和临时探测脚本已停止/删除；desktop Host 尚未重启，因此生产仍加载旧版插件，重载/重启后 `0.3.0` 才生效。生产 profile 已显式配置 `danger-full-access` + `pwsh`，重启后该策略生效。
