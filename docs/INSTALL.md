# 安装与卸载

本插件是 **Cordis bundle**，必须由 DSH 的插件管理流程安装，不能把文件复制进 `app.asar`，也不能手工改正在使用的 desktop profile。

## 前置条件

- DSH Desktop 版本 `0.2.2-rc.1`（`package.json` 的 `dsh.compatibility.dshReleases` 已声明）。
- 现有 SSH 隧道把 VPS AstrBot 的 6185 转发到本机 `127.0.0.1:6185`。隧道本身不属于本插件，插件不会修改 SSH 配置。
- AstrBot 侧已安装并配置 `astrbot_plugin_feiyu_bridge`：
  - `client_id = windows-dsh`
  - `bridge_secret` >= 32 字符，且与 Windows 端一致
  - `allowed_capabilities` 至少包含 `dsh.status.read` 和 `dsh.workflow.run`
  - `authorized_sender_ids` 非空
- 已创建 AstrBot OpenAPI Key，scope 包含 `plugin`。

## 安装到当前 profile（推荐）

安装会修改 profile，属于需要明确批准的操作。

1. 在 DSH 会话中请求安装 bundle，目标为绝对路径：

   ```
   C:\path\to\dsh-feiyu-bridge
   ```

   对应操作是 `plugin_manager` 的 `install_bundle`，`target` 为该路径。不要手工编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`。

2. 安装完成后**重启 DSH**。插件在 `apply()` 中启动运行时，没有单独的启动命令。

3. 为插件条目设置配置。配置对象可以直接使用 [CONFIGURATION.md](CONFIGURATION.md) 中的 JSON；最小配置只需要 `baseUrl`、`clientId` 和两个 credential ref。插件 `Config` 是 `schemastery` 的 any 对象，因此不会强改字段名，但运行时仍会严格校验。

4. 提供两个凭据（不要写进插件配置）：

   ```yaml
   # %USERPROFILE%\.dsh\.credentials.yaml
   refs:
     FEIYU_BRIDGE_SECRET: "0123456789abcdef0123456789abcdef"
     FEIYU_ASTRBOT_API_KEY: "abk_xxxxxxxxxxxxxxxxxxxxxxxx"
   ```

   或者设置同名环境变量后重启。凭据文件权限应仅限当前用户。

5. 检查日志。正常启动应出现 `feiyu bridge plugin loading`，随后是心跳/租约相关日志；日志中的 secret 与 API key 必须是 `***` 或被完全省略。

## 隔离 dev profile（已验证）

不要为了试装去修改正在使用的 desktop profile。`plugin_manager` 只作用于当前会话的 profile；如需在另一个 profile 中验证，使用官方 CLI：

```powershell
$dsh = '<DSH_INSTALL>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
$env:ELECTRON_RUN_AS_NODE = '1'

# 1. 从 web 模板创建隔离 profile
& '<DSH_INSTALL>\DeepSeek Harness.exe' $dsh --profile feiyu-dev --from-default-profile web --dump-config

# 2. 安装本插件（使用绝对路径）
& '<DSH_INSTALL>\DeepSeek Harness.exe' $dsh plugin --profile feiyu-dev add 'C:\path\to\dsh-feiyu-bridge'

# 3. 启动隔离 Host，不要和 desktop GUI 共用端口
& '<DSH_INSTALL>\DeepSeek Harness.exe' $dsh --profile feiyu-dev --port 6198 --no-open
```

隔离 profile 的插件配置写在 `%USERPROFILE%\.dsh\profiles\feiyu-dev\cordis.patch.yml`。若使用 Mock，把 `server.baseUrl` 指向 `http://127.0.0.1:6199/feiyu-bridge/`，并填入 Mock 的测试密钥；同时按需配置 `agent.provider` / `agent.model`，否则新建空会话会因没有模型选择而失败。

该流程已在本机验证：插件在隔离 Host 中完成心跳、`dsh.status.read`、`dsh.workflow.run`、取消、超时与重连测试，desktop profile 未被修改。测试细节见 `docs/VERIFICATION.md`。

## SSH 转发（不属于插件）

