/**
 * 纯函数状态内核：applyEvent 折叠事件，derive 产出派生决策。
 * 不读文件、不看系统时钟——给定事件序列与"当前时刻"，结果唯一，
 * 这是控制台完整重放与历史复盘的基础。
 */
import { T, RejectError } from './events.js';
import { parseTs, validAt } from './clock.js';

const DEG = Object.freeze({
  LOC: 'loc_low_confidence',
  SENSOR: 'sensor_abnormal',
  HELP: 'visitor_help',
  STORM: 'storm_suspend',
  HEAT: 'extreme_heat',
  BATTERY: 'battery_insufficient',
  ROAD: 'road_closed',
  ZONE: 'outside_safety_zone',
});

/** 处置策略 → 默认责任角色（值班表在 duty.assigned 中解析为具体人员）。 */
export const DEG_META = Object.freeze({
  [DEG.LOC]: { label: '定位置信不足', defaultAction: 'hold_in_place', ownerRole: 'duty:engineer' },
  [DEG.SENSOR]: { label: '安全传感器异常', defaultAction: 'suspend', ownerRole: 'duty:engineer' },
  [DEG.HELP]: { label: '游客求助', defaultAction: 'manual_takeover', ownerRole: 'duty:dispatcher' },
  [DEG.STORM]: { label: '暴雨限制', defaultAction: 'suspend', ownerRole: 'duty:safety' },
  [DEG.HEAT]: { label: '高温限制', defaultAction: 'detour', ownerRole: 'duty:safety' },
  [DEG.BATTERY]: { label: '电量不满足下一路段', defaultAction: 'suspend', ownerRole: 'duty:engineer' },
  [DEG.ROAD]: { label: '道路封闭', defaultAction: 'detour', ownerRole: 'duty:dispatcher' },
  [DEG.ZONE]: { label: '驶出安全区域', defaultAction: 'suspend', ownerRole: 'duty:engineer' },
});

export function initialState() {
  return {
    mission: null,
    maps: new Map(),          // `${id}@${version}` -> 地图版本
    mapCurrent: null,         // { id, version }
    routes: new Map(),        // routeId -> { versions: Map(version -> {segments, content_version}), current }
    contents: new Map(),      // contentId -> Map(version -> {narrations})
    contentCurrent: null,     // { id, version }
    constraints: new Map(),   // code -> 最新限制记录（带有效期）
    safetyZones: new Map(),   // zoneId -> 记录
    duties: new Map(),        // roleId -> 当班人员记录
    grants: [],               // 授权记录（对话/视频，各自独立）
    telemetry: { position: null, battery: null, sensors: new Map() },
    weather: null,
    roads: new Map(),         // edgeKey -> {closed, since, detour_via}
    openHelp: null,
    degradations: new Map(),  // id -> 决策记录（含 status）
    commands: new Map(),
    progress: null,           // {route_id, status, seg_seq, checkpoint_id, narration}
    narrations: new Map(),    // narration_id -> 播放记录（含中断与去向，接管冻结时逐一交代）
    takeovers: new Map(),
    takeoverOpen: null,
    pendingResume: null,
    connectivity: { online: true, since: null },
    edgeCaptures: [],
    applied: new Map(),
    perSourceSeq: new Map(),
    log: [],
    rejects: [],
  };
}

export function edgeKey(mapId, from, to) {
  return `${mapId}|${from}->${to}`;
}

/** 结构化克隆（事件规模小，接入时用它保证"校验失败不留下半成品状态"）。 */
export function cloneState(state) {
  return structuredClone(state);
}

function segEdges(state, seg) {
  const mapId = state.mapCurrent?.id;
  return (seg.path_edges ?? []).map(([from, to]) => edgeKey(mapId, from, to));
}

function activeRouteVersion(state) {
  if (!state.progress) return null;
  const r = state.routes.get(state.progress.route_id);
  return r.versions.get(r.current);
}

function currentSegment(state) {
  if (!state.progress) return null;
  const rv = activeRouteVersion(state);
  const list = [...rv.segments.values()].sort((a, b) => a.seq - b.seq);
  return list.find((s) => s.seq === state.progress.seg_seq) ?? null;
}

function nextSegment(state) {
  if (!state.progress) return null;
  const rv = activeRouteVersion(state);
  const list = [...rv.segments.values()].sort((a, b) => a.seq - b.seq);
  return list.find((s) => s.seq === state.progress.seg_seq + 1) ?? null;
}

