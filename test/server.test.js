import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { FIXTURE_PATH, ev } from './helpers.js';

async function withServer(fn) {
  const { server } = await createServer({ missionPath: FIXTURE_PATH });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('后端可独立运行：事件接入、状态查询、事故报告', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const fault = ev(1, 'sensor_fault', { sensor: 'lidar' });
    const accepted = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fault),
    }).then((r) => r.json());
    assert.equal(accepted.accepted, true);

    const state = await fetch(`${base}/state`).then((r) => r.json());
    assert.equal(state.mode, 'PAUSED');

    // 同一 event_id 的重发被 409 拒绝，状态不倒退
    const dup = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...fault, causal_seq: 2 }),
    });
    assert.equal(dup.status, 409);

    const report = await fetch(`${base}/incidents`).then((r) => r.json());
    const incident = report.incidents.find((i) => i.cause === 'sensor_fault');
    assert.equal(incident.owner, '赵启');
    assert.equal(incident.segment_id, 'S1');

    const consoleText = await fetch(`${base}/console`).then((r) => r.text());
    assert.ok(consoleText.includes('sensor_fault → PAUSED'));
  });
});

test('离线缓冲接口：对话默认不留存，摘要按授权同步', async () => {
  await withServer(async (base) => {
    const dialogue = await fetch(`${base}/buffer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_id: 'd1', kind: 'visitor_dialogue' }),
    }).then((r) => r.json());
    assert.equal(dialogue.stored, false);

    await fetch(`${base}/buffer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_id: 'b1', kind: 'business_summary' }),
    });
    const widened = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'marketing' }),
    }).then((r) => r.json());
    assert.equal(widened.uploaded.length, 0);
    assert.equal(widened.withheld.length, 1);
  });
});
