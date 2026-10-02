/**
 * 因果事件日志：每台设备一条只追加日志。
 * 重复 event_id、乱序 causal_seq、超过 valid_until 的消息一律拒绝，
 * 保证通信恢复后旧消息不会让设备状态倒退。
 */
export const REJECT = Object.freeze({
  MALFORMED: 'malformed',
  WRONG_DEVICE: 'wrong_device',
  DUPLICATE: 'duplicate_event_id',
  STALE_SEQ: 'stale_causal_seq',
  EXPIRED: 'expired',
});

const REQUIRED_FIELDS = ['event_id', 'device_id', 'causal_seq', 'issued_at', 'type'];

export class CausalEventLog {
  #deviceId;
  #lastSeq = 0;
  #seenIds = new Set();
  #events = [];

  constructor({ deviceId }) {
    if (!deviceId) throw new Error('CausalEventLog 需要 deviceId');
    this.#deviceId = deviceId;
  }

  /**
   * @param {object} event 业务事件，含 event_id/device_id/causal_seq/issued_at/type，可选 valid_until/payload
   * @param {string} [receivedAt] 服务端接收时间（ISO），用于有效期判定；缺省取当前时间
   * @returns {{accepted: boolean, reason?: string, event?: object}}
   */
  append(event, receivedAt = new Date().toISOString()) {
    if (!event || REQUIRED_FIELDS.some((k) => event[k] === undefined || event[k] === null)) {
      return { accepted: false, reason: REJECT.MALFORMED };
    }
    if (event.device_id !== this.#deviceId) {
      return { accepted: false, reason: REJECT.WRONG_DEVICE };
    }
    if (this.#seenIds.has(event.event_id)) {
      return { accepted: false, reason: REJECT.DUPLICATE };
    }
    if (!Number.isInteger(event.causal_seq) || event.causal_seq <= this.#lastSeq) {
      return { accepted: false, reason: REJECT.STALE_SEQ };
    }
    if (event.valid_until && Date.parse(receivedAt) > Date.parse(event.valid_until)) {
      return { accepted: false, reason: REJECT.EXPIRED };
    }
    this.#seenIds.add(event.event_id);
    this.#lastSeq = event.causal_seq;
    this.#events.push(Object.freeze({ ...event }));
    return { accepted: true, event };
  }

  get events() {
    return [...this.#events];
  }

  get lastSeq() {
    return this.#lastSeq;
  }
}
