/**
 * 边缘离线缓冲。
 *
 * 离线期间设备只保存业务所需摘要（business_summary 默认可留存）；
 * 游客对话与影像按各自授权决定是否可本地留存。
 * 恢复联网时按“收集时授予的用途”同步：请求用途不在授权内一律不上传，
 * 授权过期即清除——恢复联网不能顺带扩大用途。
 */
export class EdgeBuffer {
  #items = [];

  constructor({ consent, now = () => new Date().toISOString() }) {
    if (!consent) throw new Error('EdgeBuffer 需要 consent 授权策略');
    this.consent = consent;
    this.now = now;
  }

  /**
   * 离线期间记录一条数据。
   * @param {object} item { item_id, kind: 'business_summary'|'visitor_dialogue'|'imagery', occurred_at, ... }
   */
  record(item) {
    const policy = this.consent[item?.kind];
    if (!policy) return { stored: false, reason: 'unknown_kind' };
    if (!policy.retain_locally) {
      return { stored: false, reason: 'not_retainable_offline' };
    }
    this.#items.push({ ...item });
    return { stored: true };
  }

  /**
   * 恢复联网后按用途同步。
   * @returns {{uploaded: object[], withheld: object[], purged: object[]}}
   *   uploaded 已按授权上传；withheld 用途未授权、继续留存；purged 授权过期已清除。
   */
  sync(purpose) {
    const uploaded = [];
    const withheld = [];
    const purged = [];
    const remaining = [];
    const now = this.now();
    for (const item of this.#items) {
      const policy = this.consent[item.kind];
      if (Date.parse(now) > Date.parse(policy.valid_until)) {
        purged.push({ item, reason: 'consent_expired' });
        continue;
      }
      if (!policy.upload_purposes.includes(purpose)) {
        withheld.push({ item, reason: 'purpose_not_granted' });
        remaining.push(item);
        continue;
      }
      uploaded.push(item);
    }
    this.#items = remaining;
    return { uploaded, withheld, purged };
  }

  get size() {
    return this.#items.length;
  }
}
