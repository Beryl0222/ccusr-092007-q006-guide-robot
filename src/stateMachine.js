/**
 * 伴游任务降级状态机（纯函数归约）。
 *
 * 降级映射：
 *   定位置信不足 / 电量低于路段要求 → WAIT_IN_PLACE（就地等待）
 *   传感器异常 / 暴雨停运           → PAUSED（暂停）
 *   游客求助                        → HUMAN_TAKEOVER（人工接管）
 *   道路封闭                        → DETOUR（可说明的绕行）
 *
 * 不倒退保证：
 *   - causal_seq 不大于已见序号的事件直接忽略（防御纵深，日志层已拦截）；
 *   - 接管期间自动恢复类事件一律忽略，只有 takeover_resumed 能退出接管；
 *   - 恢复类事件只有在对应原因确实存在时才生效。
 */

export const MODE = Object.freeze({
  AUTO: 'AUTO',
  WAIT_IN_PLACE: 'WAIT_IN_PLACE',
  PAUSED: 'PAUSED',
  DETOUR: 'DETOUR',
  HUMAN_TAKEOVER: 'HUMAN_TAKEOVER',
});

/** 降级原因 → 责任类别（对应 mission.responsibilities 的 kind）。 */
export const CAUSE_KIND = Object.freeze({
  low_position_confidence: 'position_degraded',
  low_battery: 'battery',
  sensor_fault: 'sensor_fault',
  weather_suspend: 'weather',
});

const PAUSE_CAUSES = new Set(['sensor_fault', 'weather_suspend']);
const WAIT_CAUSES = new Set(['low_position_confidence', 'low_battery']);

/** 接管期间不生效的事件类型：自动任务停在原地，由人工驾驶。 */
const IGNORED_IN_TAKEOVER = new Set([
  'position_degraded',
  'position_recovered',
  'sensor_fault',
  'sensor_recovered',
  'weather_alert',
  'weather_cleared',
  'road_closed',
  'road_reopened',
  'visitor_help',
  'checkpoint_reached',
]);

export function initialState(mission) {
  return {
    status: 'ACTIVE',
    mode: MODE.AUTO,
    segment_id: mission.route[0].segment_id,
    completed_segments: [],
    bypassed_segments: [],
    battery_pct: 100,
    position_confidence: 1,
    causes: {},
    restrictions: [],
    closed_segments: [],
    detour: null,
    takeover: null,
    takeover_history: [],
    narrations: Object.fromEntries(
      mission.narrations.map((n) => [
        n.narration_id,
        { status: 'pending', segment_id: n.segment_id, title: n.title, reason: null, decided_by: null },
      ]),
    ),
    map_version: mission.map.version,
    content_version: mission.content.version,
    last_seq: 0,
    history: [],
  };
}

function segmentOrder(mission) {
  return Object.fromEntries(mission.route.map((s, i) => [s.segment_id, i]));
}

function deriveMode(s) {
  if (s.takeover) return MODE.HUMAN_TAKEOVER;
  const causes = Object.keys(s.causes);
  if (causes.some((c) => PAUSE_CAUSES.has(c))) return MODE.PAUSED;
  if (causes.some((c) => WAIT_CAUSES.has(c))) return MODE.WAIT_IN_PLACE;
  if (s.detour) return MODE.DETOUR;
  return MODE.AUTO;
}

function deferNarrations(s, predicate, reason) {
  for (const n of Object.values(s.narrations)) {
    if (n.status === 'pending' && predicate(n)) {
      n.status = 'deferred';
      n.reason = reason;
    }
  }
}

function restoreNarrations(s, reason) {
  for (const n of Object.values(s.narrations)) {
    if (n.status === 'deferred' && n.reason === reason) {
      n.status = 'pending';
      n.reason = null;
    }
  }
}

function addCause(mission, s, cause, event, detail) {
  if (s.causes[cause]) return;
  s.causes[cause] = { since_seq: event.causal_seq, since_at: event.issued_at, detail };
  // 进入降级的瞬间，当前路段未完成的讲解先挂起，等待明确去向
  deferNarrations(s, (n) => n.segment_id === s.segment_id, cause);
}

function removeCause(s, cause, notes) {
  if (!s.causes[cause]) {
    notes.push(`ignored_stale_recovery:${cause}`);
    return;
  }
  delete s.causes[cause];
  restoreNarrations(s, cause);
}

/** 遥测驱动的解除：原因不存在时静默跳过，避免每次心跳都产生噪音说明。 */
function clearCauseQuietly(s, cause) {
  if (s.causes[cause]) {
    delete s.causes[cause];
    restoreNarrations(s, cause);
  }
}

function withinWindow(item, at) {
  return Date.parse(item.valid_from) <= Date.parse(at) && Date.parse(at) <= Date.parse(item.valid_until);
}