插件只连接 `server.baseUrl`，不建立、不管理也不修改 SSH 隧道。请自行把 VPS 上的 AstrBot 插件路由转发到本机 loopback（例如 `127.0.0.1:6185`），并保证该端口只对本机开放。

不要把隧道脚本、VPS 地址、SSH 用户名、私钥或生产凭据提交到本仓库；仓库的 `.gitignore` 已排除 `scripts/feiyu-tunnel.*`，本地部署脚本应按需自行保留。

## 卸载

1. 在 DSH 中请求移除 bundle，target 为 `dsh-feiyu-bridge`（`plugin_manager` 的 `remove_bundle`）。
2. 重启 DSH。
3. 可选清理：
   - 从 `.credentials.yaml` 删除 `FEIYU_BRIDGE_SECRET` / `FEIYU_ASTRBOT_API_KEY`；
   - 删除 dev profile 目录 `%USERPROFILE%\.dsh\profiles\feiyu-dev`（如果创建过）。

卸载不会删除 DSH 中已经产生的 Bridge 会话记录。若需要清理会话，按 DSH 的会话管理方式处理，不要直接删 `sessions` 文件。

## 升级

用同一路径重新执行 `install_bundle`，然后重启 DSH。升级前确认 `dsh.compatibility.dshReleases` 仍覆盖当前 DSH 版本；本版本只声明了 `0.2.2-rc.1`。

## 回滚

1. `remove_bundle` 移除本插件；
2. 重启 DSH；
3. 恢复上一版本的 bundle 安装。

插件不修改 DSH 核心、`app.asar`、现有第三方插件、系统防火墙、SSH 配置或 AstrBot 配置，因此回滚只需移除本 bundle。

## 常见问题

**启动即报 `server.baseUrl` 非 loopback**

默认只允许 loopback。经 SSH 隧道访问时地址是 `127.0.0.1`；如果确实要直连远端，显式设置 `server.allowNonLoopback: true`，并优先使用 HTTPS。

**401 `Missing API key`**

请求没有到达 Bridge 的 HMAC 校验，而是被 AstrBot OpenAPI 中间件拦下。检查 `FEIYU_ASTRBOT_API_KEY` 是否存在、是否具备 `plugin` scope，以及请求头是否为 `X-API-Key`（本客户端固定使用该头，不再发送 Bearer）。

**`AUTH_CLIENT_REJECTED` / `AUTH_INVALID_SIGNATURE`**

检查三处一致：`clientId`、共享 secret、服务端 `client_id`/`bridge_secret`。签名时间戳是 Unix **秒**，允许 60 秒偏差。

**任务一直 `CAPABILITY_UNAVAILABLE`**

服务端 `allowed_capabilities` 为空，或没有包含客户端心跳上报的能力。至少配置 `dsh.status.read` 与 `dsh.workflow.run`。

**任务失败且错误提到 approval / blocked**

Bridge 会话审批策略固定为 `never`，任何需要人工批准的动作都会被拒绝。这是设计行为；不要为了跑通而改成自动批准。需要更宽范围的任务应先在本地实现为受控 capability，而不是放开 Bridge 会话工具。

**需要工具但报 `unknown global tool` / `no agent preset service`**

DSH 的文件工具位于 agent preset 内，不在全局 `tools` 注册表中。确认 profile 提供 `agentPresets` 服务，并设置 `agent.preset`（例如 `standard`）；Bridge 会先挂载 preset，再把工具收窄到 `agent.tools`（默认 `read` / `write` / `edit`）。如果当前 DSH 版本没有该 preset，改用部署中实际存在的 preset id，并保证 `agent.tools` 中的名称由该 preset 提供。

**Bridge 会话在 GUI 中点击后 `session/not-found`**

旧版 `feiyu-bridge-*` 会话没有写入 `cwd`，不会被 Workspace 索引。`0.2.0` 起使用 `feiyu-bridge-v2-*` 新命名空间并在创建时写入 `agent.cwd`；`0.3.0` 增加 `agent.permissionPreset`，旧会话不会被复用。确认 `agent.cwd` 是绝对路径，且 profile 的 `workspace`/`session-persistence-jsonl` 服务正常。若会话已归档，适配器会自动创建下一代 `-gN`。
