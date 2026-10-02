/**
 * 伴游任务后端门面。
 *
 * 职责：
 *  - 接入外部消息（地图平台/讲解团队/设备/值班员）：去重、乱序与过期拦截，
 *    过期或重复消息不会让设备状态倒退；
 *  - 观察类事件触发纯内核 derive，派生决策与指令同样入链，可完整重放；
 *  - 人工接管全生命周期：请求→双人确认→冻结点（自动任务停在哪里）→
 *    未完成讲解去向→新检查点恢复（核对地图版本）→关闭；
 *  - 边缘离线最小化：只缓存授权白名单摘要，恢复联网按声明用途上传，不扩权；
 *  - 复盘：按任意历史时点、以当时地图/内容版本回答降级与责任。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Clock, parseTs } from './clock.js';
import { T, OBSERVATIONS, checkEnvelope, RejectError } from './events.js';
import {
  initialState, applyEvent, derive, replay, answerAt, controlMode, DEG_META,
  unfinishedNarrations, cloneState, evaluate,
} from './core.js';
import { filterEdgeCapture, filterSyncUplink } from './privacy.js';
import { appendEvent, appendRejection, loadEvents } from './store.js';

let idCounter = 0;
function lid(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export class Backend {
  constructor({ logPath, rejectPath, clock } = {}) {
    this.logPath = logPath ?? null;
    this.rejectPath = rejectPath ?? null;
    this.clock = clock ?? new Clock();
    this.state = initialState();
  }

  static async fromLog(path, { rejectPath, clock } = {}) {
    const b = new Backend({ logPath: path, rejectPath, clock });
    const events = await loadEvents(path);
    for (const e of events) b.state = applyEvent(b.state, e);
    return b;
  }

  get nowIso() { return this.clock.iso(); }

  /**
   * 接入一条消息。返回 { accepted, envelope, derived, rejected? }。
   * 被拒消息原样不应用，写入旁路审计（仅元数据），设备状态不变。
   */
  ingest(envelope, { deriveAfter = true } = {}) {
    const nowMs = this.clock.now();
    const reject = checkEnvelope(this.state, envelope, nowMs);
    if (reject) {
      const rec = {
        rejected_at: this.clock.iso(), code: reject.code,
        message_id: envelope.message_id, source: envelope.source,
        seq: envelope.seq, type: envelope.type, detail: reject.message,
      };
      this.state.rejects.push(rec);
      if (this.rejectPath) appendRejection(this.rejectPath, rec);
      return { accepted: false, ...rec };
    }

    envelope.__ingest = this.state.log.length + 1;
    const before = cloneState(this.state);
    try {
      this.state = applyEvent(this.state, envelope);
    } catch (err) {
      if (err instanceof RejectError) {
        this.state = before;
        const rec = {
          rejected_at: this.clock.iso(), code: err.code,
          message_id: envelope.message_id, source: envelope.source,
          seq: envelope.seq, type: envelope.type, detail: err.message,
        };
        this.state.rejects.push(rec);
        if (this.rejectPath) appendRejection(this.rejectPath, rec);
        return { accepted: false, ...rec };
      }
      throw err;
    }
    if (this.logPath) appendEvent(this.logPath, envelope);

    let derivedEvents = [];
    // 观察事件会改变现场条件；人工接管恢复是状态切换，也要立刻按当前条件重估
    const shouldDerive = deriveAfter
      && (OBSERVATIONS.has(envelope.type) || envelope.type === T.TAKEOVER_RESUMED)
      && !this.state.takeoverOpen;
    if (shouldDerive) {
      // derive 内部已把派生事件折叠进状态（含日志），这里只负责落盘
      derivedEvents = derive(this.state, envelope, this.clock.iso());
      for (const d of derivedEvents) {
        if (this.logPath) appendEvent(this.logPath, d);
      }
    }
    return { accepted: true, envelope, derived: derivedEvents };
  }

  /* --------------------------- 任务包引导 --------------------------- */

  async loadPackages(fixturesDir) {
    this.missionDoc = JSON.parse(await readFile(join(fixturesDir, 'robot_mission.json'), 'utf8'));
    const entries = await Promise.all(['map', 'route', 'content', 'policy'].map(async (k) => [
      k,
      JSON.parse(await readFile(join(fixturesDir, this.missionDoc.packages[k]), 'utf8')),
    ]));
    this.packages = Object.fromEntries(entries);
    return { mission: this.missionDoc, packages: this.packages };
  }

  /** 引导任务开始时（09:00）已知的基线：每个包只发布第一版，后续版本走在线发布。 */
  async bootstrap(fixturesDir) {
    const { mission, packages: pkgs } = await this.loadPackages(fixturesDir);
    const at = this.clock.iso();
    const ev = (source, seq, type, payload) => ({
      message_id: `${source}:${seq}`, source, seq, type, occurred_at: at,
      causal_prev: null, payload,
    });

    this.ingest(ev('ops', 1, T.MISSION_LOADED, {
      schema_version: mission.schema_version,
      record_id: mission.record_id,
      domain: mission.domain,
      mission_id: mission.mission.mission_id,
      tour_id: mission.mission.tour_id,
      device_id: mission.device.device_id,
      fleet_id: mission.device.fleet_id,
      route_id: mission.mission.route_id,
      content_id: mission.mission.content_id,
      limits: mission.limits,
    }), { deriveAfter: false });

    // 任务开始时只有 v1 可知；v1.1/v2 在现场变化发生时再在线发布
    const mapV1 = pkgs.map.versions[0];
    this.ingest(ev('map', mapV1.seq, T.MAP_PUBLISHED, {
      map_id: pkgs.map.map_id,
      version: mapV1.version,
      checkpoints: mapV1.checkpoints,
      edges: mapV1.edges,
      reason: `地图基线 ${mapV1.version}`,
      valid_from: mapV1.valid_from, valid_to: mapV1.valid_to,
    }), { deriveAfter: false });

    const routeV1 = pkgs.route.versions[0];
    this.ingest(ev('route', routeV1.seq, T.ROUTE_PUBLISHED, {
      route_id: pkgs.route.route_id,
      version: routeV1.version,
      segments: routeV1.segments,
      content_id: routeV1.content_id,
      content_version: routeV1.content_version,
      valid_from: routeV1.valid_from, valid_to: routeV1.valid_to,
    }), { deriveAfter: false });

    const contentV1 = pkgs.content.versions[0];
    this.ingest(ev('guide', contentV1.seq, T.CONTENT_PUBLISHED, {
      content_id: pkgs.content.content_id,
      version: contentV1.version,
      narrations: contentV1.narrations,
      supersedes: [],
      valid_from: contentV1.valid_from, valid_to: contentV1.valid_to,
    }), { deriveAfter: false });

    let safetySeq = 0;
    for (const c of pkgs.policy.constraints) {
      safetySeq += 1;
      this.ingest(ev('safety', safetySeq, T.CONSTRAINT_UPDATED, c), { deriveAfter: false });
    }
    for (const z of pkgs.policy.safety_zones) {
      safetySeq += 1;
      this.ingest(ev('safety', safetySeq, T.SAFETY_ZONE_UPDATED, z), { deriveAfter: false });
    }
    pkgs.policy.duties.forEach((d, i) => {
      this.ingest(ev('ops', i + 2, T.DUTY_ASSIGNED, d), { deriveAfter: false });
    });
    pkgs.policy.authorizations.forEach((g) => {
      this.ingest(ev('privacy', g.seq, T.AUTHORIZATION_PUBLISHED, g), { deriveAfter: false });
    });
    return this.state;
  }

  /* --------- 在线版本发布（地图平台/讲解团队在变化发生时推送） --------- */

  /** 按包定义发布指定地图版本；增量版本（新增节点/边、removed_edges）合并为完整快照。 */
  publishMapByVersion(version, { causalPrev = null } = {}) {
    const def = this.packages.map.versions.find((v) => String(v.version) === String(version));
    if (!def) throw new RejectError('invalid', `地图版本 ${version} 未在包中定义`);
    const cur = this.state.maps.get(`${this.packages.map.map_id}@${this.state.mapCurrent.version}`);
    const merged = mergeMap(
      { checkpoints: cur?.checkpoints ?? [], edges: cur?.edges ?? [] },
      def,
    );
    const seq = (this.state.perSourceSeq.get('map') ?? 0) + 1;
    return this.ingest({
      message_id: `map:${seq}`, source: 'map', seq,
      type: T.MAP_PUBLISHED, occurred_at: this.clock.iso(),
      causal_prev: causalPrev,
      payload: {
        map_id: this.packages.map.map_id, version: def.version,
        checkpoints: merged.checkpoints, edges: merged.edges,
        reason: def.reason ?? `地图 ${def.version}`,
        valid_from: def.valid_from, valid_to: def.valid_to,
      },
    }); // 在线发布触发重估（接管冻结时内核会自动跳过派生）
  }

  publishRouteByVersion(version, { setCurrent = true } = {}) {
    const def = this.packages.route.versions.find((v) => String(v.version) === String(version));
    if (!def) throw new RejectError('invalid', `路线版本 ${version} 未在包中定义`);
    const seq = (this.state.perSourceSeq.get('route') ?? 0) + 1;
    return this.ingest({
      message_id: `route:${seq}`, source: 'route', seq,
      type: T.ROUTE_PUBLISHED, occurred_at: this.clock.iso(),
      payload: {
        route_id: this.packages.route.route_id,
        version: def.version, segments: def.segments,
        content_id: def.content_id, content_version: def.content_version,
        reason: def.reason ?? `路线 ${def.version}`,
        valid_from: def.valid_from, valid_to: def.valid_to,
        set_current: setCurrent,
      },
    }); // 新路线可能使封路/高温降级成立或解除
  }

  publishContentByVersion(version, { setCurrent = true } = {}) {
    const def = this.packages.content.versions.find((v) => String(v.version) === String(version));
    if (!def) throw new RejectError('invalid', `讲解版本 ${version} 未在包中定义`);
    const seq = (this.state.perSourceSeq.get('guide') ?? 0) + 1;
    return this.ingest({
      message_id: `guide:${seq}`, source: 'guide', seq,
      type: T.CONTENT_PUBLISHED, occurred_at: this.clock.iso(),
      payload: {
        content_id: this.packages.content.content_id,
        version: def.version, narrations: def.narrations,
        supersedes: def.supersedes ?? [],
        valid_from: def.valid_from, valid_to: def.valid_to,
        set_current: setCurrent,
      },
    }, { deriveAfter: false });
  }

  /* --------------------------- 任务行驶进度 --------------------------- */

  startMission() {
    const route = this.state.routes.get(this.state.mission.route_id);
    const rv = route.versions.get(route.current);
    const seg1 = [...rv.segments.values()].sort((a, b) => a.seq - b.seq)[0];
    const seq = (this.state.perSourceSeq.get('device') ?? 0) + 1;
    return this.ingest({
      message_id: `device:${seq}:start`, source: 'device', seq,
      type: T.SEGMENT_STARTED, occurred_at: this.clock.iso(),
      payload: { route_id: this.state.mission.route_id, seq: seg1.seq, from_checkpoint: seg1.from_checkpoint },
    }, { deriveAfter: false });
  }

  checkpoint(checkpointId) {
    const seq = (this.state.perSourceSeq.get('device') ?? 0) + 1;
    return this.ingest({
      message_id: `device:${seq}:adv`, source: 'device', seq,
      type: T.SEGMENT_ADVANCED, occurred_at: this.clock.iso(),
      payload: { checkpoint_id: checkpointId },
    }, { deriveAfter: false });
  }

  completeSegment() {
    const seq = (this.state.perSourceSeq.get('device') ?? 0) + 1;
    return this.ingest({
      message_id: `device:${seq}:seg-done`, source: 'device', seq,
      type: T.SEGMENT_COMPLETED, occurred_at: this.clock.iso(), payload: {},
    }, { deriveAfter: false });
  }

  startNarration(narrationId, segSeq) {
    const seq = (this.state.perSourceSeq.get('device') ?? 0) + 1;
    return this.ingest({
      message_id: `device:${seq}:nar-start`, source: 'device', seq,
      type: T.NARRATION_STARTED, occurred_at: this.clock.iso(),
      payload: { narration_id: narrationId, seq: segSeq },
    }, { deriveAfter: false });
  }

  completeNarration(narrationId) {
    const seq = (this.state.perSourceSeq.get('device') ?? 0) + 1;
    return this.ingest({
      message_id: `device:${seq}:nar-done`, source: 'device', seq,
      type: T.NARRATION_COMPLETED, occurred_at: this.clock.iso(),
      payload: { narration_id: narrationId },
    }, { deriveAfter: false });
  }

  /* ----------------------------- 遥测/观察 ----------------------------- */

  /**
   * 接入一条观察/外部消息；序号按 source 空间自动连续分配。
   * opts.messageId 可固定 ID（用于和地图平台既有事件号对账），causalPrev 挂因果链。
   */
  observe(source, type, payload, opts = {}) {
    const { causalPrev = null, messageId } = opts;
    const seq = (this.state.perSourceSeq.get(source) ?? 0) + 1;
    return this.ingest({
      message_id: messageId ?? `evt-${source}-${seq}-${type}`,
      source, seq, type, occurred_at: this.clock.iso(),
      causal_prev: causalPrev, payload,
    });
  }

  /* ----------------------------- 人工接管 ----------------------------- */

  requestTakeover({ reason, requested_by, trigger, takeover_id }) {
    const seq = (this.state.perSourceSeq.get('operator') ?? 0) + 1;
    const id = takeover_id ?? lid('tk');
    return this.ingest({
      message_id: `operator:${seq}:request`, source: 'operator', seq,
      type: T.TAKEOVER_REQUESTED, occurred_at: this.clock.iso(),
      causal_prev: trigger ?? null,
      payload: {
        takeover_id: id, reason, requested_by,
        decision_ref: trigger,
      },
    }, { deriveAfter: false });
  }

  confirmTakeover(takeoverId, confirmer) {
    const seq = (this.state.perSourceSeq.get('operator') ?? 0) + 1;
    const res = this.ingest({
      message_id: `operator:${seq}:confirm`, source: 'operator', seq,
      type: T.TAKEOVER_CONFIRMED, occurred_at: this.clock.iso(),
      causal_prev: `operator:${seq - 1}:request`,
      payload: { takeover_id: takeoverId, confirmed_by: confirmer },
    }, { deriveAfter: false });
    if (!res.accepted) return res;

    // 冻结点：自动任务精确停在哪个检查点/路段/版本，暂停了哪些指令与讲解
    const s = this.state;
    const pr = s.progress;
    const freezeSeq = (s.perSourceSeq.get('operator') ?? 0) + 1;
    const rv = pr ? s.routes.get(pr.route_id)?.versions.get(s.routes.get(pr.route_id).current) : null;
    return this.ingest({
      message_id: `operator:${freezeSeq}:freeze`, source: 'operator', seq: freezeSeq,
      type: T.TAKEOVER_FROZEN, occurred_at: this.clock.iso(),
      causal_prev: `operator:${seq}:confirm`,
      payload: {
        takeover_id: takeoverId,
        freeze: {
          route_id: pr?.route_id ?? null,
          segment_seq: pr?.seg_seq ?? null,
          checkpoint_id: pr?.checkpoint_id ?? null,
          map_version: s.mapCurrent?.version ?? null,
          route_version: rv?.version ?? null,
          content_version: s.contentCurrent?.version ?? null,
          active_commands: [...s.commands.values()]
            .filter((c) => c.status === 'issued'
              && s.degradations.get(c.decision_id)?.status === 'active')
            .map((c) => c.command_id),
          paused_narrations: unfinishedNarrations(s).map((n) => ({
            id: n.id, status: n.status, seg_seq: n.seg_seq,
            await_disposition: n.await_disposition,
          })),
        },
      },
    }, { deriveAfter: false });
  }

  /** 未完成讲解必须有明确去向。 */
  delegateNarration(takeoverId, narrationId, disposition,
    { to = null, resumeCheckpoint = null, replacedBy = null } = {}) {
    const allowed = ['defer_to_checkpoint', 'resume_from_checkpoint', 'manual_continue', 'abandon', 'replaced_by'];
    if (!allowed.includes(disposition)) {
      throw new RejectError('invalid', `讲解去向必须是 ${allowed.join('/')} 之一`);
    }
    const seq = (this.state.perSourceSeq.get('operator') ?? 0) + 1;
    return this.ingest({
      message_id: `operator:${seq}:narration`, source: 'operator', seq,
      type: T.NARRATION_DELEGATED, occurred_at: this.clock.iso(),
      payload: {
        takeover_id: takeoverId, narration_id: narrationId,
        disposition, to, replaced_by: replacedBy,
        resume_checkpoint: (disposition === 'defer_to_checkpoint'
          || disposition === 'resume_from_checkpoint')
          ? (resumeCheckpoint
            ?? this.state.takeovers.get(takeoverId).resume_plan?.checkpoint_id ?? 'D')
          : null,
      },
    }, { deriveAfter: false });
  }

  prepareResume(takeoverId, {
    checkpoint_id, checked_by, safety_checks,
    map_version, route_version, content_version,
  }) {
    const s = this.state;
    const routeId = s.progress?.route_id ?? s.mission?.route_id;
    const route = s.routes.get(routeId);
    const useRouteV = String(route_version ?? route.current);
    const rv = route.versions.get(useRouteV);
    if (!rv) throw new RejectError('invalid', `路线版本 ${useRouteV} 尚未发布，不能据此恢复`);
    const useMapV = String(map_version ?? s.mapCurrent.version);
    const useContentV = String(content_version ?? rv.content_version);
    if (!s.maps.get(`${s.mapCurrent.id}@${useMapV}`)) {
      throw new RejectError('invalid', `地图版本 ${useMapV} 尚未发布，不能据此恢复`);
    }
    if (String(rv.content_version) !== useContentV) {
      throw new RejectError('invalid', `路线 ${useRouteV} 要求讲解 ${rv.content_version}，不是 ${useContentV}`);
    }
    // 恢复点必须在目标路线上
    const onRoute = [...rv.segments.values()].some(
      (g) => g.from_checkpoint === checkpoint_id || g.to_checkpoint === checkpoint_id);
    if (!onRoute) throw new RejectError('invalid', `检查点 ${checkpoint_id} 不在路线版本 ${useRouteV} 上`);
    const seq = (this.state.perSourceSeq.get('operator') ?? 0) + 1;
    return this.ingest({
      message_id: `operator:${seq}:resume-prep`, source: 'operator', seq,
      type: T.TAKEOVER_RESUME_PREPARED, occurred_at: this.clock.iso(),
      payload: {
        takeover_id: takeoverId,
        checkpoint_id,
        route_id: routeId,
        map_version: useMapV,
        route_version: useRouteV,
        content_version: useContentV,
        checked_by,
        safety_checks, // 逐项人工核验：围挡、路宽、积水、电量、定位…
      },
    }, { deriveAfter: false });
  }

  resumeAuto(takeoverId, { at_checkpoint, observed_map_version, confirmed_by }) {
    // 恢复闸门：计划已批，但按下恢复的瞬间仍要按当前现场条件评估；
    // 只要还有任何降级成因（暴雨/低电量/求助未解/传感器故障/无路可绕），就拒绝自动恢复。
    const blockers = evaluate(this.state, this.clock.now(), { forResume: true });
    const remaining = blockers.filter((x) => x.action !== 'detour'); // 绕行可自动处理
    if (remaining.length) {
      return {
        accepted: false, code: 'unsafe_to_resume',
        reason: `仍有未消除的降级成因：${remaining.map((x) => x.code).join(',')}`,
      };
    }
    const seq = (this.state.perSourceSeq.get('operator') ?? 0) + 1;
    // 默认派生：恢复自动任务的瞬间按当前现场条件重估（接管期堆积的成因需在此刻结清）
    return this.ingest({
      message_id: `operator:${seq}:resume`, source: 'operator', seq,
      type: T.TAKEOVER_RESUMED, occurred_at: this.clock.iso(),
      causal_prev: null,
      payload: {
        takeover_id: takeoverId, at_checkpoint, observed_map_version, confirmed_by,
      },
    });
  }

  closeTakeover(takeoverId, note) {
    const seq = (this.state.perSourceSeq.get('operator') ?? 0) + 1;
    return this.ingest({
      message_id: `operator:${seq}:close`, source: 'operator', seq,
      type: T.TAKEOVER_CLOSED, occurred_at: this.clock.iso(),
      payload: { takeover_id: takeoverId, note },
    }, { deriveAfter: false });
  }

  /* ------------------------ 离线/边缘与恢复同步 ------------------------ */

  /** 设备来源统一在这里取连续序号：被拒的消息不会留下序号空洞（真实设备会重传同序号）。 */
  _deviceMsg(type, payload) {
    const seq = (this.state.perSourceSeq.get('device') ?? 0) + 1;
    return this.ingest({
      message_id: `device:${seq}:${type}`, source: 'device', seq,
      type, occurred_at: this.clock.iso(), payload,
    }, { deriveAfter: false });
  }

  setConnectivity(online) {
    return this._deviceMsg(T.CONNECTIVITY, { online });
  }

  /**
   * 边缘离线采集：按数据类别授权过滤，只把白名单摘要写进日志；
   * 被剔除字段只记录字段名，绝不记值。
   */
  edgeCapture(capture) {
    const result = filterEdgeCapture(this.state, capture, this.clock.now());
    if (!result.allowed) {
      this._auditDenied(capture.data_class, result.reason);
      return { accepted: false, reason: result.reason };
    }
    const res = this._deviceMsg(T.EDGE_CAPTURE, {
      summary: {
        data_class: result.data_class,
        grant_id: result.grant_id,
        ...result.summary,
      },
      denied_field_names: result.denied_fields,
    });
    return { ...res, filtered: result };
  }

  syncUplink({ data_class, purpose, fields }) {
    const result = filterSyncUplink(this.state, { data_class, purpose, fields }, this.clock.now());
    if (!result.allowed) {
      this._auditDenied(data_class, result.reason, purpose);
      return { accepted: false, reason: result.reason };
    }
    return this._deviceMsg(T.SYNC_UPLINK, {
      data_class, purpose, grant_id: result.grant_id,
      cloud_retention: result.cloud_retention,
      fields: result.fields,
    });
  }

  _auditDenied(dataClass, reason, purpose = null) {
    const seq = (this.state.perSourceSeq.get('scheduler-audit') ?? 0) + 1;
    this.ingest({
      message_id: `scheduler-audit:${seq}:${dataClass}:${lid('x')}`,
      source: 'scheduler-audit', seq,
      type: T.ACCESS_DENIED, occurred_at: this.clock.iso(),
      payload: { data_class: dataClass, reason, purpose, at: this.clock.iso() },
    }, { deriveAfter: false });
  }

  /* ------------------------------- 查询 -------------------------------- */

  events() { return [...this.state.log]; }
  status() {
    const s = this.state;
    return {
      now: this.clock.iso(),
      control_mode: controlMode(s, this.clock.now()),
      online: s.connectivity.online,
      mission: s.mission ? { mission_id: s.mission.mission_id, device_id: s.mission.device_id } : null,
      versions: {
        map: s.mapCurrent,
        route: s.progress ? { route_id: s.progress.route_id, version: s.routes.get(s.progress.route_id)?.current } : null,
        content: s.contentCurrent,
      },
      progress: s.progress ? {
        route_id: s.progress.route_id,
        status: s.progress.status,
        segment_seq: s.progress.seg_seq,
        checkpoint_id: s.progress.checkpoint_id,
        narration: s.progress.narration_id
          ? (() => { const n = s.narrations.get(s.progress.narration_id); return {
            id: n.id, status: n.status, disposition: n.disposition ?? null,
            await_disposition: n.await_disposition,
          }; })()
          : null,
        unfinished_narrations: unfinishedNarrations(s).map((n) => ({
          id: n.id, status: n.status, disposition: n.disposition ?? null,
          assigned_to: n.assigned_to ?? null, resume_checkpoint: n.resume_checkpoint ?? null,
        })),
      } : null,
      active_degradations: [...s.degradations.values()]
        .filter((d) => d.status === 'active')
        .map((d) => ({
          decision_id: d.decision_id, code: d.code, action: d.action, reason: d.reason, owner: d.owner,
        })),
      open_takeover: s.takeoverOpen,
    };
  }

  answerAt(asOf) { return answerAt(this.state.log, asOf); }
  replayAs(asOf) { return replay(this.state.log, { asOf }); }
}

function mergeMap(acc, v) {
  const checkpoints = new Map(acc.checkpoints.map((c) => [c.id, c]));
  for (const c of v.checkpoints ?? []) checkpoints.set(c.id, c);
  const edges = new Map(acc.edges.map((e) => [`${e.from}->${e.to}`, e]));
  for (const e of v.edges ?? []) edges.set(`${e.from}->${e.to}`, e);
  for (const r of v.removed_edges ?? []) edges.delete(`${r.from}->${r.to}`);
  return {
    checkpoints: [...checkpoints.values()],
    edges: [...edges.values()],
  };
}

export { DEG_META };
