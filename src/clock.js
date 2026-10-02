/**
 * 时钟源——所有业务判定（有效期、日志时间戳、复盘时点）都经过这里，
 * 便于测试把时间固定在任意时点。控制台默认用系统时钟，可通过
 * GR_NOW 环境变量（ISO 字符串或毫秒数）固定。
 */
export class Clock {
  constructor(initial) {
    if (initial !== undefined && typeof initial !== 'number' && typeof initial !== 'string') {
      throw new Error('时钟初始值必须是 ISO 字符串或毫秒数');
    }
    this.offset = 0;
    if (initial !== undefined) this.set(initial);
  }

  set(value) {
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`无法识别的时间: ${value}`);
    this.offset = ms - Date.now();
  }

  now() {
    return Date.now() + this.offset;
  }

  iso() {
    return new Date(this.now()).toISOString();
  }
}

export function parseTs(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`无法识别的时间: ${value}`);
  return ms;
}

/** 值在 [from,to] 闭区间内有效；to 省略表示长期有效（仍可被后续序号取代）。 */
export function validAt(ms, v) {
  if (v.valid_from !== undefined && ms < parseTs(v.valid_from)) return false;
  if (v.valid_to !== undefined && ms > parseTs(v.valid_to)) return false;
  return true;
}
