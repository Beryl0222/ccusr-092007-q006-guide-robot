import { CausalEventLog } from './eventLog.js';
import { initialState, reduce } from './stateMachine.js';

/** 任务运行时：因果日志 + 状态机的组合，是后端的核心写入路径。 */
export class MissionRuntime {
  constructor(mission) {
    this.mission = mission;
    this.log = new CausalEventLog({ deviceId: mission.device.device_id });
    this.state = initialState(mission);
  }

  /**
   * 接入一条消息。过期、重复、乱序的消息在日志层被拒绝，
   * 被接受的消息才参与状态归约，设备状态因此不会倒退。
   */
  ingest(event, receivedAt) {
    const result = this.log.append(event, receivedAt);
    if (!result.accepted) {
      return { ...result, state: this.state };
    }
    const { state, notes } = reduce(this.mission, this.state, event);
    this.state = state;
    return { accepted: true, notes, state };
  }
}