/** 当前路段正在播放的讲解记录（统一账本在 state.narrations）。 */
function prNarration(state) {
  return state.progress?.narration_id ? state.narrations.get(state.progress.narration_id) ?? null : null;
}

/**
 * 仍需系统交代或续播的讲解。
 * 已完成、已被替代、人工接管后明确"人工接续/放弃"的不算；
 * 但"推迟到检查点/检查点续讲"仍算未完成——系统有义务在恢复点续播。
 */
export function unfinishedNarrations(state) {
  return [...state.narrations.values()].filter((n) => {
    if (['completed', 'replaced'].includes(n.status)) return false;
    if (n.status === 'delegated' && ['manual_continue', 'abandon'].includes(n.disposition)) return false;
    return true;
  });
}

function constraintActive(state, ms, code) {
  const c = state.constraints.get(code);
  return c && validAt(ms, c) ? c : null;
}

function pointInAnyZone(state, pos) {
  if (!pos) return false;
  for (const z of state.safetyZones.values()) {
    if (!validAt(parseTs(state.weather?.at ?? pos.at), z)) continue;
    const [w, s, e, n] = z.bounds;
    if (pos.lng >= w && pos.lng <= e && pos.lat >= s && pos.lat <= n) return z;
  }
  return false;
}

/** 当前生效的责任人（带有效期的值班记录）。 */
export function dutyAt(state, roleId, ms) {
  const d = state.duties.get(roleId);
  return d && validAt(ms, d) ? d : null;
}

function activeDecisions(state) {
  return [...state.degradations.values()].filter((d) => d.status === 'active');
}

/** 进度/讲解的运行模式由生效中的决策集合推导，保证重放结果一致。 */
function syncProgressMode(state) {
  const pr = state.progress;
  if (!pr || pr.status === 'frozen' || pr.status === 'completed') return;
  if (state.takeoverOpen) { pr.status = 'frozen'; return; }
  const acts = activeDecisions(state);
  const n = pr.narration_id ? state.narrations.get(pr.narration_id) : null;
  if (acts.some((d) => d.action === 'manual_takeover' || d.action === 'suspend')) {
    pr.status = 'paused';
  } else if (acts.some((d) => d.action === 'hold_in_place')) {
    pr.status = 'hold';
  } else {
    pr.status = 'moving';
    if (n && (n.status === 'paused' || n.status === 'paused_auto_resume') && !n.await_disposition) {
      n.status = 'playing'; // 暂停的讲解随自动任务继续
    }
  }
}

/* ----------------------------- 事件折叠 ----------------------------- */

