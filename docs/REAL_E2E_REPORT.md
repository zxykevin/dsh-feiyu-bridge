# Feiyu Bridge 真实跨系统 E2E 报告

日期：2026-11-04  
协议：`feiyu-bridge/1`  
服务端：`astrbot_plugin_feiyu_bridge v0.1.2-dev`  
客户端：`dsh-feiyu-bridge 0.1.0`，隔离 `feiyu-dev` profile  
AstrBot：4.29.4

## 隔离拓扑

```text
DSH feiyu-dev
  -> http://127.0.0.1:16187
  -> SSH local forward
  -> VPS 127.0.0.1:16187
  -> 临时 AstrBot 容器 6185
```

本机现有生产 `6185` 隧道未改动。临时 AstrBot 使用独立容器数据层、独立
1 日 API Key、随机 HMAC secret、独立 client ID 和测试控制令牌。服务端只
启用了 `dsh.status.read` 与 `dsh.workflow.run`。

## 验收结果

| 项目 | 结果 | 证据 |
|---|---|---|
| 双重认证与心跳 | 通过 | 无 API Key 返回 HTTP 401；有效客户端在线，能力交集为两个固定 capability |
| 真实 Agent 推理 | 通过 | 首轮任务 `succeeded`，实际回复 `BRIDGE_E2E_TURN1`，turn=1 |
| 同会话上下文复用 | 通过 | 相同 session key 的第二轮正确复述 `BRIDGE_E2E_TURN1`，turn=2 |
| 不同会话隔离 | 通过 | 新 session key 回复 `ISOLATED`，turn=1，无上一会话标记 |
| 结果幂等 | 通过 | 相同真实结果重试仍为 `succeeded`；冲突结果为 `TASK_ALREADY_TERMINAL` |
| 取消 | 通过 | 长生成任务先为 `leased`，取消后真实终态为 `cancelled` |
| 超时 | 通过 | 2 秒 deadline 的长生成任务终态为 `timed_out` |
| 未授权请求 | 通过 | 缺失 API Key 与错误 E2E 控制令牌均返回 HTTP 401 |
| 断线重连 | 通过 | 隧道断开 35 秒后 `online=false`；恢复后 `online=true` 且心跳年龄约 0 秒 |
| Windows 离线降级 | 通过 | DSH Host 停止后 Bridge 离线，AstrBot HTTP 仍返回 200 |
| 生产隔离 | 通过 | 未挂载或修改生产数据；生产 AstrBot/NapCat 未重启 |

## 有效竞争记录

第一次取消尝试中，短任务在下一次心跳看到取消前已经完成，因此合法终态是
`succeeded`。该结果没有计为取消通过。随后使用长生成任务重试，确认任务在
`leased` 后收到取消并最终进入 `cancelled`。这验证了“先到达的合法终态获胜”
以及真实 Agent cooperative abort 路径。

## 自动化回归

- 服务端 Python：52/52 通过。
- Windows Client Node.js：58/58 通过（当前套件；本次联调基线为 51 项）。
- AstrBot 4.29.4 运行时探针：`ASTRBOT_RUNTIME_PROBE_OK`。

## 剩余风险

- 本次任务由仅存在于隔离容器的 E2E Driver 注入，因为隔离 AstrBot 不连接生产
  NapCat；真实 QQ → `dsh_execute` 的事件来源校验已由服务端测试覆盖，但完整 QQ
  入站链路仍需部署前单独验收。
- 取消通知依赖 5–10 秒心跳。很短的 Agent 任务可能在看到取消前自然完成，这属于
  已定义的终态竞争，而不是强制抢占保证。
- DSH Agent provider/model 的可用性仍依赖本机账号状态和上游服务。
- 未验证 Host/系统重启后的未完成任务恢复；服务端队列当前为内存状态。

## 清理与凭据

测试凭据未提交仓库，Bridge/API Key 未写入测试报告。临时 API Key 的生命周期为
1 日，隔离容器销毁后其数据库一并销毁。测试完成后停止 DSH Host、SSH 测试隧道
和临时容器，并逐项删除临时凭据与日志文件。

## 后续复验

2026-11-04 晚对隔离环境执行了只读检查，并在用户批准后补跑心跳、真实 Agent、
取消、超时和离线降级。该次复验时容器与隧道仍在运行，记录见
[`RECOVERY_RECHECK.md`](./RECOVERY_RECHECK.md)。
