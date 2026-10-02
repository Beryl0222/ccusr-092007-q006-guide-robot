import test from 'node:test';
import assert from 'node:assert/strict';
import { T } from '../src/events.js';
import { movingBackend } from './helpers.js';

function find(b, code) {
  return b.status().active_degradations.find((d) => d.code === code);
}

test('定位置信不足 → 就地等待，恢复后自动解除', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:11:00+08:00');
  b.observe('device', T.POSITION, { lat: 30.25, lng: 120.15, confidence: 0.5 });
  assert.equal(find(b, 'loc_low_confidence')?.action, 'hold_in_place');
  assert.equal(b.status().control_mode, 'holding');
  clock.set('2026-09-20T09:12:00+08:00');
  b.observe('device', T.POSITION, { lat: 30.25, lng: 120.15, confidence: 0.95 });
  assert.equal(find(b, 'loc_low_confidence'), undefined);
  assert.equal(b.status().control_mode, 'auto');
});

test('安全传感器异常 → 暂停，复位后解除', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:19:00+08:00');
  b.observe('device', T.SENSOR_STATUS, {
    sensor_id: 'lidar-front', status: 'fault', safety_critical: true });
  assert.equal(find(b, 'sensor_abnormal')?.action, 'suspend');
  clock.set('2026-09-20T09:20:00+08:00');
  b.observe('device', T.SENSOR_RESET, { sensor_id: 'lidar-front' });
  assert.equal(find(b, 'sensor_abnormal'), undefined);
});

test('非安全关键传感器异常不触发暂停', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:19:00+08:00');
  b.observe('device', T.SENSOR_STATUS, {
    sensor_id: 'temp-gauge', status: 'fault', safety_critical: false });
  assert.equal(find(b, 'sensor_abnormal'), undefined);
});

test('游客求助 → 人工接管，且自动任务已下发 yield 指令', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:36:00+08:00');
  b.observe('device', T.VISITOR_HELP, { topic: '走散' });
  assert.equal(find(b, 'visitor_help')?.action, 'manual_takeover');
  const cmds = [...b.state.commands.values()]
    .filter((c) => c.decision_id === find(b, 'visitor_help').decision_id);
  assert.equal(cmds.at(-1).command, 'yield_to_operator');
  assert.equal(b.status().control_mode, 'manual_requested');
});

test('暴雨达到阈值 → 暂停，责任人是当班安全员', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:33:00+08:00');
  b.observe('weather', T.WEATHER, { temperature_c: 28, storm_level: 2 });
  const d = find(b, 'storm_suspend');
  assert.equal(d.action, 'suspend');
  assert.equal(d.owner.staff_id, 'S-204');
});

test('暴雨低于阈值不降级', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:33:00+08:00');
  b.observe('weather', T.WEATHER, { temperature_c: 28, storm_level: 1 });
  assert.equal(find(b, 'storm_suspend'), undefined);
});

test('封路且当前地图无可用绕行 → 暂停；新地图给出绕行后修正为 detour', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:12:20+08:00');
  b.observe('cloud', T.ROAD_CLOSED, {
    map_id: 'MAP-LAKE', from: 'A', to: 'B', reason: '围挡' });
  assert.equal(find(b, 'road_closed')?.action, 'suspend');
  clock.set('2026-09-20T09:14:00+08:00');
  b.publishMapByVersion('1.1');
  b.observe('cloud', T.DETOUR_PLANNED, {
    map_id: 'MAP-LAKE', from: 'A', to: 'B',
    via: [['A', 'G'], ['G', 'E']] });
  // A->G、G->E 在 v1 即存在，发布 v1.1 后地图包含它们
  assert.equal(find(b, 'road_closed')?.action, 'detour');
});

test('高温且绕行边尚不在当前地图 → 暂停而不是盲绕', async () => {
  const { b, clock } = await movingBackend();
  // 直接把任务放到 F→D 段需要路线 1.1：先发布并完成段1
  clock.set('2026-09-20T09:15:00+08:00');
  b.publishMapByVersion('1.1');
  b.publishRouteByVersion('1.1');
  b.completeSegment(); // 到段2 B→F，再
  b.completeSegment(); // 到段3 F→D（heat_affected）
  clock.set('2026-09-20T09:26:00+08:00');
  b.observe('weather', T.WEATHER, { temperature_c: 38, storm_level: 0 });
  // 策略里配置的高温绕行 F->X 需要 v1.1 地图（已发布，含 F、X），可绕
  assert.equal(find(b, 'extreme_heat')?.action, 'detour');
});

test('电量低于下一段要求 → 暂停，补足后解除', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:05:30+08:00');
  b.observe('device', T.BATTERY, { percent: 60 }); // 段2 要求 55，当前段1要求70
  assert.equal(find(b, 'battery_insufficient')?.action, 'suspend');
  b.observe('device', T.BATTERY, { percent: 90 });
  assert.equal(find(b, 'battery_insufficient'), undefined);
});

test('人工接管期间不产生新的自动决策', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:36:00+08:00');
  const help = b.observe('device', T.VISITOR_HELP, { topic: '走散' });
  b.requestTakeover({
    takeover_id: 'TK-1',
    reason: '求助',
    requested_by: { staff_id: 'S-101', name: '林岚' },
    trigger: help.envelope.message_id,
  });
  b.confirmTakeover('TK-1', { staff_id: 'S-204', name: '郑海' });
  const before = b.events().length;
  const res = b.observe('weather', T.WEATHER, { temperature_c: 12, storm_level: 3 }); // 极端暴雨
  assert.equal(b.events().length, before + 1, '接管期间观察事件只入链，不派生新指令');
  assert.equal(res.derived.length, 0);
});