export function applyEvent(state, e) {
  state.log.push(e);
  state.applied.set(e.message_id, { seq: e.seq, at: e.occurred_at });
  state.perSourceSeq.set(e.source, e.seq);
  const p = e.payload ?? {};

  switch (e.type) {
    case T.MISSION_LOADED:
      state.mission = { ...p, loaded_at: e.occurred_at };
      break;

    case T.MAP_PUBLISHED: {
      const v = String(p.version);
      const key = `${p.map_id}@${v}`;
      state.maps.set(key, { ...p, version: v, published_at: e.occurred_at });
      if (p.set_current !== false) state.mapCurrent = { id: p.map_id, version: v };
      break;
    }

    case T.ROUTE_PUBLISHED: {
      let r = state.routes.get(p.route_id);
      if (!r) { r = { versions: new Map(), current: null }; state.routes.set(p.route_id, r); }
      const segments = new Map();
      for (const s of p.segments) segments.set(s.seq, { ...s });
      const v = String(p.version);
      r.versions.set(v, {
        version: v,
        segments,
        content_id: p.content_id,
        content_version: String(p.content_version),
        valid_from: p.valid_from,
        valid_to: p.valid_to,
      });
      if (p.set_current !== false) {
        r.current = v;
        state.contentCurrent = { id: p.content_id, version: String(p.content_version) };
      }
      break;
    }

    case T.CONTENT_PUBLISHED: {
      let c = state.contents.get(p.content_id);
      if (!c) { c = new Map(); state.contents.set(p.content_id, c); }
      c.set(String(p.version), {
        narrations: new Map(p.narrations.map((n) => [n.id, { ...n }])),
        supersedes: p.supersedes ?? [],
      });
      if (p.set_current !== false) {
        state.contentCurrent = { id: p.content_id, version: String(p.version) };
      }
      // 讲解包明确给出的替代/推迟去向：已暂停的立即落账；未开播的也预先建账，
      // 保证"这条旧讲解以后去哪讲"在内容版本里可查，不允许静默丢弃。
      for (const s of p.supersedes ?? []) {
        const replaced = s.disposition === 'replaced_by';
        let n = state.narrations.get(s.narration_id);
        if (!n) {
          n = {
            id: s.narration_id, status: replaced ? 'replaced' : 'deferred', seg_seq: null,
            started_at: null, updated_at: e.occurred_at,
            disposition: s.disposition, interrupted_by: null,
            await_disposition: false,
            resume_checkpoint: s.resume_checkpoint ?? null,
            replaced_by: s.replaced_by ?? null,
            declared_by_content: p.version, history: [],
          };
          state.narrations.set(s.narration_id, n);
        } else if (n.status !== 'completed') {
          n.status = replaced ? 'replaced' : 'deferred';
          n.disposition = s.disposition;
          n.resume_checkpoint = s.resume_checkpoint ?? null;
          n.replaced_by = s.replaced_by ?? null;
          n.await_disposition = false;
          n.updated_at = e.occurred_at;
        }
      }
      break;
    }

    case T.CONSTRAINT_UPDATED:
      state.constraints.set(p.code, { ...p, updated_at: e.occurred_at });
      break;

    case T.SAFETY_ZONE_UPDATED:
      state.safetyZones.set(p.zone_id, { ...p, updated_at: e.occurred_at });
      break;

    case T.DUTY_ASSIGNED:
      state.duties.set(p.role_id, { ...p, assigned_at: e.occurred_at });
      break;

    case T.AUTHORIZATION_PUBLISHED:
      state.grants.push({ ...p, published_at: e.occurred_at });
      break;

    case T.POSITION:
      state.telemetry.position = { ...p, at: e.occurred_at };
      break;

    case T.BATTERY:
      state.telemetry.battery = { percent: p.percent, at: e.occurred_at };
      break;

    case T.SENSOR_STATUS:
      state.telemetry.sensors.set(p.sensor_id, { ...p, at: e.occurred_at });
      break;

    case T.SENSOR_RESET: {
      const s = state.telemetry.sensors.get(p.sensor_id);
      if (s) { s.status = 'ok'; s.at = e.occurred_at; s.note = p.note ?? '已复位'; }
      break;
    }

    case T.WEATHER:
      state.weather = { ...p, at: e.occurred_at };
      break;

    case T.ROAD_CLOSED:
      state.roads.set(edgeKey(p.map_id ?? state.mapCurrent.id, p.from, p.to), {
        closed: true, reason: p.reason, detour_via: p.detour_via ?? null,
        since: e.occurred_at, valid_to: p.valid_to,
      });
      break;

    case T.ROAD_REOPENED:
      state.roads.delete(edgeKey(p.map_id ?? state.mapCurrent.id, p.from, p.to));
      break;

    case T.DETOUR_PLANNED: {
      const k = edgeKey(p.map_id ?? state.mapCurrent.id, p.from, p.to);
      const rec = state.roads.get(k);
      if (rec) { rec.detour_via = p.via; rec.detour_valid_to = p.valid_to; }
      break;
    }

    case T.VISITOR_HELP:
      state.openHelp = p.resolved ? null : { ...p, at: e.occurred_at };
      break;

    case T.DECISION_DECIDED:
    case T.DECISION_AMENDED: {
      const existing = state.degradations.get(p.decision_id);
      state.degradations.set(p.decision_id, {
        ...p,
        status: 'active',
        decided_at: existing?.decided_at ?? e.occurred_at,
        amended_at: existing ? e.occurred_at : undefined,
        amended: e.type === T.DECISION_AMENDED || existing?.amended === true,
      });
      // 讲解随决策联动（这些状态必须随事件重放，不能只存在于当前内存）
      const n0 = prNarration(state);
      if (n0 && n0.status !== 'completed' && n0.status !== 'delegated') {
        if (p.action === 'manual_takeover') {
          // 人工接管必须打断任何未完成讲解（含已被暂停的），等待接管人明确去向
          n0.status = 'interrupted';
          n0.disposition = null;
          n0.await_disposition = true; // 推迟/检查点续讲/人工接续/放弃
        } else if (['playing', 'paused_auto_resume'].includes(n0.status)) {
          if (p.action === 'suspend') {
            n0.status = 'paused';
            n0.disposition = 'postpone';
          } else {
            n0.status = 'paused_auto_resume';
          }
        }
        n0.interrupted_by = p.decision_id;
      }
      syncProgressMode(state);
      break;
    }

    case T.DECISION_CLEARED: {
      const d = state.degradations.get(p.decision_id);
      if (d) { d.status = 'cleared'; d.cleared_at = e.occurred_at; d.clear_reason = p.reason; }
      syncProgressMode(state);
      break;
    }

    case T.COMMAND_ISSUED: {
      // 同一决策新指令下达时，此前该决策仍在"已下达"状态的指令作废，
      // 这样接管冻结点看到的只是当时真正挂起的一条指令。
      for (const c of state.commands.values()) {
        if (c.decision_id === p.decision_id && c.status === 'issued') {
          c.status = 'superseded';
          c.superseded_at = e.occurred_at;
          c.superseded_by = p.command_id;
        }
      }
      state.commands.set(p.command_id, { ...p, issued_at: e.occurred_at, status: 'issued' });
      break;
    }

    case T.SEGMENT_STARTED:
      state.progress = {
        route_id: p.route_id, status: 'moving', seg_seq: p.seq,
        checkpoint_id: p.from_checkpoint, narration_id: null,
      };
      break;

    case T.SEGMENT_ADVANCED: {
      if (state.progress && p.checkpoint_id) state.progress.checkpoint_id = p.checkpoint_id;
      break;
    }

    case T.SEGMENT_COMPLETED: {
      if (!state.progress) break;
      const nxt = nextSegment(state);
      if (nxt) {
        state.progress.seg_seq = nxt.seq;
        state.progress.checkpoint_id = nxt.from_checkpoint;
      } else {
        state.progress.status = 'completed';
      }
      break;
    }

    case T.NARRATION_STARTED: {
      // 同一讲解可能在恢复后重播；历史状态压入 history，当前状态另起。
      const prev = state.narrations.get(p.narration_id);
      const history = prev
        ? [...(prev.history ?? []), { status: prev.status, disposition: prev.disposition, at: prev.updated_at }]
        : [];
      state.narrations.set(p.narration_id, {
        id: p.narration_id, status: 'playing', seg_seq: p.seq,
        started_at: e.occurred_at, updated_at: e.occurred_at,
        disposition: null, interrupted_by: null, await_disposition: false,
        history,
      });
      if (state.progress) state.progress.narration_id = p.narration_id;
      break;
    }

    case T.NARRATION_COMPLETED: {
      const n = state.narrations.get(p.narration_id);
      if (n) {
        n.status = 'completed';
        n.completed_at = e.occurred_at;
        n.updated_at = e.occurred_at;
        n.disposition = 'played';
        n.await_disposition = false;
      }
      break;
    }

    case T.TAKEOVER_REQUESTED:
      state.takeovers.set(p.takeover_id, {
        ...p, status: 'requested', requested_at: e.occurred_at,
      });
      break;

    case T.TAKEOVER_CONFIRMED: {
      const tk = state.takeovers.get(p.takeover_id);
      if (!tk) throw new RejectError('orphan', `接管 ${p.takeover_id} 不存在`);
      if (tk.requested_by?.staff_id && tk.requested_by.staff_id === p.confirmed_by?.staff_id) {
        throw new RejectError('invalid', '接管确认人不得与请求人相同（双人确认）');
      }
      Object.assign(tk, { status: 'confirmed', confirmed_by: p.confirmed_by, confirmed_at: e.occurred_at });
      state.takeoverOpen = p.takeover_id;
      break;
    }

    case T.TAKEOVER_FROZEN: {
      const tk = state.takeovers.get(p.takeover_id);
      if (tk) tk.freeze = { ...p.freeze, frozen_at: e.occurred_at };
      if (state.progress) state.progress.status = 'frozen';
      for (const cmd of state.commands.values()) {
        if (cmd.status === 'issued') cmd.status = 'suspended_by_takeover';
      }
      break;
    }

    case T.NARRATION_DELEGATED: {
      const tk = state.takeovers.get(p.takeover_id);
      const note = { ...p, at: e.occurred_at };
      if (tk) {
        tk.narration_dispositions = tk.narration_dispositions ?? [];
        tk.narration_dispositions.push(note);
      }
      const n = state.narrations.get(p.narration_id);
      if (n) {
        n.status = p.disposition === 'replaced_by' ? 'replaced' : 'delegated';
        n.disposition = p.disposition;
        n.assigned_to = p.to ?? null;
        n.replaced_by = p.replaced_by ?? null;
        n.resume_checkpoint = p.resume_checkpoint ?? null;
        n.await_disposition = false;
        n.updated_at = e.occurred_at;
      }
      break;
    }

    case T.TAKEOVER_RESUME_PREPARED: {
      const tk = state.takeovers.get(p.takeover_id);
      if (tk) tk.resume_plan = { ...p, prepared_at: e.occurred_at };
      state.pendingResume = { ...p };
      break;
    }

    case T.TAKEOVER_RESUMED: {
      const tk = state.takeovers.get(p.takeover_id);
      if (!tk?.resume_plan) throw new RejectError('invalid', '缺少经确认的恢复检查点计划');
      const plan = tk.resume_plan;
      if (p.at_checkpoint !== plan.checkpoint_id) {
        throw new RejectError('invalid', `设备位于 ${p.at_checkpoint}，与恢复检查点 ${plan.checkpoint_id} 不符`);
      }
      if (String(p.observed_map_version) !== String(plan.map_version)) {
        throw new RejectError('invalid', '设备地图版本与恢复计划不一致，拒绝自动恢复');
      }
      const rv = state.routes.get(plan.route_id).versions.get(String(plan.route_version));
      const seg = [...rv.segments.values()].find((s) => s.from_checkpoint === plan.checkpoint_id)
        ?? [...rv.segments.values()].find((s) => s.to_checkpoint === plan.checkpoint_id);
      state.mapCurrent = { id: state.mapCurrent.id, version: String(plan.map_version) };
      state.routes.get(plan.route_id).current = String(plan.route_version);
      state.contentCurrent = { id: rv.content_id, version: String(plan.content_version) };
      state.progress = {
        route_id: plan.route_id, status: 'moving',
        seg_seq: seg ? seg.seq : state.progress?.seg_seq,
        checkpoint_id: plan.checkpoint_id,
        narration_id: state.progress?.narration_id ?? null,
      };
      // 被推迟到检查点续讲的讲解，在恢复点重新进入待播放（重新 NARRATION_STARTED 起轮）
      tk.status = 'resumed';
      tk.resumed_at = e.occurred_at;
      state.takeoverOpen = null;
      state.pendingResume = null;
      break;
    }

    case T.TAKEOVER_CLOSED: {
      const tk = state.takeovers.get(p.takeover_id);
      if (tk) { tk.status = 'closed'; tk.closed_at = e.occurred_at; tk.close_note = p.note; }
      if (state.takeoverOpen === p.takeover_id) state.takeoverOpen = null;
      break;
    }

    case T.CONNECTIVITY:
      state.connectivity = { online: !!p.online, since: e.occurred_at };
      break;

    case T.EDGE_CAPTURE:
      state.edgeCaptures.push({ ...p.summary, denied_field_names: p.denied_field_names ?? [], recorded_at: e.occurred_at });
      break;

    case T.SYNC_UPLINK:
      // 恢复联网后按授权用途上传的摘要（字段已在接入前做过白名单过滤）
      state.edgeCaptures.push({
        data_class: p.data_class, grant_id: p.grant_id, purpose: p.purpose,
        cloud_retention: p.cloud_retention, ...p.fields,
        uplinked_at: e.occurred_at,
      });
      break;

    case T.ACCESS_DENIED:
      state.rejects.push({ at: e.occurred_at, kind: 'access_denied', ...p });
      break;

    default:
      throw new RejectError('unknown_type', e.type);
  }
  return state;
}

