# 隔离环境恢复复验记录

日期：2026-11-04 22:30–22:38  
范围：只读检查 + 用户批准的关键验收项补跑  
环境：`feiyu-bridge-cross-e2e` 容器、`127.0.0.1:16187` SSH 隧道、隔离 `feiyu-dev` DSH Host

## 只读检查结果

| 项目 | 结果 |
|---|---|
| 隔离容器 | `feiyu-bridge-cross-e2e`，检查时 `Up 19 minutes` |
| 端口映射 | `127.0.0.1:16187 -> 6185/tcp` |
| SSH 隧道 | 仍在运行，PID 41696，`-L 16187:127.0.0.1:16187` |
| Bridge 状态端点 | HTTP 401 `Missing API key`，服务端在线 |
| 测试凭据 | 临时文件 `%TEMP%\feiyu-cross-e2e.secrets.json` 存在，DPAPI 加密 |
| `.credentials.yaml` refs | 不存在；仅 `version` 与 `records` |
| feiyu-dev Host | 已停止，6198 无监听 |

临时凭据文件包含 `api`、`bridge`、`control` 三个加密字段，以及
`base_url`、`container`、`tunnel_pid`、`dsh_pid`。凭据在本次复验中仅于
Host 进程环境内解密使用，没有写入仓库、报告或日志。

## 补跑结果

启动隔离 Host 时通过进程环境变量注入
`FEIYU_BRIDGE_SECRET` 与 `FEIYU_ASTRBOT_API_KEY`，未修改
`.credentials.yaml`，未修改 desktop profile。

| 项目 | 结果 | 证据 |
|---|---|---|
| 心跳恢复 | 通过 | 启动后 `online=true`、`state=online`、心跳年龄约 5.3s |
| 真实 Agent 往返 | 通过 | 任务 `succeeded`，回复 `RECOVERY_OK`，turn=1 |
| 取消 | 通过 | 长任务 `leased` 后取消，终态 `cancelled` |
| 超时 | 通过 | `timeout_seconds=2` 的长任务终态 `timed_out` |
| Host 离线判定 | 通过 | Host 停止 40.5s 后 `online=false`、`state=offline` |
| AstrBot 不受影响 | 通过 | Host 离线期间 AstrBot 根路径仍返回 HTTP 200 |

## 当前状态

- feiyu-dev Host 已停止。
- 隔离容器和测试 SSH 隧道仍在运行，未销毁、未重新部署。
- desktop profile 未修改。
- 未创建公网监听。
- 未重跑 Codex 已覆盖的完整 E2E；本次仅补跑心跳、Agent、取消、超时和离线降级。

## 仍未覆盖

- 真实 QQ 入站到 `dsh_execute` 的完整链路（隔离 AstrBot 不接生产 NapCat）。
- Host/系统重启后的未完成任务恢复（服务端队列为内存状态）。
- 容器和临时凭据的最终清理需要单独决定。