/**
 * 归约一个已被日志层接受的事件，返回新状态与本次说明。
 * @returns {{state: object, notes: string[]}}
 */
export function reduce(mission, state, event) {
  const notes = [];
  if (!Number.isInteger(event.causal_seq) || event.causal_seq <= state.last_seq) {
    return { state, notes: ['stale_seq_ignored'] };
  }
  const s = structuredClone(state);
  s.last_seq = event.causal_seq;
  const at = event.issued_at;
  const p = event.payload ?? {};
  const order = segmentOrder(mission);

  if (s.takeover && IGNORED_IN_TAKEOVER.has(event.type)) {
    notes.push('ignored_during_takeover');
  } else {
    switch (event.type) {
      case 'telemetry': {
        if (typeof p.battery_pct === 'number') s.battery_pct = p.battery_pct;
        if (typeof p.position_confidence === 'number') s.position_confidence = p.position_confidence;
        if (!s.takeover) {
          const minConf = mission.thresholds?.position_confidence_min ?? 0.5;
          if (s.position_confidence < minConf) {
            addCause(mission, s, 'low_position_confidence', event, `定位置信度 ${s.position_confidence}`);
          } else {
            clearCauseQuietly(s, 'low_position_confidence');
          }
          const seg = mission.route.find((r) => r.segment_id === s.segment_id);
          if (seg && s.battery_pct < seg.min_battery_pct) {
            addCause(mission, s, 'low_battery', event, `电量 ${s.battery_pct}% 低于路段 ${seg.segment_id} 要求 ${seg.min_battery_pct}%`);
          } else {
            clearCauseQuietly(s, 'low_battery');
          }
        }
        break;
      }
      case 'position_degraded':
        if (typeof p.position_confidence === 'number') s.position_confidence = p.position_confidence;
        addCause(mission, s, 'low_position_confidence', event, p.note ?? '定位置信不足');
        break;
      case 'position_recovered':
        removeCause(s, 'low_position_confidence', notes);
        break;
      case 'sensor_fault':
        addCause(mission, s, 'sensor_fault', event, `传感器异常: ${p.sensor ?? '未知'}`);
        break;
      case 'sensor_recovered':
        removeCause(s, 'sensor_fault', notes);
        break;
      case 'weather_alert': {
        const limit = mission.weather_limits.find((l) => l.limit_id === p.limit_id);
        if (!limit) {
          notes.push('unknown_weather_limit');
        } else if (!withinWindow(limit, at)) {
          // 过期的暴雨/高温限制不能让设备状态倒退
          notes.push(`weather_limit_not_in_validity:${p.limit_id}`);
        } else if (limit.action === 'suspend_outdoor') {
          addCause(mission, s, 'weather_suspend', event, `${limit.kind} (${limit.limit_id})`);
        } else {
          s.restrictions.push({ limit_id: limit.limit_id, kind: limit.kind, action: limit.action, since_at: at });
          notes.push(`restriction_added:${limit.action}`);
        }
        break;
      }
      case 'weather_cleared': {
        const cause = s.causes.weather_suspend;
        if (cause && cause.detail.includes(p.limit_id)) {
          delete s.causes.weather_suspend;
          restoreNarrations(s, 'weather_suspend');
        }
        const before = s.restrictions.length;
        s.restrictions = s.restrictions.filter((r) => r.limit_id !== p.limit_id);
        if (before === s.restrictions.length && !cause) notes.push('ignored_stale_recovery:weather');
        break;
      }
      case 'road_closed': {
        const seg = mission.route.find((r) => r.segment_id === p.segment_id);
        if (!seg) {
          notes.push('unknown_segment');
          break;
        }
        if (!s.closed_segments.includes(p.segment_id)) s.closed_segments.push(p.segment_id);
        const isAhead = order[p.segment_id] >= order[s.segment_id] && !s.completed_segments.includes(p.segment_id);
        if (isAhead) {
          const owner = mission.responsibilities.find((r) => r.kind === 'road_closed' && withinWindow(r, at));
          const alt = seg.alternate;
          s.detour = {
            closed_segment: p.segment_id,
            reason: p.reason ?? '未说明',
            decided_by: p.decided_by ?? owner?.owner ?? null,
            alternative: alt ?? null,
            map_version: s.map_version,
            explanation: alt
              ? `因「${p.reason ?? '未说明'}」，路段 ${seg.segment_id}（${seg.from}→${seg.to}）封闭，改行${alt.name}（${alt.segment_id}），预计多 ${alt.extra_minutes} 分钟（地图版本 ${s.map_version}）`
              : `因「${p.reason ?? '未说明'}」，路段 ${seg.segment_id}（${seg.from}→${seg.to}）封闭且无备选路线，等待人工指引（地图版本 ${s.map_version}）`,
          };
          notes.push(s.detour.explanation);
          deferNarrations(s, (n) => n.segment_id === p.segment_id, 'road_closed');
        }
        break;
      }
      case 'road_reopened': {
        s.closed_segments = s.closed_segments.filter((id) => id !== p.segment_id);
        if (s.detour?.closed_segment === p.segment_id) {
          s.detour = null;
          restoreNarrations(s, 'road_closed');
        }
        break;
      }
      case 'visitor_help': {
        if (s.takeover) {
          notes.push('takeover_already_active');
          break;
        }
        s.takeover = {
          requested_at: at,
          request_seq: event.causal_seq,
          requested_by: p.visitor ?? '游客',
          stopped_segment: s.segment_id,
          stopped_mode: s.mode,
          confirmed_by: null,
          confirmed_at: null,
          resumed_at: null,
          resume_checkpoint: null,
        };
        deferNarrations(s, (n) => order[n.segment_id] >= order[s.segment_id], 'visitor_help');
        notes.push(`takeover_requested:${s.segment_id}`);
        break;
      }
      case 'takeover_confirmed': {
        if (!s.takeover || s.takeover.confirmed_by) {
          notes.push('ignored_stale_recovery:takeover_confirmed');
          break;
        }
        s.takeover.confirmed_by = p.operator;
        s.takeover.confirmed_at = at;
        notes.push(`takeover_confirmed_by:${p.operator}`);
        break;
      }
      case 'takeover_resumed': {
        if (!s.takeover) {
          notes.push('ignored_stale_recovery:takeover_resumed');
          break;
        }
        if (!s.takeover.confirmed_by) {
          notes.push('resume_requires_confirmation');
          break;
        }
        const resumeSeg = mission.route.find((r) => r.checkpoint_id === p.checkpoint_id);
        if (!resumeSeg) {
          notes.push(`unknown_checkpoint:${p.checkpoint_id}`);
          break;
        }
        const resumeIdx = order[resumeSeg.segment_id];
        // 恢复点之前被绕过的讲解：明确标记去向，不允许悬空
        for (const n of Object.values(s.narrations)) {
          if (n.status === 'deferred' && n.reason === 'visitor_help') {
            if (order[n.segment_id] < resumeIdx) {
              n.status = 'skipped';
              n.reason = 'bypassed_by_takeover';
              n.decided_by = s.takeover.confirmed_by;
            } else {
              n.status = 'pending';
              n.reason = null;
            }
          }
        }
        for (const seg of mission.route) {
          if (order[seg.segment_id] < resumeIdx && !s.completed_segments.includes(seg.segment_id)) {
            s.bypassed_segments.push(seg.segment_id);
          }
        }
        s.takeover.resumed_at = at;
        s.takeover.resume_checkpoint = p.checkpoint_id;
        s.takeover_history.push(s.takeover);
        s.takeover = null;
        s.causes = {};
        s.segment_id = resumeSeg.segment_id;
        notes.push(`takeover_resumed_at:${p.checkpoint_id}`);
        break;
      }
      case 'checkpoint_reached': {
        const seg = mission.route.find((r) => r.segment_id === s.segment_id);
        if (!seg || seg.checkpoint_id !== p.checkpoint_id || p.segment_id !== seg.segment_id) {
          notes.push('checkpoint_mismatch_ignored');
          break;
        }
        s.completed_segments.push(seg.segment_id);
        for (const n of Object.values(s.narrations)) {
          if (n.segment_id === seg.segment_id && (n.status === 'pending' || n.status === 'deferred')) {
            n.status = 'delivered';
            n.reason = null;
          }
        }
        const next = mission.route[order[seg.segment_id] + 1];
        if (next) {
          s.segment_id = next.segment_id;
        } else {
          s.status = 'COMPLETED';
          notes.push('mission_completed');
        }
        break;
      }
      case 'narration_disposition': {
        const n = s.narrations[p.narration_id];
        if (!n || n.status === 'delivered') {
          notes.push('narration_disposition_ignored');
          break;
        }
        n.status = p.disposition;
        n.reason = p.reason ?? null;
        n.decided_by = p.decided_by ?? null;
        break;
      }
      case 'map_update':
        if (p.version) s.map_version = p.version;
        break;
      case 'content_update':
        if (p.version) s.content_version = p.version;
        break;
      default:
        notes.push(`unknown_event_type:${event.type}`);
    }
  }

  s.mode = deriveMode(s);
  s.history.push({
    seq: event.causal_seq,
    at,
    type: event.type,
    mode: s.mode,
    status: s.status,
    segment_id: s.segment_id,
    causes: Object.keys(s.causes),
    detour: s.detour?.closed_segment ?? null,
    detour_explanation: s.detour?.explanation ?? null,
    takeover: Boolean(s.takeover),
    map_version: s.map_version,
    content_version: s.content_version,
    notes,
  });
  return { state: s, notes };
}