/* --------------------------- 策略引擎（派生） --------------------------- */

function blockedEdgesOn(state, seg, ms) {
  const out = [];
  for (const key of segEdges(state, seg)) {
    const rec = state.roads.get(key);
    if (rec?.closed && (rec.valid_to === undefined || parseTs(rec.valid_to) >= ms)) out.push({ key, rec });
  }
  return out;
}

function detourUsable(state, via, ms) {
  if (!Array.isArray(via)) return false;
  if (!state.mapCurrent) return false;
  const map = state.maps.get(`${state.mapCurrent.id}@${state.mapCurrent.version}`);
  const known = new Set((map?.edges ?? []).map((g) => `${g.from}->${g.to}`));
  for (const [from, to] of via) {
    const name = `${from}->${to}`;
    if (known.size > 0 && !known.has(name)) return false; // 当前地图版本上还没有这条路
    const rec = state.roads.get(edgeKey(state.mapCurrent.id, from, to));
    if (rec?.closed) return false;
  }
  return true;
}

/**
 * 评估当前观察，返回需要生效的降级（blockers）。
 * 优先级：人工接管 > 暂停（求助/传感器/暴雨/电量/无路可绕）> 就地等待 > 绕行。
 * 定位置信不足时不能绕行，传感器异常时不能继续自动行驶。
 */
