import { readFile } from 'node:fs/promises';

/** 读取项目已经确认的最小数据合同，不包含业务流程实现。 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  return Object.freeze(payload);
}

/** 带因果序号与有效期的任务要素段落。 */
const VERSIONED_LISTS = ['route', 'narrations', 'weather_limits', 'safety_zones', 'responsibilities'];

function assertWindow(item, label) {
  if (!Number.isInteger(item.seq)) {
    throw new Error(`${label} 缺少因果序号 seq`);
  }
  const from = Date.parse(item.valid_from);
  const until = Date.parse(item.valid_until);
  if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) {
    throw new Error(`${label} 有效期无效`);
  }
}

/** 校验完整伴游任务合同：任务、地图、设备标识以及全部带序号/有效期的要素。 */
export function validateMission(record) {
  const m = record.mission;
  if (!m || typeof m !== 'object') throw new Error('数据合同缺少 mission 段');
  if (!m.mission_id) throw new Error('mission 缺少 mission_id');
  if (!m.device?.device_id) throw new Error('mission 缺少设备标识 device.device_id');
  if (!m.map?.map_id || !m.map?.version) throw new Error('mission 缺少地图标识或版本');
  if (!m.content?.package_id || !m.content?.version) throw new Error('mission 缺少内容包标识或版本');

  for (const key of VERSIONED_LISTS) {
    if (!Array.isArray(m[key]) || m[key].length === 0) {
      throw new Error(`mission.${key} 必须是非空数组`);
    }
    for (const item of m[key]) {
      assertWindow(item, `mission.${key} 条目`);
    }
  }
  assertWindow(m.battery_policy ?? {}, 'mission.battery_policy');

  const seqs = m.route.map((s) => s.seq);
  if (new Set(seqs).size !== seqs.length || [...seqs].sort((a, b) => a - b).join() !== seqs.join()) {
    throw new Error('route 的 seq 必须严格递增');
  }
  const checkpoints = m.route.map((s) => s.checkpoint_id);
  if (new Set(checkpoints).size !== checkpoints.length) {
    throw new Error('route 的 checkpoint_id 必须唯一');
  }
  const segmentIds = new Set(m.route.map((s) => s.segment_id));
  for (const n of m.narrations) {
    if (!segmentIds.has(n.segment_id)) {
      throw new Error(`讲解 ${n.narration_id} 引用了不存在的路段 ${n.segment_id}`);
    }
  }
  for (const kind of ['business_summary', 'visitor_dialogue', 'imagery']) {
    const policy = m.consent?.[kind];
    if (!policy || !Array.isArray(policy.upload_purposes) || !Number.isFinite(Date.parse(policy.valid_until))) {
      throw new Error(`mission.consent.${kind} 授权策略无效`);
    }
  }
  return Object.freeze(record);
}

/** 读取并校验完整伴游任务合同。 */
export async function loadMission(path) {
  return validateMission(await loadRecord(path));
}
