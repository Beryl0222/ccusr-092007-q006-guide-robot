#!/usr/bin/env node
/**
 * 伴游任务控制台。
 *
 * 用法：
 *   node src/console.js demo                 重放完整一日场景并落盘事件日志
 *   node src/console.js status               当前状态摘要
 *   node src/console.js events [--type T]    事件时间线（因果序号）
 *   node src/console.js replay <ISO>         按历史时点复盘（当时的地图/内容版本）
 *   node src/console.js takeovers            接管台账（请求/确认/冻结/讲解去向/恢复）
 *   node src/console.js rejections           被拒消息审计（重复/乱序/断链/过期/越权）
 *
 * 数据目录可用 GR_DATA_DIR 覆盖（默认 ./data）。
 */
import { join } from 'node:path';
import { Backend } from './backend.js';
import { Clock } from './clock.js';
import { T } from './events.js';
import { DEG_META } from './core.js';
import { runScenario } from './scenario.js';
import { loadEvents } from './store.js';

const dataDir = process.env.GR_DATA_DIR ?? join(process.cwd(), 'data');
const logPath = join(dataDir, 'event-log.jsonl');
const rejectPath = join(dataDir, 'rejections.jsonl');

const cmd = process.argv[2] ?? 'status';

const ACTION_LABEL = {
  hold_in_place: '就地等待',
  suspend: '暂停',
  manual_takeover: '人工接管',
  detour: '绕行',
};
const MODE_LABEL = {
  idle: '待命', auto: '自动行驶', holding: '就地等待',
  paused: '暂停', auto_detour: '自动绕行',
  manual_requested: '请求接管', manual: '人工接管', frozen: '接管冻结',
};

function fmtDeg(d) {
  return `    - ${DEG_META[d.code]?.label ?? d.code} → ${ACTION_LABEL[d.action] ?? d.action}`
    + `｜${d.reason ?? ''}｜责任：${d.owner ? `${d.owner.name}(${d.owner.staff_id})` : d.owner_role}`;
}

async function loadBackend() {
  return Backend.fromLog(logPath, { rejectPath, clock: new Clock() });
}

async function cmdStatus() {
  const b = await loadBackend();
  const s = b.status();
  console.log(`时间：${s.now}`);
  console.log(`设备：${s.mission?.device_id ?? '—'}　任务：${s.mission?.mission_id ?? '—'}`
    + `　联网：${s.online ? '在线' : '离线'}　模式：${MODE_LABEL[s.control_mode] ?? s.control_mode}`);
  console.log(`版本：地图 ${s.versions.map?.version ?? '—'}　`
    + `路线 ${s.versions.route?.version ?? '—'}　讲解 ${s.versions.content?.version ?? '—'}`);
  if (s.progress) {
    console.log(`进度：路线段 ${s.progress.segment_seq}　检查点 ${s.progress.checkpoint_id ?? '—'}`
      + `　状态 ${s.progress.status}`);
    if (s.progress.narration) {
      console.log(`当前讲解：${s.progress.narration.id}（${s.progress.narration.status}`
        + `${s.progress.narration.disposition ? `/${s.progress.narration.disposition}` : ''}）`);
    }
    for (const n of s.progress.unfinished_narrations ?? []) {
      console.log(`未完成讲解去向：${n.id} → ${n.disposition ?? '待人工明确'}`
        + `${n.assigned_to ? `（${n.assigned_to.name ?? n.assigned_to}）` : ''}`
        + `${n.resume_checkpoint ? `（恢复点 ${n.resume_checkpoint}）` : ''}`);
    }
  }
  if (s.active_degradations.length) {
    console.log('生效中的降级：');
    s.active_degradations.forEach((d) => console.log(fmtDeg(d)));
  } else {
    console.log('生效中的降级：无');
  }
  console.log(`开放接管：${s.open_takeover ?? '无'}　事件总数：${b.events().length}`);
}

async function cmdEvents() {
  const events = await loadEvents(logPath);
  const only = (() => {
    const i = process.argv.indexOf('--type');
    return i > 0 ? process.argv[i + 1] : null;
  })();
  for (const [i, e] of events.entries()) {
    if (only && e.type !== only) continue;
    const p = e.payload ?? {};
    const detail = e.type === T.DECISION_DECIDED || e.type === T.DECISION_AMENDED
      ? `${p.code}→${p.action} ${p.reason ?? ''}`
      : e.type === T.COMMAND_ISSUED
        ? `${p.command} ${p.label ?? ''}`
        : e.type === T.POSITION
          ? `conf=${p.confidence} @${p.lat},${p.lng}`
          : e.type.startsWith('takeover')
            ? `${p.takeover_id}`
            : '';
    console.log(
      `${String(i + 1).padStart(3)} ${e.occurred_at} ${e.source.padEnd(9)} #${String(e.seq).padStart(2)}`
      + `${e.causal_prev ? ` ←${String(e.causal_prev).slice(0, 28)}` : ' '.repeat(31)}`
      + ` ${e.type}${detail ? `  ${detail}` : ''}`);
  }
  console.log(`共 ${events.length} 条`);
}