export function evaluate(state, ms, { forResume = false } = {}) {
  const blockers = [];
  const add = (code, action, opts = {}) => blockers.push({ code, action, ...opts });

  // 人工接管期间自动任务冻结；但恢复前闸门需要按"即将解冻"的视角评估一次
  if (state.takeoverOpen && !forResume) return blockers;
  const moving = state.progress
    && ['moving', 'hold', 'paused', 'frozen'].includes(state.progress.status);

  if (state.openHelp) add(DEG.HELP, 'manual_takeover', { reason: state.openHelp.reason });

  for (const [sensorId, s] of state.telemetry.sensors) {
    if (s.status !== 'ok' && s.safety_critical !== false) {
      add(DEG.SENSOR, 'suspend', { reason: `${sensorId}:${s.status}`, fingerprint: `${sensorId}:${s.status}` });
    }
  }

  const storm = constraintActive(state, ms, 'storm');
  if (storm && state.weather && (state.weather.storm_level ?? 0) >= storm.condition.storm_level_gte) {
    add(DEG.STORM, 'suspend', { reason: `暴雨${state.weather.storm_level_label ?? state.weather.storm_level}级`, fingerprint: `lvl${state.weather.storm_level}` });
  }

  const heat = constraintActive(state, ms, 'heat');
  const seg = moving ? currentSegment(state) : null;
  const nxt = moving ? nextSegment(state) : null;
  if (heat && state.weather && state.weather.temperature_c >= heat.condition.temp_gte) {
    const target = seg?.heat_affected ? seg : (nxt?.heat_affected ? nxt : null);
    if (target) {
      const via = heat.detour_via ?? null;
      add(DEG.HEAT, detourUsable(state, via, ms) ? 'detour' : 'suspend', {
        reason: `气温${state.weather.temperature_c}℃，段 ${target.seq} 高温受限`,
        fingerprint: `seg${target.seq}`,
        detour_via: via ?? undefined,
      });
    }
  }

  if (moving && state.telemetry.battery) {
    const target = seg ?? nxt;
    const need = target?.min_battery_percent ?? 0;
    if (state.telemetry.battery.percent < need) {
      add(DEG.BATTERY, 'suspend', {
        reason: `电量${state.telemetry.battery.percent}% < 段${target.seq}要求${need}%`,
        fingerprint: `seg${target.seq}:need${need}`,
      });
    }
  }

  if (moving) {
    for (const target of [seg, nxt].filter(Boolean)) {
      const closed = blockedEdgesOn(state, target, ms);
      if (closed.length) {
        const via = closed[0].rec.detour_via ?? null;
        add(DEG.ROAD, detourUsable(state, via, ms) ? 'detour' : 'suspend', {
          reason: `${closed[0].rec.reason ?? '道路封闭'}（段 ${target.seq}）`,
          fingerprint: closed.map((c) => c.key).join('|'),
          detour_via: via ?? undefined,
        });
        break;
      }
    }
  }

  const locRule = constraintActive(state, ms, 'loc');
  const locThreshold = locRule?.condition?.confidence_gte
    ?? state.mission?.limits?.loc_min_confidence;
  if (moving && locThreshold !== undefined && state.telemetry.position) {
    const pos = state.telemetry.position;
    if (pos.confidence < locThreshold) {
      add(DEG.LOC, 'hold_in_place', {
        reason: `置信度${pos.confidence} < ${locThreshold}`,
        fingerprint: `c${pos.confidence}`,
      });
    }
  }

  // 安全区兜底：偏离所有安全区且定位可用 → 暂停（演示里保留为内核能力）
  if (moving && state.telemetry.position && state.safetyZones.size > 0 && state.progress?.status === 'moving') {
    if (!pointInAnyZone(state, state.telemetry.position)) {
      add(DEG.ZONE, 'suspend', { reason: '驶出安全区域', fingerprint: 'outside_safety_zone' });
    }
  }

  const priority = ['manual_takeover', 'suspend', 'hold_in_place', 'detour'];
  return blockers.sort((a, b) => priority.indexOf(a.action) - priority.indexOf(b.action));
}

