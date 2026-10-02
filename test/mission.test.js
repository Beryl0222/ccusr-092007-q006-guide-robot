import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMission, loadMission } from '../src/contracts.js';
import { FIXTURE_PATH } from './helpers.js';

test('任务合同包含全部带因果序号与有效期的要素', async () => {
  const record = await loadMission(FIXTURE_PATH);
  const m = record.mission;
  for (const key of ['route', 'narrations', 'weather_limits', 'safety_zones', 'responsibilities']) {
    for (const item of m[key]) {
      assert.ok(Number.isInteger(item.seq), `${key} 缺 seq`);
      assert.ok(Date.parse(item.valid_from) < Date.parse(item.valid_until), `${key} 有效期无效`);
    }
  }
  assert.ok(Number.isInteger(m.battery_policy.seq));
  assert.equal(m.device.device_id, 'robot-07');
  assert.equal(m.map.version, '2026.09.18');
  assert.equal(m.content.version, 'v12');
});

test('缺少有效期或序号的要素被拒绝', async () => {
  const record = await loadMission(FIXTURE_PATH);
  const broken = JSON.parse(JSON.stringify(record));
  delete broken.mission.route[0].valid_until;
  assert.throws(() => validateMission(broken), /有效期无效/);
  const noSeq = JSON.parse(JSON.stringify(record));
  delete noSeq.mission.responsibilities[0].seq;
  assert.throws(() => validateMission(noSeq), /因果序号/);
});

test('讲解引用不存在的路段被拒绝', async () => {
  const record = await loadMission(FIXTURE_PATH);
  const broken = JSON.parse(JSON.stringify(record));
  broken.mission.narrations[0].segment_id = 'S-UNKNOWN';
  assert.throws(() => validateMission(broken), /不存在的路段/);
});
