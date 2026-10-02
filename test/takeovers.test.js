import test from 'node:test';
import assert from 'node:assert/strict';
import { T } from '../src/events.js';
import { movingBackend } from './helpers.js';

test('双人确认：同一人请求又确认被拒绝', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:36:00+08:00');
  b.observe('device', T.VISITOR_HELP, { topic: '走散' });
  b.requestTakeover({
    takeover_id: 'TK-1', reason: '求助',
    requested_by: { staff_id: 'S-101', name: '林岚' },
  });
  const res = b.confirmTakeover('TK-1', { staff_id: 'S-101', name: '林岚' });
  assert.equal(res.accepted, false);
  assert.equal(res.code, 'invalid');
  assert.equal(b.status().open_takeover, null, '确认失败不应进入接管态');
});

test('完整接管生命周期：请求→确认→冻结→讲解去向→新检查点恢复', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:15:00+08:00');
  b.publishMapByVersion('1.1');
  b.publishRouteByVersion('1.1');
  b.publishContentByVersion('1.1');
  b.completeSegment(); // 到 B→F
  b.startNarration('N-BF', 2);

  clock.set('2026-09-20T09:36:00+08:00');
  const help = b.observe('device', T.VISITOR_HELP, { topic: '走散' });
  b.requestTakeover({
    takeover_id: 'TK-1', reason: '求助',
    requested_by: { staff_id: 'S-101', name: '林岚' },
    trigger: help.envelope.message_id,
  });
  const confirm = b.confirmTakeover('TK-1', { staff_id: 'S-204', name: '郑海' });
  assert.equal(confirm.accepted, true);
  assert.equal(b.status().control_mode, 'manual');

  const freeze = b.state.takeovers.get('TK-1').freeze;
  assert.equal(freeze.checkpoint_id, 'B');
  assert.equal(String(freeze.map_version), '1.1');
  assert.ok(freeze.paused_narrations.some((n) => n.id === 'N-BF' && n.await_disposition));
  assert.equal(b.status().progress.status, 'frozen');

  // 未完成讲解必须有去向
  b.delegateNarration('TK-1', 'N-BF', 'defer_to_checkpoint', { resumeCheckpoint: 'F' });
  const narr = b.state.narrations.get('N-BF');
  assert.equal(narr.disposition, 'defer_to_checkpoint');
  assert.equal(narr.resume_checkpoint, 'F');

  // 恢复计划必须基于已发布版本
  clock.set('2026-09-20T09:40:00+08:00');
  b.checkpoint('F');
  b.prepareResume('TK-1', {
    checkpoint_id: 'F', checked_by: { staff_id: 'S-309', name: '高越' },
    safety_checks: [{ item: '现场安全', result: 'pass' }],
    map_version: '1.1', route_version: '1.1', content_version: '1.1',
  });
  // 求助尚未处理完时，恢复闸门拒绝自动恢复
  const unsafe = b.resumeAuto('TK-1', {
    at_checkpoint: 'F', observed_map_version: '1.1', confirmed_by: { staff_id: 'S-309' } });
  assert.equal(unsafe.accepted, false);
  assert.equal(unsafe.code, 'unsafe_to_resume');
  // 现场处置完毕、求助关闭后才允许恢复
  b.observe('device', T.VISITOR_HELP, { resolved: true });
  const wrong = b.resumeAuto('TK-1', {
    at_checkpoint: 'F', observed_map_version: '1', confirmed_by: { staff_id: 'S-309' } });
  assert.equal(wrong.accepted, false, '设备地图版本不符拒绝恢复');
  const ok = b.resumeAuto('TK-1', {
    at_checkpoint: 'F', observed_map_version: '1.1', confirmed_by: { staff_id: 'S-309' } });
  assert.equal(ok.accepted, true);
  assert.equal(b.status().control_mode, 'auto');
});

test('准备恢复时检查点不在目标路线上被拒绝', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:36:00+08:00');
  b.observe('device', T.VISITOR_HELP, { topic: '走散' });
  b.requestTakeover({ takeover_id: 'TK-2', reason: 'x', requested_by: { staff_id: 'S-101' } });
  b.confirmTakeover('TK-2', { staff_id: 'S-204' });
  assert.throws(
    () => b.prepareResume('TK-2', {
      checkpoint_id: 'Z-NOPE', checked_by: { staff_id: 'S-309' },
      safety_checks: [], map_version: '1', route_version: '1', content_version: '1',
    }),
    /不在路线/,
  );
});

test('接管冻结点记录了精确的版本三元组，且可在重放中还原', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:36:00+08:00');
  const help = b.observe('device', T.VISITOR_HELP, { topic: '走散' });
  b.requestTakeover({
    takeover_id: 'TK-3', reason: 'x',
    requested_by: { staff_id: 'S-101' }, trigger: help.envelope.message_id,
  });
  b.confirmTakeover('TK-3', { staff_id: 'S-204' });
  const answer = b.answerAt(clock.iso());
  assert.equal(answer.takeover.freeze.map_version, '1');
  assert.equal(answer.takeover.confirmed_by.staff_id, 'S-204');
  assert.equal(answer.takeover.requested_by.staff_id, 'S-101');
});