function derived(state, type, payload, nowIso, causalPrev) {
  const seq = (state.perSourceSeq.get('scheduler') ?? 0) + 1;
  return {
    message_id: `scheduler:${seq}:${type}`,
    source: 'scheduler', seq, type,
    occurred_at: nowIso, causal_prev: causalPrev ?? null,
    payload, _derived: true,
  };
}

/**
 * 观察事件之后的派生：新增/变更/解除降级，同步指令与讲解状态。
 * 返回应追加的派生事件（DECISION_* + COMMAND_ISSUED）。
 * 讲解暂停/继续、进度模式的联动在 reducer 内完成，保证重放一致。
 */
export function derive(state, trigger, nowIso) {
  const out = [];
  const ms = parseTs(nowIso);
  if (state.takeoverOpen) return out; // 接管期间不做任何自动派生
  const blockers = evaluate(state, ms);
  const active = activeDecisions(state);
  const byCode = new Map(active.map((d) => [d.code, d]));
  const chosen = new Map();

  // 同一代码可能多个成因，只保留优先级最高的一个（blockers 已按动作优先级排序）
  for (const b of blockers) {
    if (!chosen.has(b.code)) chosen.set(b.code, b);
  }

  for (const [code, b] of chosen) {
    const existing = byCode.get(code);
    const duty = dutyAt(state, DEG_META[code].ownerRole, ms);
    const base = {
      code, location: describeLocation(state),
      map_version: state.mapCurrent?.version ?? null,
      route_id: state.progress?.route_id ?? null,
      route_version: state.progress ? state.routes.get(state.progress.route_id)?.current : null,
      content_version: state.contentCurrent?.version ?? null,
      owner_role: DEG_META[code].ownerRole,
      owner: duty ? { staff_id: duty.staff_id, name: duty.name } : null,
      trigger_message: trigger?.message_id ?? null,
      fingerprint: b.fingerprint ?? b.reason,
    };
    if (!existing) {
      const id = `deg-${code}-${state.degradations.size + 1}`;
      out.push(derived(state, T.DECISION_DECIDED, {
        decision_id: id, action: b.action, reason: b.reason, ...base,
      }, nowIso, trigger?.message_id));
      out.push(derived(state, T.COMMAND_ISSUED, {
        command_id: `cmd-${id}-1`, decision_id: id, target_device: state.mission?.device_id ?? 'robot',
        ...commandFor(b, id),
      }, nowIso));
      applyEvent(state, out[out.length - 2]);
      applyEvent(state, out[out.length - 1]);
    } else if (existing.fingerprint !== (b.fingerprint ?? b.reason) || existing.action !== b.action) {
      const amendNo = (existing.amend_no ?? 0) + 1;
      out.push(derived(state, T.DECISION_AMENDED, {
        decision_id: existing.decision_id, action: b.action, reason: b.reason, amend_no: amendNo, ...base,
      }, nowIso, trigger?.message_id));
      out.push(derived(state, T.COMMAND_ISSUED, {
        command_id: `cmd-${existing.decision_id}-${amendNo + 1}`,
        decision_id: existing.decision_id, target_device: state.mission?.device_id ?? 'robot',
        ...commandFor(b, existing.decision_id),
      }, nowIso));
      applyEvent(state, out[out.length - 2]);
      applyEvent(state, out[out.length - 1]);
    }
  }

  for (const d of active) {
    if (chosen.has(d.code)) continue;
    out.push(derived(state, T.DECISION_CLEARED, {
      decision_id: d.decision_id, reason: '成因观察已消除',
      cleared_by: 'auto', trigger_message: trigger?.message_id ?? null,
    }, nowIso, trigger?.message_id));
    out.push(derived(state, T.COMMAND_ISSUED, {
      command_id: `cmd-${d.decision_id}-clear`, decision_id: d.decision_id,
      target_device: state.mission?.device_id ?? 'robot',
      command: 'resume_auto', params: {}, label: '成因消除，恢复自动任务',
    }, nowIso));
    applyEvent(state, out[out.length - 2]);
    applyEvent(state, out[out.length - 1]);
  }
  return out;
}