async function cmdReplay() {
  const asOf = process.argv[3];
  if (!asOf) { console.error('用法：replay <ISO 时间>'); process.exit(2); }
  const events = await loadEvents(logPath);
  const { answerAt } = await import('./core.js');
  const a = answerAt(events, asOf);
  console.log(JSON.stringify(a, null, 2));
}

async function cmdTakeovers() {
  const b = await loadBackend();
  const tks = [...b.state.takeovers.values()];
  if (!tks.length) { console.log('无接管记录'); return; }
  for (const tk of tks) {
    console.log(`接管 ${tk.takeover_id}【${tk.status}】${tk.reason}`);
    console.log(`  请求：${tk.requested_by?.name}(${tk.requested_by?.staff_id}) @${tk.requested_at}`);
    console.log(`  确认：${tk.confirmed_by?.name ?? '—'}(${tk.confirmed_by?.staff_id ?? '—'}) @${tk.confirmed_at ?? '—'}`);
    if (tk.freeze) {
      console.log(`  冻结点：段${tk.freeze.segment_seq} 检查点${tk.freeze.checkpoint_id}`
        + ` 地图v${tk.freeze.map_version} 路线v${tk.freeze.route_version} 讲解v${tk.freeze.content_version}`);
      console.log(`  冻结时挂起指令：${tk.freeze.active_commands.join(', ') || '无'}`);
      console.log(`  冻结时未完成讲解：${(tk.freeze.paused_narrations ?? []).map((n) => `${n.id}(${n.status})`).join(', ') || '无'}`);
    }
    for (const d of tk.narration_dispositions ?? []) {
      console.log(`  讲解去向：${d.narration_id} → ${d.disposition}`
        + `${d.to ? `，承接 ${d.to.name ?? JSON.stringify(d.to)}` : ''}`
        + `${d.resume_checkpoint ? `，恢复点 ${d.resume_checkpoint}` : ''}`);
    }
    if (tk.resume_plan) {
      console.log(`  恢复计划：检查点 ${tk.resume_plan.checkpoint_id}`
        + ` 地图v${tk.resume_plan.map_version} 路线v${tk.resume_plan.route_version}`
        + ` 讲解v${tk.resume_plan.content_version}`
        + ` 核验人 ${tk.resume_plan.checked_by?.name ?? '—'}`);
      for (const c of tk.resume_plan.safety_checks ?? []) {
        console.log(`    · ${c.item}: ${c.result}`);
      }
    }
    if (tk.resumed_at) console.log(`  恢复：${tk.resumed_at}`);
    if (tk.closed_at) console.log(`  关闭：${tk.closed_at}（${tk.close_note ?? ''}）`);
  }
}

async function cmdRejections() {
  const rows = await loadEvents(rejectPath).catch(() => []);
  // 接入拒绝（旁路文件）与授权拒绝（事件日志里的 access.denied）都列出
  const events = await loadEvents(logPath);
  const denied = events.filter((e) => e.type === T.ACCESS_DENIED);
  for (const r of rows) {
    console.log(`[接入拒绝] ${r.rejected_at} ${r.code} ${r.source}#${r.seq} ${r.type ?? ''} — ${r.detail}`);
  }
  for (const e of denied) {
    console.log(`[授权拒绝] ${e.occurred_at} ${e.payload.data_class} `
      + `${e.payload.purpose ? `用途 ${e.payload.purpose} ` : ''}— ${e.payload.reason}`);
  }
  console.log(`共 ${rows.length + denied.length} 条`);
}

async function cmdDemo() {
  // 演示场景是全新的一天：清空旧日志再落盘，避免重复追加
  const { rmSync } = await import('node:fs');
  for (const p of [logPath, rejectPath]) {
    try { rmSync(p); } catch { /* 首次运行无文件 */ }
  }
  const result = await runScenario({ logPath, rejectPath });
  console.log(`\n事件日志：${logPath}`);
  console.log(`拒绝审计：${rejectPath}`);
  process.exitCode = result.fail ? 1 : 0;
}

const commands = {
  status: cmdStatus,
  events: cmdEvents,
  replay: cmdReplay,
  takeovers: cmdTakeovers,
  rejections: cmdRejections,
  demo: cmdDemo,
};

if (!commands[cmd]) {
  console.error(`未知命令：${cmd}；可用：${Object.keys(commands).join('/')}`);
  process.exit(2);
}
await commands[cmd]();
