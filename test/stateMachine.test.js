import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionRuntime } from '../src/runtime.js';
import { loadTestMission, ev } from './helpers.js';

test('定位置信不足 → 就地等待，恢复后回到自动', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'telemetry', { position_confidence: 0.3, battery_pct: 80 }));
  assert.equal(rt.state.mode, 'WAIT_IN_PLACE');
  assert.ok(rt.state.causes.low_position_confidence);
  rt.ingest(ev(2, 'position_recovered'));
  assert.equal(rt.state.mode, 'AUTO');
});

test('传感器异常 → 暂停；无对应原因时的恢复消息被忽略', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'sensor_fault', { sensor: 'lidar' }));
  assert.equal(rt.state.mode, 'PAUSED');
  rt.ingest(ev(2, 'sensor_recovered'));
  assert.equal(rt.state.mode, 'AUTO');
  const again = rt.ingest(ev(3, 'sensor_recovered'));
  assert.ok(again.notes.some((n) => n.startsWith('ignored_stale_recovery')));
  assert.equal(rt.state.mode, 'AUTO');
});

test('电量低于路段要求 → 就地等待', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'telemetry', { position_confidence: 0.9, battery_pct: 5 }));
  assert.equal(rt.state.mode, 'WAIT_IN_PLACE');
  assert.ok(rt.state.causes.low_battery);
});

test('过期、重复、乱序消息不会让设备状态倒退', async () => {
  const mission = await loadTestMission();
  const clean = new MissionRuntime(mission);
  const noisy = new MissionRuntime(mission);
  const seq = [
    ev(1, 'telemetry', { position_confidence: 0.9, battery_pct: 80 }),
    ev(2, 'sensor_fault', { sensor: 'imu' }),
    ev(3, 'sensor_recovered'),
    ev(4, 'checkpoint_reached', { segment_id: 'S1', checkpoint_id: 'CP-PLAZA' }),
    ev(5, 'telemetry', { position_confidence: 0.9, battery_pct: 70 }),
  ];
  for (const e of seq) clean.ingest(e);
  // 同样的顺序，但沿途注入脏消息
  const dup = { ...seq[1], causal_seq: 6 }; // 重复 event_id
  const stale = ev(2, 'sensor_fault', { sensor: 'imu' }, { id: 'E-stale' }); // 乱序
  const expired = ev(6, 'position_degraded', {}, { id: 'E-exp', valid_until: '2026-09-20T09:00:00+08:00' });
  noisy.ingest(seq[0]);
  noisy.ingest(seq[1]);
  assert.equal(noisy.ingest(dup).accepted, false);
  noisy.ingest(seq[2]);
  noisy.ingest(seq[3]);
  assert.equal(noisy.ingest(stale).accepted, false);
  assert.equal(noisy.ingest(expired, '2026-09-20T10:00:00+08:00').accepted, false);
  noisy.ingest(seq[4]);
  assert.deepEqual(noisy.state, clean.state);
});

test('人工接管：确认人、停止点、恢复检查点完整可重放', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'telemetry', { position_confidence: 0.9, battery_pct: 80 }));
  rt.ingest(ev(2, 'checkpoint_reached', { segment_id: 'S1', checkpoint_id: 'CP-PLAZA' }));
  assert.equal(rt.state.narrations.N1.status, 'delivered');

  rt.ingest(ev(3, 'visitor_help', { visitor: '游客甲' }));
  assert.equal(rt.state.mode, 'HUMAN_TAKEOVER');
  assert.equal(rt.state.takeover.stopped_segment, 'S2');
  assert.equal(rt.state.narrations.N2.status, 'deferred');

  // 接管期间自动恢复消息不得退出接管
  const ignored = rt.ingest(ev(4, 'position_recovered'));
  assert.ok(ignored.notes.includes('ignored_during_takeover'));
  assert.equal(rt.state.mode, 'HUMAN_TAKEOVER');

  rt.ingest(ev(5, 'takeover_confirmed', { operator: '林岚' }));
  const resumed = rt.ingest(ev(6, 'takeover_resumed', { checkpoint_id: 'CP-LAKE' }));
  assert.equal(rt.state.mode, 'AUTO');
  assert.ok(resumed.notes.includes('takeover_resumed_at:CP-LAKE'));

  const [record] = rt.state.takeover_history;
  assert.equal(record.confirmed_by, '林岚');
  assert.equal(record.stopped_segment, 'S2');
  assert.equal(record.resume_checkpoint, 'CP-LAKE');
  assert.equal(rt.state.narrations.N2.status, 'pending');
});

