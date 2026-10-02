/**
 * 授权与边缘数据最小化。
 *
 * 原则：
 *  - 游客对话（visitor_chat）与影像（visitor_video）是两类独立授权，各自的
 *    用途、留存期、离线字段白名单互不通用；
 *  - 边缘设备离线时只能缓存白名单字段的摘要（求助标记、话题标签、帧哈希、
 *    障碍标记、时间戳、同意标记），原始语音/帧字节根本不进入离线缓存；
 *  - 恢复联网后上传必须声明用途，用途不在授权清单内即拒绝；同步动作不会
 *    顺带产生新用途或延长留存。
 */
import { parseTs, validAt } from './clock.js';

export function grantAt(state, dataClass, ms) {
  const candidates = state.grants
    .filter((g) => g.data_class === dataClass && validAt(ms, g));
  return candidates.at(-1) ?? null;
}

/**
 * 过滤一次边缘离线采集。
 * 输入 { data_class, fields }，输出允许缓存的摘要与被剔除字段名（不记值）。
 */
export function filterEdgeCapture(state, capture, ms) {
  const grant = grantAt(state, capture.data_class, ms);
  if (!grant) {
    return {
      allowed: false, grant_id: null,
      summary: null,
      denied_fields: Object.keys(capture.fields ?? {}),
      reason: `数据类别 ${capture.data_class} 当前无有效授权`,
    };
  }
  const allow = new Set(grant.allowed_offline_fields ?? []);
  const summary = {};
  const denied = [];
  for (const [k, v] of Object.entries(capture.fields ?? {})) {
    if (allow.has(k)) summary[k] = v;
    else denied.push(k);
  }
  return {
    allowed: true,
    grant_id: grant.grant_id,
    data_class: capture.data_class,
    purposes: grant.purposes,
    edge_retention: grant.edge_retention,
    summary,
    denied_fields: denied,
  };
}

/**
 * 联网恢复后的上传过滤：必须声明用途，且用途是该类别授权用途之一。
 * 只输出离线摘要中、且仍然属于该用途所需最小集的字段。
 * purposeFields 由调用方按业务给出（如人工接管只需要 help_flag/topic_tag）。
 */
export function filterSyncUplink(state, { data_class, purpose, fields }, ms) {
  const grant = grantAt(state, data_class, ms);
  if (!grant) {
    return { allowed: false, reason: `数据类别 ${data_class} 无有效授权（联网不会扩大授权）` };
  }
  if (!grant.purposes.includes(purpose)) {
    return {
      allowed: false,
      reason: `用途 ${purpose} 不在 ${data_class} 授权用途 ${grant.purposes.join('/')} 内`,
      grant_id: grant.grant_id,
    };
  }
  if (grant.cloud_retention === 'none') {
    return { allowed: false, reason: `${data_class} 授权规定永不上云`, grant_id: grant.grant_id };
  }
  const offlineAllow = new Set(grant.allowed_offline_fields ?? []);
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (offlineAllow.has(k)) out[k] = v;
  }
  return {
    allowed: true, grant_id: grant.grant_id, purpose,
    cloud_retention: grant.cloud_retention, fields: out,
  };
}
