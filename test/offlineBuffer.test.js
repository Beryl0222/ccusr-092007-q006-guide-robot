import test from 'node:test';
import assert from 'node:assert/strict';
import { EdgeBuffer } from '../src/offlineBuffer.js';
import { loadTestMission } from './helpers.js';

test('离线期间只保存业务摘要，对话与影像默认不留存', async () => {
  const mission = await loadTestMission();
  const buf = new EdgeBuffer({ consent: mission.consent });
  assert.equal(buf.record({ item_id: 'b1', kind: 'business_summary', occurred_at: '2026-09-20T10:00:00+08:00' }).stored, true);
  assert.equal(buf.record({ item_id: 'd1', kind: 'visitor_dialogue' }).stored, false);
  assert.equal(buf.record({ item_id: 'i1', kind: 'imagery' }).stored, false);
  assert.equal(buf.size, 1);
});

test('恢复联网不能扩大用途：未授权用途一律留存不上传', async () => {
  const mission = await loadTestMission();
  const buf = new EdgeBuffer({ consent: mission.consent, now: () => '2026-09-21T09:00:00+08:00' });
  buf.record({ item_id: 'b1', kind: 'business_summary' });

  const bad = buf.sync('marketing');
  assert.equal(bad.uploaded.length, 0);
  assert.equal(bad.withheld.length, 1);
  assert.equal(bad.withheld[0].reason, 'purpose_not_granted');
  assert.equal(buf.size, 1);

  const good = buf.sync('operations');
  assert.equal(good.uploaded.length, 1);
  assert.equal(buf.size, 0);
});

test('授权过期的数据在同步时清除', async () => {
  const mission = await loadTestMission();
  const consent = structuredClone(mission.consent);
  consent.business_summary.valid_until = '2026-09-20T12:00:00+08:00';
  const buf = new EdgeBuffer({ consent, now: () => '2026-09-21T09:00:00+08:00' });
  buf.record({ item_id: 'b1', kind: 'business_summary' });
  const result = buf.sync('operations');
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.purged.length, 1);
  assert.equal(result.purged[0].reason, 'consent_expired');
});

test('对话数据在获得本地留存授权时可保存，但仍按各自用途同步', async () => {
  const mission = await loadTestMission();
  const consent = structuredClone(mission.consent);
  consent.visitor_dialogue.retain_locally = true;
  const buf = new EdgeBuffer({ consent, now: () => '2026-09-21T09:00:00+08:00' });
  buf.record({ item_id: 'd1', kind: 'visitor_dialogue' });
  // 对话授权用途是 service_record，安全审计不能顺带拿走
  const audit = buf.sync('safety_audit');
  assert.equal(audit.uploaded.length, 0);
  assert.equal(audit.withheld.length, 1);
  const record = buf.sync('service_record');
  assert.equal(record.uploaded.length, 1);
});
