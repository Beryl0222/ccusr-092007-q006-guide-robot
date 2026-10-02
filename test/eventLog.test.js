import test from 'node:test';
import assert from 'node:assert/strict';
import { CausalEventLog, REJECT } from '../src/eventLog.js';
import { ev } from './helpers.js';

test('接受按序、未过期的消息', () => {
  const log = new CausalEventLog({ deviceId: 'robot-07' });
  assert.equal(log.append(ev(1, 'telemetry')).accepted, true);
  assert.equal(log.append(ev(2, 'telemetry')).accepted, true);
  assert.equal(log.lastSeq, 2);
  assert.equal(log.events.length, 2);
});

test('重复 event_id 被拒绝', () => {
  const log = new CausalEventLog({ deviceId: 'robot-07' });
  const dup = ev(1, 'telemetry', {}, { id: 'E-dup' });
  assert.equal(log.append(dup).accepted, true);
  const again = log.append({ ...dup, causal_seq: 2 });
  assert.equal(again.accepted, false);
  assert.equal(again.reason, REJECT.DUPLICATE);
});

test('乱序 causal_seq 被拒绝，状态不回退', () => {
  const log = new CausalEventLog({ deviceId: 'robot-07' });
  log.append(ev(5, 'telemetry'));
  const stale = log.append(ev(3, 'telemetry'));
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, REJECT.STALE_SEQ);
  assert.equal(log.lastSeq, 5);
});

test('超过 valid_until 的消息被拒绝', () => {
  const log = new CausalEventLog({ deviceId: 'robot-07' });
  const expired = ev(1, 'telemetry', {}, { valid_until: '2026-09-20T10:00:00+08:00' });
  const result = log.append(expired, '2026-09-20T11:00:00+08:00');
  assert.equal(result.accepted, false);
  assert.equal(result.reason, REJECT.EXPIRED);
});

test('其他设备的消息被拒绝', () => {
  const log = new CausalEventLog({ deviceId: 'robot-07' });
  const result = log.append(ev(1, 'telemetry', {}, { device_id: 'robot-99' }));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, REJECT.WRONG_DEVICE);
});

test('缺字段的消息被拒绝', () => {
  const log = new CausalEventLog({ deviceId: 'robot-07' });
  assert.equal(log.append({ event_id: 'x' }).reason, REJECT.MALFORMED);
});
