import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../src/backend.js';
import { Clock } from '../src/clock.js';
import { T } from '../src/events.js';
import { runScenario } from '../src/scenario.js';

test('answerAt 以发生时版本复盘：v1→v1.1→v2 不被未来污染', async () => {
  const { backend: b } = await runScenario({ quiet: true });
  const at912 = b.answerAt('2026-09-20T09:12:40+08:00');
  assert.equal(at912.versions.map.version, '1');
  assert.equal(String(at912.versions.route.version), '1');

  const at920 = b.answerAt('2026-09-20T09:20:00+08:00');
  assert.equal(at920.versions.map.version, '1.1');
  assert.equal(String(at920.versions.route.version), '1.1');

  const at1050 = b.answerAt('2026-09-20T10:50:00+08:00');
  assert.equal(at1050.versions.map.version, '2');
  assert.equal(String(at1050.versions.route.version), '2');
  assert.equal(at1050.versions.content.version, '1.1');
});

test('历史复盘能准确回答责任人，而非用当前值班猜测', async () => {
  const { backend: b } = await runScenario({ quiet: true });
  const at933 = b.answerAt('2026-09-20T09:33:30+08:00');
  const storm = at933.degradations.find((d) => d.code === 'storm_suspend');
  assert.equal(storm.owner.staff_id, 'S-204');
  assert.equal(storm.owner.name, '安全员·郑海');
  const road = at933.degradations.find((d) => d.code === 'road_closed');
  // 09:12 的封路在 09:15 已解除；09:33 不应再出现
  assert.equal(road, undefined);
});

test('接管时刻的复盘可完整还原：请求人/确认人/冻结点/讲解去向', async () => {
  const { backend: b } = await runScenario({ quiet: true });
  const a = b.answerAt('2026-09-20T09:38:30+08:00');
  assert.equal(a.control_mode, 'manual');
  assert.equal(a.takeover.takeover_id, 'TK-20260920-01');
  assert.equal(a.takeover.requested_by.staff_id, 'S-101');
  assert.equal(a.takeover.confirmed_by.staff_id, 'S-204');
  assert.equal(a.takeover.freeze.checkpoint_id, 'F');
  const fd = a.progress.unfinished_narrations.find((n) => n.id === 'N-FD');
  assert.equal(fd.disposition, 'defer_to_checkpoint');
  assert.equal(fd.resume_checkpoint, 'D');
});

test('重放结果确定：同一份日志重建状态与在线状态一致', async () => {
  const { backend: live, events } = await runScenario({ quiet: true });
  const replayed = live.replayAs('2026-09-20T11:30:00+08:00');
  assert.equal(replayed.log.length, events.length);
  assert.equal(replayed.mapCurrent.version, live.state.mapCurrent.version);
  assert.equal(replayed.progress.status, live.state.progress.status);
  assert.equal(replayed.degradations.size, live.state.degradations.size);
});

test('持久化往返：写入 JSONL 后新进程从日志重建出同一状态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gr-'));
  try {
    const logPath = join(dir, 'log.jsonl');
    const rejectPath = join(dir, 'rej.jsonl');
    await runScenario({ logPath, rejectPath, quiet: true });
    const restored = await Backend.fromLog(logPath, { clock: new Clock('2026-09-20T11:30:00+08:00') });
    assert.equal(restored.state.mapCurrent.version, '2');
    assert.equal(restored.status().progress.status, 'completed');
    const tk = restored.state.takeovers.get('TK-20260920-01');
    assert.equal(tk.status, 'closed');
    assert.equal(tk.freeze.checkpoint_id, 'F');
    const raw = await readFile(logPath, 'utf8');
    assert.ok(raw.split('\n').filter(Boolean).length > 90);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('有效期：限制与路线在 valid_to 之后不再生效，旧暴雨规则不触发降级', async () => {
  // 策略/路线包的 valid_to 均为 2026-09-20T23:59；次日凌晨已是另一有效窗口
  const clock = new Clock('2026-09-21T00:30:00+08:00');
  const b = new Backend({ clock });
  await b.bootstrap(new URL('../fixtures/', import.meta.url).pathname);
  b.startMission();
  b.observe('device', T.POSITION, { lat: 30.25, lng: 120.15, confidence: 0.9 });
  b.observe('weather', T.WEATHER, { temperature_c: 20, storm_level: 3 });
  assert.equal(
    b.status().active_degradations.find((d) => d.code === 'storm_suspend'), undefined);
});

test('有效期内但值班窗口外：降级照样触发，责任人标记为未排班升级处理', async () => {
  // 限制 23:59 才到期，但值班 16:00 交班：17:30 有规则无当班人
  const clock = new Clock('2026-09-20T17:30:00+08:00');
  const b = new Backend({ clock });
  await b.bootstrap(new URL('../fixtures/', import.meta.url).pathname);
  b.startMission();
  b.observe('device', T.POSITION, { lat: 30.25, lng: 120.15, confidence: 0.9 });
  b.observe('weather', T.WEATHER, { temperature_c: 20, storm_level: 3 });
  const d = b.status().active_degradations.find((x) => x.code === 'storm_suspend');
  assert.equal(d.action, 'suspend');
  assert.equal(d.owner, null); // 复盘显示：规则有效但无人当班，需升级
});
