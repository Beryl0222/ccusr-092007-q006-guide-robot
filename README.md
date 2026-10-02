# 伴游机器人可恢复任务后端

景区伴游机器人（地图平台、讲解团队、设备端、值班调度）共用的**事件溯源**任务后端。
核心目标：通信恢复后，机器人**不会**沿旧地图突然继续前进——过期、重复、乱序的消息
不能让设备状态倒退；每一次降级、每一条未完成讲解、每一次人工接管，都能用**发生当时的
地图与内容版本**完整重放。

`fixtures/robot_mission.json` 在保留 v1 身份字段（`record_id`/`domain`/`occurred_at`）
的前提下扩展到 schema v2；新增状态均通过带因果序号与有效期的事件迁移。

## 本地检查

```bash
npm test     # 35 个单元/集成测试
npm run demo # 跑完一日完整场景（56 项断言），事件落盘到 ./data
```

## 控制台

```bash
node src/console.js demo                  # 生成一日事件日志 data/event-log.jsonl
node src/console.js status                # 当前模式/版本/进度/生效降级/接管
node src/console.js events                # 带因果链的完整时间线
node src/console.js replay 2026-09-20T09:37:30+08:00   # 按历史时点复盘（JSON）
node src/console.js takeovers             # 接管台账：请求/确认/冻结/讲解去向/恢复
node src/console.js rejections            # 接入拒绝 + 授权越权审计
```

数据目录可用 `GR_DATA_DIR` 覆盖。

## 消息合同（每条指令都是事件信封）

| 字段 | 含义 |
| --- | --- |
| `message_id` | 全局唯一，**重发同一 ID 直接去重**，不会执行两次 |
| `source` / `seq` | 来源（cloud/route/guide/device/operator/…）内**连续单调**序号；旧序号判 `stale`，跳号判 `gap` |
| `causal_prev` | 直接前因消息 ID，跨来源因果链；前因未知判 `orphan` |
| `occurred_at` | 事件发生时间，复盘以此为准，而非设备当前状态 |
| `valid_from` / `valid_to` | 业务有效期；接收时已过期判 `expired` |

每条路线段、讲解、天气限制、电量门槛、安全区、值班责任都带 `seq` 与有效期。
被拒消息不应用、不落主日志，只写旁路审计，设备状态保持不变（接入采用克隆提交，
校验失败不留半成品）。

## 四类现场情况 → 处置策略

| 情况 | 动作 | 责任角色 |
| --- | --- | --- |
| 定位置信不足（<0.75） | `hold_in_place` 就地等待 | 设备工程师 |
| 安全传感器异常 / 暴雨橙色 / 电量不足 / 无路可绕 | `suspend` 暂停 | 工程师 / 安全员 |
| 游客求助 | `manual_takeover` 人工接管 | 值班调度员 |
| 道路封闭 / 高温（绕行边在当前地图真实存在且未封闭） | `detour` 可说明绕行 | 调度员 / 安全员 |

优先级：人工接管 > 暂停 > 就地等待 > 绕行。定位差时不许绕行，传感器故障时不许自动行驶；
成因消除后同一决策自动 `cleared`，变化（如"暂停→绕行"）是带 `amend` 的同一条决策，
可追溯，不会冒出无出处的新状态。

## 人工接管的完整可重放链路

`requested`（双人之一请求）→ `confirmed`（**必须另一个人**确认）→ `frozen`（冻结点：
路线段、检查点、地图/路线/内容版本三元组、当时挂起指令、所有未完成讲解）→
每条未完成讲解必须显式给出去向：

- `defer_to_checkpoint` 推迟到某检查点续讲（如望春桥讲解 N-BC 推迟到 D）
- `resume_from_checkpoint` 检查点续讲
- `manual_continue` 人工接续 / `abandon` 放弃（销账）
- `replaced_by` 由新讲解替代（如新路线不再经过暴晒段，N-FD → N-XD）

恢复自动任务必须：① 恢复闸门确认所有降级成因已消除；② 设备上报位置 == 新检查点；
③ 设备自报 `observed_map_version` == 恢复计划版本，三者满足才放行。

## 边缘离线与授权最小化

游客对话（`visitor_chat`）与影像（`visitor_video`）是**两份独立授权**，各自有用途、
留存期与离线字段白名单：

- 离线只缓存业务摘要（求助标记、话题标签、帧哈希、障碍标记……），原始语音/帧字节
  **根本不写盘**；被剔除字段只审计字段名，不记值。
- 恢复联网上传必须声明用途；影像授权为"永不上云"，对话仅允许接管摘要等列明用途；
  试图用于营销画像等新用途直接拒绝——联网恢复不会顺带扩大用途。

## 历史复盘

`answerAt(asOf)` 把日志截至该时点重放，返回当时的控制模式、地图/路线/内容版本、
生效降级（含责任人）、接管快照与讲解去向。值班员事后复盘回答的是"**那时**哪里降级、
**谁**承担后续动作"，不需要、也不允许参考设备此刻的状态去猜历史。

## 代码结构

```
src/
  clock.js     可固定的时钟与有效期判定
  events.js    事件信封、类型表、接入校验（重复/乱序/断链/过期）
  core.js      纯函数内核：applyEvent 折叠 + evaluate/derive 策略 + replay/answerAt
  privacy.js   授权白名单过滤（离线摘要 / 恢复上传）
  store.js     JSONL 只追加日志与旁路审计
  backend.js   门面：引导发布、在线版本、接管生命周期、边缘采集、查询
  scenario.js  一日完整场景（库函数，quiet 模式供测试复用）
  console.js   控制台命令
fixtures/
  robot_mission.json     schema v2：设备/任务标识与包引用
  packages/              maps / routes / contents / policy（均版本化、带有效期）
test/                    messaging · policy · takeovers · privacy · replay
```

内核是纯函数：给定事件序列与时点，结果唯一；这是"控制台完整重放"与"按历史版本复盘"
的基础。
