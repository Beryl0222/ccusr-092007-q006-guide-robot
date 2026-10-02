import test from 'node:test';
import assert from 'node:assert/strict';
import { T } from '../src/events.js';
import { freshBackend, movingBackend } from './helpers.js';

test('重复消息被拒绝且不重复生效', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:11:00+08:00');
  const first = b.observe('device', T.POSITION, { lat: 1, lng: 1, confidence: 0.5 });
  assert.equal(first.accepted, true);
  const logLen = b.events().length;
  const again = b.ingest({ ...first.envelope });
  assert.equal(again.accepted, false);
  assert.equal(again.code, 'duplicate');
  assert.equal(b.events().length, logLen, '重复消息不写入日志');
});

test('旧序号（乱序/倒退）被拒绝，设备状态不倒退', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:11:00+08:00');
  b.observe('device', T.POSITION, { lat: 30.25, lng: 120.15, confidence: 0.9 });
  const last = b.state.perSourceSeq.get('device');
  const res = b.ingest({
    message_id: 'device:old-1', source: 'device', seq: 1,
    type: T.POSITION, occurred_at: clock.iso(),
    payload: { lat: 99, lng: 99, confidence: 0.01 }, // 恶意旧坐标
  });
  assert.equal(res.accepted, false);
  assert.equal(res.code, 'stale');
  assert.equal(b.state.perSourceSeq.get('device'), last);
  assert.notEqual(b.state.telemetry.position.lat, 99, '旧消息不能覆盖当前位置');
});

test('序号空洞（gap）被拒绝，等待中间消息补齐', async () => {
  const { b, clock } = await freshBackend();
  const last = b.state.perSourceSeq.get('cloud') ?? 0;
  const res = b.ingest({
    message_id: 'cloud:gap', source: 'cloud', seq: last + 2,
    type: T.ROAD_REOPENED, occurred_at: clock.iso(),
    payload: { from: 'A', to: 'B' },
  });
  assert.equal(res.code, 'gap');
});

test('前因未知（断链）消息被拒绝', async () => {
  const { b, clock } = await freshBackend();
  const seq = (b.state.perSourceSeq.get('cloud') ?? 0) + 1;
  const res = b.ingest({
    message_id: `cloud:${seq}:orphan`, source: 'cloud', seq,
    type: T.ROAD_CLOSED, occurred_at: clock.iso(),
    causal_prev: 'message-that-never-arrived',
    payload: { from: 'A', to: 'B', reason: 'x' },
  });
  assert.equal(res.code, 'orphan');
});

test('接收时已过期的消息被拒绝', async () => {
  const { b, clock } = await freshBackend();
  clock.set('2026-09-20T10:00:00+08:00');
  const seq = (b.state.perSourceSeq.get('safety') ?? 0) + 1;
  const res = b.ingest({
    message_id: `safety:${seq}:expired`, source: 'safety', seq,
    type: T.CONSTRAINT_UPDATED, occurred_at: clock.iso(),
    valid_to: '2026-09-20T09:00:00+08:00',
    payload: { code: 'storm', condition: { storm_level_gte: 1 }, seq },
  });
  assert.equal(res.code, 'expired');
});

test('不同来源拥有独立序号空间，互不干扰', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:12:00+08:00');
  const r1 = b.observe('cloud', T.ROAD_REOPENED, { from: 'A', to: 'B' });
  const r2 = b.observe('weather', T.WEATHER, { temperature_c: 30, storm_level: 0 });
  assert.equal(r1.accepted, true);
  assert.equal(r2.accepted, true);
  assert.equal(r1.envelope.seq, 1);
  assert.equal(r2.envelope.seq, 1);
});

test('所有被拒消息都进入审计记录', async () => {
  const { b } = await movingBackend();
  const before = b.state.rejects.length;
  b.ingest({
    message_id: 'device:1', source: 'device', seq: 1,
    type: T.POSITION, occurred_at: new Date().toISOString(),
    payload: {},
  });
  assert.ok(b.state.rejects.length > before);
});
