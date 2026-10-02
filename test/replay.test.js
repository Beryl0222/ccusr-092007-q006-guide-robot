import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, incidentReport, renderConsole } from '../src/replay.js';
import { loadTestMission, ev } from './helpers.js';

async function scenario() {
  const mission = await loadTestMission();
  const events = [
    ev(1, 'telemetry', { position_confidence: 0.9, battery_pct: 80 }),
    ev(2, 'checkpoint_reached', { segment_id: 'S1', checkpoint_id: 'CP-PLAZA' }),
    ev(3, 'position_degraded', { position_confidence: 0.2 }, { at: '2026-09-20T09:30:00+08:00' }),
    ev(4, 'position_recovered', {}, { at: '2026-09-20T09:35:00+08:00' }),
    ev(5, 'visitor_help', { visitor: '游客甲' }, { at: '2026-09-20T09:40:00+08:00' }),
    ev(6, 'takeover_confirmed', { operator: '林岚' }, { at: '2026-09-20T09:42:00+08:00' }),
    ev(7, 'takeover_resumed', { checkpoint_id: 'CP-HILL' }, { at: '2026-09-20T09:50:00+08:00' }),
    ev(8, 'road_closed', { segment_id: 'S4', reason: '暴雨积水', decided_by: '陈默' }, { at: '2026-09-20T10:00:00+08:00' }),
    ev(9, 'map_update', { version: '2026.09.20' }, { at: '2026-09-20T10:05:00+08:00' }),
  ];
  return { mission, events };
}

test('事故报告：降级位置、责任人与发生时的版本都可回答', async () => {
  const { mission, events } = await scenario();
  const report = incidentReport(mission, events);

  const position = report.incidents.find((i) => i.cause === 'low_position_confidence');
  assert.equal(position.segment_id, 'S2');
  assert.equal(position.owner, '赵启');
  assert.equal(position.role, '设备组');
  assert.equal(position.map_version, '2026.09.18');
  assert.equal(position.started_at, '2026-09-20T09:30:00+08:00');
  assert.equal(position.ended_at, '2026-09-20T09:35:00+08:00');

  const road = report.incidents.find((i) => i.kind === 'road_closed');
  assert.equal(road.segment_id, 'S4');
  assert.equal(road.owner, '陈默');
  assert.ok(road.explanation.includes('暴雨积水'));
  assert.equal(road.ongoing, true);
});

test('接管记录：谁确认、停在哪里、经哪个检查点恢复', async () => {
  const { mission, events } = await scenario();
  const report = incidentReport(mission, events);
  assert.equal(report.takeovers.length, 1);
  const t = report.takeovers[0];
  assert.equal(t.stopped_segment, 'S2');
  assert.equal(t.confirmed_by, '林岚');
  assert.equal(t.resume_checkpoint, 'CP-HILL');
  assert.equal(t.owner, '林岚');
  assert.equal(t.ongoing, false);
});

test('未完成讲解都有明确去向', async () => {
  const { mission, events } = await scenario();
  const report = incidentReport(mission, events);
  const byId = Object.fromEntries(report.unfinished_narrations.map((n) => [n.narration_id, n]));
  // 接管恢复点 CP-HILL 之前被绕过的 N2
  assert.equal(byId.N2.status, 'skipped');
  assert.equal(byId.N2.decided_by, '林岚');
  // S4 因道路封闭被挂起的 N4
  assert.equal(byId.N4.status, 'deferred');
  assert.equal(byId.N4.reason, 'road_closed');
  // N1 已交付，不在未完成列表
  assert.equal(byId.N1, undefined);
});

test('控制台重放按发生时的地图/内容版本呈现', async () => {
  const { mission, events } = await scenario();
  const { entries } = buildTimeline(mission, events);
  const text = renderConsole(entries);
  assert.ok(text.includes('visitor_help → HUMAN_TAKEOVER @S2 [map 2026.09.18 / content v12]'));
  assert.ok(text.includes('takeover_resumed_at:CP-HILL'));
  // 地图更新后的事件使用新版本
  const after = entries.find((e) => e.type === 'map_update');
  assert.equal(after.map_version, '2026.09.20');
});
