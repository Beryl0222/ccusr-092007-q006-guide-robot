/** JSONL 事件日志：只追加，每行一个信封；拒绝接入的消息写入旁路审计文件。 */
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendEvent(path, envelope) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(envelope)}\n`, 'utf8');
}

export function appendRejection(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export async function loadEvents(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
