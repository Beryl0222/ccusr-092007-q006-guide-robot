import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadMission } from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(here, '..', 'fixtures', 'robot_mission.json');

export async function loadTestMission() {
  const record = await loadMission(FIXTURE_PATH);
  return record.mission;
}

let counter = 0;

/** 构造一条合法事件；默认属于 robot-07，不带有效期（需要时通过 opts.valid_until 指定）。 */
export function ev(seq, type, payload = {}, opts = {}) {
  counter += 1;
  const event = {
    event_id: opts.id ?? `E-${counter}`,
    device_id: opts.device_id ?? 'robot-07',
    causal_seq: seq,
    issued_at: opts.at ?? `2026-09-20T09:${String(seq % 60).padStart(2, '0')}:00+08:00`,
    type,
    payload,
  };
  if (opts.valid_until) event.valid_until = opts.valid_until;
  return event;
}
