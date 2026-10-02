import { CAUSE_KIND, initialState, reduce } from './stateMachine.js';

/**
 * 控制台重放与事故报告。
 * 全部结论只由“事件日志 + 任务合同”推导，并标注每条记录发生时的
 * 地图版本与内容版本——不依赖设备当前状态猜测历史。
 */

/** 从头归约事件流，产出逐事件时间线。 */
export function buildTimeline(mission, events) {
  let state = initialState(mission);
  const entries = [];
  for (const event of events) {
    const { state: next } = reduce(mission, state, event);
    state = next;
    entries.push(state.history[state.history.length - 1]);
  }
  return { entries, final: state };
}

function ownerFor(mission, kind, at) {
  const resp = mission.responsibilities.find(
    (r) => r.kind === kind && Date.parse(r.valid_from) <= Date.parse(at) && Date.parse(at) <= Date.parse(r.valid_until),
  );
  return resp ? { owner: resp.owner, role: resp.role, resp_id: resp.resp_id } : { owner: null, role: null, resp_id: null };
}

/**
 * 事故报告：每一次降级在哪里发生、何时恢复、当时地图/内容版本、
 * 谁承担后续动作；接管记录含确认人、自动任务停止点与恢复检查点；
 * 未完成讲解逐条给出去向。
 */
export function incidentReport(mission, events) {
  const { entries, final } = buildTimeline(mission, events);
  const incidents = [];
  const open = new Map();
  let counter = 0;

  const closeIncident = (key, closingEntry) => {
    const opened = open.get(key);
    if (!opened) return;
    open.delete(key);
    incidents.push({ ...opened, ended_at: closingEntry.at, ended_seq: closingEntry.seq });
  };

  for (const entry of entries) {
    // 1) 停留类降级原因的出现与消失
    for (const cause of entry.causes) {
      if (!open.has(cause)) {
        counter += 1;
        open.set(cause, {
          incident_id: `INC-${String(counter).padStart(3, '0')}`,
          kind: CAUSE_KIND[cause] ?? cause,
          cause,
          segment_id: entry.segment_id,
          started_at: entry.at,
          started_seq: entry.seq,
          map_version: entry.map_version,
          content_version: entry.content_version,
          ...ownerFor(mission, CAUSE_KIND[cause] ?? cause, entry.at),
        });
      }
    }
    for (const key of [...open.keys()]) {
      if (['road_closed', 'visitor_help'].includes(key)) continue;
      if (!entry.causes.includes(key)) closeIncident(key, entry);
    }

    // 2) 道路封闭 / 绕行
    if (entry.detour && !open.has('road_closed')) {
      counter += 1;
      open.set('road_closed', {
        incident_id: `INC-${String(counter).padStart(3, '0')}`,
        kind: 'road_closed',
        cause: 'road_closed',
        segment_id: entry.detour,
        started_at: entry.at,
        started_seq: entry.seq,
        map_version: entry.map_version,
        content_version: entry.content_version,
        explanation: entry.detour_explanation,
        ...ownerFor(mission, 'road_closed', entry.at),
      });
    }
    if (!entry.detour && open.has('road_closed')) closeIncident('road_closed', entry);
  }

  // 报告生成时仍未结束的降级也要可见
  for (const [key, opened] of open) {
    incidents.push({ ...opened, ended_at: null, ended_seq: null, ongoing: true });
  }

  // 3) 接管记录：谁确认、自动任务停在哪里、何时经过新检查点恢复
  const takeovers = [...final.takeover_history, ...(final.takeover ? [final.takeover] : [])].map((t) => ({
    requested_at: t.requested_at,
    requested_by: t.requested_by,
    stopped_segment: t.stopped_segment,
    stopped_mode: t.stopped_mode,
    confirmed_by: t.confirmed_by,
    confirmed_at: t.confirmed_at,
    resumed_at: t.resumed_at,
    resume_checkpoint: t.resume_checkpoint,
    ongoing: !t.resumed_at,
    ...ownerFor(mission, 'visitor_help', t.requested_at),
  }));

  // 4) 未完成讲解的去向
  const unfinishedNarrations = Object.entries(final.narrations)
    .filter(([, n]) => n.status !== 'delivered')
    .map(([narration_id, n]) => ({
      narration_id,
      title: n.title,
      segment_id: n.segment_id,
      status: n.status,
      reason: n.reason,
      decided_by: n.decided_by,
    }));

  incidents.sort((a, b) => a.started_seq - b.started_seq);

  return {
    mission_id: mission.mission_id,
    device_id: mission.device.device_id,
    generated_from: { event_count: events.length, last_seq: final.last_seq },
    mission_status: final.status,
    incidents,
    takeovers,
    unfinished_narrations: unfinishedNarrations,
  };
}

/** 控制台文本重放：一行一个已接受事件，含发生时的版本与说明。 */
export function renderConsole(entries) {
  return entries
    .map((e) => {
      const notes = e.notes.length ? ` | ${e.notes.join(' ; ')}` : '';
      const causes = e.causes.length ? ` causes=${e.causes.join(',')}` : '';
      return `#${String(e.seq).padStart(3, '0')} ${e.at} ${e.type} → ${e.mode} @${e.segment_id} [map ${e.map_version} / content ${e.content_version}]${causes}${notes}`;
    })
    .join('\n');
}