function commandFor(b, decisionId) {
  switch (b.action) {
    case 'manual_takeover':
      return { command: 'yield_to_operator', params: {}, label: '请求人工接管，自动任务停止' };
    case 'suspend':
      return { command: 'pause', params: { resume: 'auto_when_clear' }, label: '暂停并等待' };
    case 'hold_in_place':
      return { command: 'hold_position', params: {}, label: '就地等待定位恢复' };
    case 'detour':
      return { command: 'follow_detour', params: { via: b.detour_via ?? [] }, label: '按可说明路线绕行' };
    default:
      return { command: b.action, params: {} };
  }
}

export function describeLocation(state) {
  const seg = currentSegment(state);
  const pos = state.telemetry.position;
  return {
    checkpoint_id: state.progress?.checkpoint_id ?? null,
    segment_seq: seg?.seq ?? state.progress?.seg_seq ?? null,
    edge: seg ? `${seg.from_checkpoint}->${seg.to_checkpoint}` : null,
    lat: pos?.lat ?? null, lng: pos?.lng ?? null,
  };
}

/* ------------------------------ 重放/查询 ------------------------------ */

/** 截至 asOf（含）按发生时间重放；asOf 省略则重放全部。 */
export function replay(events, { asOf, adopt = true } = {}) {
  const state = initialState();
  const cutoff = asOf === undefined ? Infinity : parseTs(asOf);
  // 同一时刻按接入顺序（log 顺序天然稳定），避免同毫秒事件顺序漂移
  const ordered = [...events].sort((a, b) => {
    const d = parseTs(a.occurred_at) - parseTs(b.occurred_at);
    return d !== 0 ? d : (a.__ingest ?? 0) - (b.__ingest ?? 0);
  });
  for (const e of ordered) {
    if (parseTs(e.occurred_at) > cutoff) break;
    applyEvent(state, e);
  }
  return state;
}