test('未确认的接管不能恢复；绕过路段的讲解被明确标记去向', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'visitor_help', { visitor: '游客乙' }));
  const early = rt.ingest(ev(2, 'takeover_resumed', { checkpoint_id: 'CP-HILL' }));
  assert.ok(early.notes.includes('resume_requires_confirmation'));
  assert.equal(rt.state.mode, 'HUMAN_TAKEOVER');

  rt.ingest(ev(3, 'takeover_confirmed', { operator: '林岚' }));
  rt.ingest(ev(4, 'takeover_resumed', { checkpoint_id: 'CP-HILL' }));
  assert.equal(rt.state.mode, 'AUTO');
  assert.equal(rt.state.segment_id, 'S3');
  assert.deepEqual(rt.state.bypassed_segments, ['S1', 'S2']);
  assert.equal(rt.state.narrations.N1.status, 'skipped');
  assert.equal(rt.state.narrations.N1.reason, 'bypassed_by_takeover');
  assert.equal(rt.state.narrations.N1.decided_by, '林岚');
  assert.equal(rt.state.narrations.N3.status, 'pending');
});

test('道路封闭 → 可说明的绕行；重开后恢复', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'telemetry', { position_confidence: 0.9, battery_pct: 80 }));
  const closed = rt.ingest(ev(2, 'road_closed', { segment_id: 'S3', reason: '施工围挡', decided_by: '陈默' }));
  assert.equal(rt.state.mode, 'DETOUR');
  assert.ok(rt.state.detour.explanation.includes('林荫道'));
  assert.ok(rt.state.detour.explanation.includes('施工围挡'));
  assert.ok(rt.state.detour.explanation.includes('2026.09.18'));
  assert.equal(rt.state.narrations.N3.status, 'deferred');

  rt.ingest(ev(3, 'road_reopened', { segment_id: 'S3' }));
  assert.equal(rt.state.mode, 'AUTO');
  assert.equal(rt.state.narrations.N3.status, 'pending');
});

test('暴雨限制在有效期内才生效，过期告警被忽略', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'weather_alert', { limit_id: 'WL-RAIN-0920' }, { at: '2026-09-20T10:30:00+08:00' }));
  assert.equal(rt.state.mode, 'PAUSED');
  assert.ok(rt.state.causes.weather_suspend);
  rt.ingest(ev(2, 'weather_cleared', { limit_id: 'WL-RAIN-0920' }, { at: '2026-09-20T11:00:00+08:00' }));
  assert.equal(rt.state.mode, 'AUTO');

  const expired = rt.ingest(ev(3, 'weather_alert', { limit_id: 'WL-RAIN-0920' }, { at: '2026-09-20T13:00:00+08:00' }));
  assert.ok(expired.notes.some((n) => n.startsWith('weather_limit_not_in_validity')));
  assert.equal(rt.state.mode, 'AUTO');
});

test('高温限制只登记限速，不停车', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  rt.ingest(ev(1, 'weather_alert', { limit_id: 'WL-HEAT-0920' }, { at: '2026-09-20T14:00:00+08:00' }));
  assert.equal(rt.state.mode, 'AUTO');
  assert.equal(rt.state.restrictions.length, 1);
  assert.equal(rt.state.restrictions[0].action, 'reduce_speed');
});

test('依次到达检查点则任务完成，沿途讲解全部交付', async () => {
  const mission = await loadTestMission();
  const rt = new MissionRuntime(mission);
  const legs = [
    ['S1', 'CP-PLAZA'],
    ['S2', 'CP-LAKE'],
    ['S3', 'CP-HILL'],
    ['S4', 'CP-EXIT'],
  ];
  let seq = 0;
  for (const [segment_id, checkpoint_id] of legs) {
    seq += 1;
    rt.ingest(ev(seq, 'checkpoint_reached', { segment_id, checkpoint_id }));
  }
  assert.equal(rt.state.status, 'COMPLETED');
  assert.ok(Object.values(rt.state.narrations).every((n) => n.status === 'delivered'));
});
