# 伴游机器人任务降级

景区把伴游机器人的地图、讲解、天气与人工接管组织成可恢复任务。

`fixtures/robot_mission.json` 保存一条经过脱敏的业务样例。每条路线段、讲解内容、暴雨与高温限制、电量策略、安全区域和人工责任都带因果序号（`seq`）与有效期（`valid_from`/`valid_until`）。

## 迁移说明（revision 1 → 2）

- envelope 字段（`schema_version`/`record_id`/`domain`/`occurred_at`/`revision`/`source`）含义不变，`revision` 升为 2；
- 变更是纯追加：新增 `mission` 段，revision 1 的消费者可整体忽略它；
- 新增设备模式枚举：`AUTO` / `WAIT_IN_PLACE` / `PAUSED` / `DETOUR` / `HUMAN_TAKEOVER`，由 `src/stateMachine.js` 归约产生，不落库到合同文件。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/contracts.js` | 数据合同校验（`loadRecord` 保持最小合同，`loadMission` 校验完整任务） |
| `src/eventLog.js` | 因果事件日志：重复 `event_id`、乱序 `causal_seq`、超过 `valid_until` 的消息一律拒绝，设备状态不倒退 |
| `src/stateMachine.js` | 降级状态机：定位置信不足/电量不足 → 就地等待；传感器异常/暴雨停运 → 暂停；游客求助 → 人工接管；道路封闭 → 可说明的绕行 |
| `src/runtime.js` | 日志 + 状态机的写入路径 |
| `src/offlineBuffer.js` | 边缘离线缓冲：离线只存业务摘要；对话与影像按各自授权留存与同步，恢复联网不扩大用途 |
| `src/replay.js` | 控制台重放与事故报告：按发生时的地图/内容版本复盘，回答“哪一处降级、谁负责后续”，不依赖设备当前状态 |
| `src/server.js` | 可独立运行的 HTTP 后端（仅 Node 标准库） |

## 接管与讲解去向

一次接管完整记录：谁确认（`takeover_confirmed.operator`）、自动任务停在哪条路段（`stopped_segment`）、何时经过哪个新检查点恢复（`takeover_resumed.checkpoint_id`）。恢复点之前被绕过的讲解标记为 `skipped`（含决定人），恢复点之后的回到 `pending`——未完成讲解不允许悬空。

## 本地检查与运行

```bash
npm test          # 31 个用例
npm start         # http://localhost:8080（PORT/MISSION_PATH 可覆盖）
```

主要接口：`GET /mission` `GET /state` `POST /events` `GET /events` `GET /timeline` `GET /incidents` `GET /console` `POST /buffer` `POST /sync`。