export function controlMode(state, ms = Date.now()) {
  if (state.takeoverOpen) return 'manual';
  const active = [...state.degradations.values()].filter((d) => d.status === 'active');
  if (active.some((d) => d.action === 'manual_takeover')) return 'manual_requested';
  if (active.some((d) => d.action === 'suspend')) return 'paused';
  if (active.some((d) => d.action === 'hold_in_place')) return 'holding';
  if (active.some((d) => d.action === 'detour')) return 'auto_detour';
  if (state.progress?.status === 'frozen') return 'frozen';
  if (state.progress) return 'auto';
  return 'idle';
}

/** 值班复盘：某时某地发生了什么降级、谁负责后续动作。 */
export function answerAt(events, asOf) {
  const state = replay(events, { asOf });
  const ms = parseTs(asOf);
  const active = [...state.degradations.values()].filter((d) => d.status === 'active');
  const takeover = state.takeoverOpen ? state.takeovers.get(state.takeoverOpen) : null;
  return {
    as_of: asOf,
    control_mode: controlMode(state, ms),
    versions: {
      map: state.mapCurrent, route: state.progress
        ? { route_id: state.progress.route_id, version: state.routes.get(state.progress.route_id)?.current }
        : null,
      content: state.contentCurrent,
    },
    progress: state.progress ? {
      route_id: state.progress.route_id,
      status: state.progress.status,
      segment_seq: state.progress.seg_seq,
      checkpoint_id: state.progress.checkpoint_id,
      narration: state.progress.narration_id ? (() => {
        const n = state.narrations.get(state.progress.narration_id);
        return {
          id: n.id, status: n.status, disposition: n.disposition ?? null,
          await_disposition: n.await_disposition,
        };
      })() : null,
      unfinished_narrations: unfinishedNarrations(state).map((n) => ({
        id: n.id, status: n.status, disposition: n.disposition ?? null,
        assigned_to: n.assigned_to ?? null, resume_checkpoint: n.resume_checkpoint ?? null,
      })),
    } : null,
    degradations: active.map((d) => ({
      code: d.code, label: DEG_META[d.code].label, action: d.action,
      reason: d.reason, decided_at: d.decided_at, location: d.location,
      owner: d.owner ?? { role: d.owner_role, staff: '未排班（升级处理）' },
      trigger_message: d.trigger_message,
    })),
    takeover: takeover ? {
      takeover_id: takeover.takeover_id,
      requested_by: takeover.requested_by, confirmed_by: takeover.confirmed_by,
      confirmed_at: takeover.confirmed_at, reason: takeover.reason,
      freeze: takeover.freeze ?? null,
      narration_dispositions: takeover.narration_dispositions ?? [],
      resume_plan: takeover.resume_plan ?? null,
      resumed_at: takeover.resumed_at ?? null,
      status: takeover.status,
    } : null,
  };
}

export { DEG };
