/** 测试公用：固定时钟、引导到 09:00 的后端。 */
import { Backend } from '../src/backend.js';
import { Clock } from '../src/clock.js';
import { T } from '../src/events.js';

export const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

export async function freshBackend(now = '2026-09-20T09:00:00+08:00') {
  const clock = new Clock(now);
  const b = new Backend({ clock });
  await b.bootstrap(FIXTURES);
  return { b, clock };
}

/** 让任务行驶到指定检查点（在当前路线版本上）。 */
export async function movingBackend(now = '2026-09-20T09:05:00+08:00') {
  const { b, clock } = await freshBackend('2026-09-20T09:00:00+08:00');
  clock.set(now);
  b.observe('device', T.BATTERY, { percent: 88 });
  b.observe('device', T.POSITION, { lat: 30.2502, lng: 120.1502, confidence: 0.95 });
  b.startMission();
  return { b, clock };
}
