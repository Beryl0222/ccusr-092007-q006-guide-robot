/**
 * 事件信封与接入校验。
 *
 * 每条消息（无论来自地图平台 cloud、讲解团队 guide、设备 device 还是值班员
 * operator:*，以及后端派生的 scheduler 消息）都携带：
 *
 *   message_id  全局唯一，用于去重（重发同一指令不会被执行两次）
 *   source      来源标识，每个来源拥有独立的连续序号空间
 *   seq         来源内单调连续序号，旧序号到达即判定为乱序/陈旧
 *   causal_prev 直接前因消息的 message_id，构成跨来源因果链
 *   occurred_at 事件发生时间（复盘以此为准，而非设备当前状态）
 *   valid_from / valid_to 业务有效期；接收时已过期的消息直接拒绝
 *
 * 校验只在消息首次接入时执行；重放历史日志时跳过校验（事件在入链那一刻
 * 已被判定有效，复盘必须还原当时的结论）。
 */

export const T = Object.freeze({
  MISSION_LOADED: 'mission.loaded',
  MAP_PUBLISHED: 'map.published',
  ROUTE_PUBLISHED: 'route.published',
  CONTENT_PUBLISHED: 'content.published',
  CONSTRAINT_UPDATED: 'constraint.updated',
  SAFETY_ZONE_UPDATED: 'safety_zone.updated',
  DUTY_ASSIGNED: 'duty.assigned',
  AUTHORIZATION_PUBLISHED: 'authorization.published',

  POSITION: 'telemetry.position',
  BATTERY: 'telemetry.battery',
  SENSOR_STATUS: 'sensor.status',
  SENSOR_RESET: 'sensor.reset',
  WEATHER: 'weather.observed',
  ROAD_CLOSED: 'road.closed',
  ROAD_REOPENED: 'road.reopened',
  DETOUR_PLANNED: 'road.detour.planned',
  VISITOR_HELP: 'visitor.help',

  DECISION_DECIDED: 'degradation.decided',
  DECISION_AMENDED: 'degradation.amended',
  DECISION_CLEARED: 'degradation.cleared',
  COMMAND_ISSUED: 'command.issued',

  SEGMENT_STARTED: 'segment.started',
  SEGMENT_ADVANCED: 'segment.advanced',
  SEGMENT_COMPLETED: 'segment.completed',
  NARRATION_STARTED: 'narration.started',
  NARRATION_COMPLETED: 'narration.completed',

  TAKEOVER_REQUESTED: 'takeover.requested',
  TAKEOVER_CONFIRMED: 'takeover.confirmed',
  TAKEOVER_FROZEN: 'takeover.control.frozen',
  NARRATION_DELEGATED: 'narration.delegated',
  TAKEOVER_RESUME_PREPARED: 'takeover.resume.prepared',
  TAKEOVER_RESUMED: 'takeover.resumed',
  TAKEOVER_CLOSED: 'takeover.closed',

  CONNECTIVITY: 'connectivity.changed',
  EDGE_CAPTURE: 'edge.offline_capture',
  SYNC_UPLINK: 'sync.uplink',
  ACCESS_DENIED: 'access.denied',
});

/** 需要走策略引擎的观察/发布类事件（新地图或新路线可能让既有降级成立或解除）。 */
export const OBSERVATIONS = new Set([
  T.POSITION,
  T.BATTERY,
  T.SENSOR_STATUS,
  T.SENSOR_RESET,
  T.WEATHER,
  T.ROAD_CLOSED,
  T.ROAD_REOPENED,
  T.DETOUR_PLANNED,
  T.MAP_PUBLISHED,
  T.ROUTE_PUBLISHED,
  T.VISITOR_HELP,
]);

export class RejectError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.code = reason;
  }
}

let counter = 0;
export function makeMessageId(source, seq) {
  counter += 1;
  return `${source}:${seq}:${counter.toString(36)}`;
}

/** 接入校验：重复、乱序、断链、过期。返回拒绝原因或 null。 */
export function checkEnvelope(state, envelope, nowMs) {
  const e = envelope;
  for (const field of ['message_id', 'source', 'seq', 'type', 'occurred_at']) {
    if (e[field] === undefined || e[field] === null) {
      return new RejectError('malformed', `缺少字段 ${field}`);
    }
  }
  if (!Number.isInteger(e.seq) || e.seq < 1) {
    return new RejectError('malformed', `${e.source} 的 seq 必须是正整数，收到 ${e.seq}`);
  }
  if (state.applied.has(e.message_id)) {
    return new RejectError('duplicate', `消息 ${e.message_id} 已应用于序号 ${state.applied.get(e.message_id).seq}`);
  }
  const lastSeq = state.perSourceSeq.get(e.source) ?? 0;
  if (e.seq <= lastSeq) {
    return new RejectError('stale', `${e.source} 序号倒退：收到 ${e.seq}，已见 ${lastSeq}`);
  }
  if (e.seq !== lastSeq + 1) {
    return new RejectError('gap', `${e.source} 序号不连续：期望 ${lastSeq + 1}，收到 ${e.seq}`);
  }
  if (e.causal_prev !== undefined && e.causal_prev !== null && !state.applied.has(e.causal_prev)) {
    return new RejectError('orphan', `前因消息 ${e.causal_prev} 未知（乱序或被拒）`);
  }
  if (e.valid_to !== undefined && Date.parse(e.valid_to) < nowMs) {
    return new RejectError('expired', `消息有效期止于 ${e.valid_to}`);
  }
  return null;
}
