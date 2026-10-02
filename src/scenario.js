/**
 * 一日完整场景（2026-09-20）：
 * 任务出发 → 定位漂移就地等待 → 围挡封路先暂停、测绘后绕行 → 高温绕行 →
 * 低电量/暴雨暂停 → 游客求助人工接管（双人确认、冻结点、讲解去向）→
 * 断网期边缘最小化采集与越权拦截 → 新地图/路线发布 → 新检查点恢复 →
 * 被推迟讲解在 D 点续讲 → 复盘各历史时点。
 *
 * 运行：node src/scenario.js（或 npm run demo）
 */
import { Backend } from './backend.js';
import { Clock } from './clock.js';
import { T } from './events.js';

let pass = 0, fail = 0;
function line(text = '') { console.log(text); }
function head(text) { line(''); line(`▌ ${text}`); }
function check(name, cond, detail = '') {
  if (cond) { pass += 1; line(`  ✓ ${name}`); }
  else { fail += 1; line(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

export async function runScenario({ logPath, rejectPath, quiet = false } = {}) {
  const clock = new Clock('2026-09-20T09:00:00+08:00');
  const b = new Backend({ logPath, rejectPath, clock });
  const failDetails = [];
  const at = (iso) => clock.set(iso);
  const line = quiet ? () => {} : (text = '') => console.log(text);
  const head = (text) => line(`\n▌ ${text}`);
  const check = quiet
    ? (name, cond) => { if (cond) pass += 1; else { fail += 1; failDetails.push(name); } }
    : (name, cond, detail = '') => {
      if (cond) { pass += 1; line(`  ✓ ${name}`); }
      else { fail += 1; line(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
    };
  const pos = (lat, lng, confidence, extra = {}) =>
    b.observe('device', T.POSITION, { lat, lng, confidence, ...extra });
  const battery = (percent) => b.observe('device', T.BATTERY, { percent });
  const sensor = (sensorId, status, extra = {}) =>
    b.observe('device', T.SENSOR_STATUS, { sensor_id: sensorId, status, safety_critical: true, ...extra });
  const weather = (w) => b.observe('weather', T.WEATHER, w);
  const cloudNext = () => (b.state.perSourceSeq.get('cloud') ?? 0) + 1;
  const activeDeg = () => b.status().active_degradations;
  const findDeg = (code) => activeDeg().find((d) => d.code === code);

  head('09:00 引导：任务/地图 v1/路线 v1/讲解 v1/限制/值班/授权 全部带有效期发布');
  await b.bootstrap(new URL('../fixtures/', import.meta.url).pathname);
  check('任务与设备标识载入', b.status().mission?.device_id === 'GR-07');
  check('当前地图为 v1（旧版本不能凭空出现）', b.status().versions.map.version === '1');

  at('2026-09-20T09:03:00+08:00');
  battery(88);
  pos(30.25011, 120.15011, 0.92);
  b.startMission();
  line('  任务 M-20260920-GR07-03 出发，段1 A东门→B临湖台');

  at('2026-09-20T09:06:00+08:00');
  b.startNarration('N-AB', 1);
  at('2026-09-20T09:08:30+08:00');
  b.completeNarration('N-AB');
  b.completeSegment(); // 到达 B，进入段2 B→C
  line('  N-AB《东门迎客》播完，到达临湖台 B');

  head('09:11 定位漂移：置信度 0.55 < 0.75 → 就地等待，不得沿旧图继续');
  at('2026-09-20T09:11:00+08:00');
  pos(30.25082, 120.15101, 0.55);
  check('触发 loc_low_confidence', findDeg('loc_low_confidence')?.action === 'hold_in_place',
    JSON.stringify(activeDeg()));
  check('控制模式 holding', b.status().control_mode === 'holding');

  head('09:11:40 定位恢复 → 自动解除就地等待');
  at('2026-09-20T09:11:40+08:00');
  pos(30.25082, 120.15101, 0.93);
  check('定位降级已清除', !findDeg('loc_low_confidence'));
  check('控制模式恢复 auto', b.status().control_mode === 'auto');

  head('09:12 地图平台：望春桥 B→C 施工围挡，封路且暂无绕行 → 暂停');
  at('2026-09-20T09:12:20+08:00');
  const closedId = 'evt-cloud-20260920-0912-roadclosed-bc';
  b.observe('cloud', T.ROAD_CLOSED, {
    map_id: 'MAP-LAKE', from: 'B', to: 'C', reason: '施工围挡',
    valid_to: '2026-09-20T12:00:00+08:00',
  }, { messageId: closedId });
  check('道路封闭触发暂停（地图 v1 上没有可绕路线）',
    findDeg('road_closed')?.action === 'suspend', JSON.stringify(findDeg('road_closed')));
  check('后续动作责任人是值班调度员', findDeg('road_closed')?.owner?.staff_id === 'S-101');
  const snapshot0912 = b.answerAt('2026-09-20T09:12:30+08:00');
  check('09:12 复盘所见地图版本为 1', String(snapshot0912.versions.map.version) === '1');

  head('09:14 测绘组验收后花园步道：发布地图 v1.1，并给出可说明的绕行');
  at('2026-09-20T09:14:00+08:00');
  b.publishMapByVersion('1.1', { causalPrev: closedId });
  check('地图 v1.1 发布后当前版本切到 1.1', b.status().versions.map.version === '1.1');
  at('2026-09-20T09:14:30+08:00');
  b.observe('cloud', T.DETOUR_PLANNED, {
    map_id: 'MAP-LAKE', from: 'B', to: 'C',
    via: [['B', 'F'], ['F', 'D']],
    valid_to: '2026-09-20T12:00:00+08:00',
  }, { causalPrev: closedId });
  check('封路决策由暂停修正为绕行（同一条决策、可追溯的 amend）',
    findDeg('road_closed')?.action === 'detour', JSON.stringify(findDeg('road_closed')));

  head('09:15 讲解团队发布路线/讲解 v1.1：B→F→D，N-BC 明确推迟到 D 点续讲');
  at('2026-09-20T09:15:10+08:00');
  b.publishRouteByVersion('1.1');
  b.publishContentByVersion('1.1');
  check('旧封路随正式路线 v1.1 生效而解除（B→C 已不在路线上）',
    !findDeg('road_closed'));
  check('当前路线切到 1.1', b.status().versions.route.version === '1.1');
  check('未播放的 N-BC 已预先登记去向（推迟到 D），不静默丢失',
    b.status().progress.unfinished_narrations.some(
      (n) => n.id === 'N-BC' && n.disposition === 'defer_to_checkpoint' && n.resume_checkpoint === 'D'));

  head('09:16 沿新路线行进 B→F，播 N-BF；09:19 前激光雷达故障 → 暂停');
  at('2026-09-20T09:16:00+08:00');
  b.startNarration('N-BF', 2);
  at('2026-09-20T09:19:20+08:00');
  sensor('lidar-front', 'fault', { note: '点云丢帧' });
  check('安全传感器异常 → suspend', findDeg('sensor_abnormal')?.action === 'suspend');
  at('2026-09-20T09:21:00+08:00');
  b.observe('device', T.SENSOR_RESET, { sensor_id: 'lidar-front', note: '现场重启恢复' });
  check('复位后传感器降级清除', !findDeg('sensor_abnormal'));
  check('被暂停的讲解随任务自动续播', b.status().progress.narration?.status === 'playing');
  at('2026-09-20T09:24:00+08:00');
  b.completeNarration('N-BF');
  b.completeSegment(); // 到达 F，进入段3 F→D
  line('  到达后花园步道口 F，N-BF 播完');

  head('09:26 高温 38℃：暴晒段 F→D 触发绕行 F→X→D（林荫道）');
  at('2026-09-20T09:26:00+08:00');
  b.startNarration('N-FD', 3);
  weather({ temperature_c: 38, storm_level: 0, storm_level_label: '无' });
  check('高温降级且绕行可用 → detour', findDeg('extreme_heat')?.action === 'detour');

  head('09:30 电量 36% 低于段3要求 40% → 暂停（优先级高于绕行）');
  at('2026-09-20T09:30:00+08:00');
  battery(36);
  check('电量不足 → suspend', findDeg('battery_insufficient')?.action === 'suspend');
  check('控制模式 paused', b.status().control_mode === 'paused');

  head('09:33 暴雨橙色（2级）→ 暂停露天行驶，安全员为后续责任人');
  at('2026-09-20T09:33:00+08:00');
  weather({ temperature_c: 35, storm_level: 2, storm_level_label: '橙' });
  check('暴雨 → suspend，责任人安全员',
    findDeg('storm_suspend')?.action === 'suspend'
    && findDeg('storm_suspend').owner.staff_id === 'S-204');

  head('09:36 游客按下求助 → 请求人工接管，自动任务停止');
  at('2026-09-20T09:36:10+08:00');
  const helpRes = b.observe('device', T.VISITOR_HELP, {
    topic: '与家人走散', location_hint: '后花园步道口',
  });
  const helpMsgId = helpRes.envelope.message_id;
  check('游客求助 → manual_takeover', findDeg('visitor_help')?.action === 'manual_takeover');
  check('正在播的 N-FD 被中断并等待人工明确去向',
    b.status().progress.narration?.status === 'interrupted'
    && b.status().progress.narration.await_disposition === true);

  head('09:37 双人确认接管：调度员林岚请求，安全员郑海确认；记录冻结点');
  at('2026-09-20T09:37:00+08:00');
  const tkId = 'TK-20260920-01';
  b.requestTakeover({
    takeover_id: tkId,
    reason: '游客求助且叠加暴雨/低电量，转入人工处置',
    requested_by: { staff_id: 'S-101', name: '林岚', role: 'duty:dispatcher' },
    trigger: helpMsgId,
  });
  const confirmRes = b.confirmTakeover(tkId, { staff_id: 'S-204', name: '郑海', role: 'duty:safety' });
  check('接管请求+确认+冻结完成', confirmRes.accepted);
  check('控制模式 manual', b.status().control_mode === 'manual');
  const freeze = b.state.takeovers.get(tkId).freeze;
  check('冻结点记录了精确位置：路线 1.1 / 段3 / 检查点 F / 地图 1.1',
    freeze.segment_seq === 3 && freeze.checkpoint_id === 'F'
    && String(freeze.map_version) === '1.1' && String(freeze.route_version) === '1.1',
    JSON.stringify(freeze));
  check('冻结点列出未完成讲解 N-FD 等待处置',
    freeze.paused_narrations.some((n) => n.id === 'N-FD' && n.await_disposition));

  // 同一人不能既请求又确认（用一条新的接管单走双人校验）
  at('2026-09-20T09:37:30+08:00');
  b.requestTakeover({
    takeover_id: 'TK-bad-self-confirm',
    reason: '测试：自请求自确认',
    requested_by: { staff_id: 'S-999', name: '甲' },
  });
  const badConfirm = b.confirmTakeover('TK-bad-self-confirm', { staff_id: 'S-999', name: '甲' });
  check('双人确认校验：同一人请求又确认被拒绝',
    badConfirm.accepted === false && badConfirm.code === 'invalid');

  head('09:38 未完成讲解逐条给出明确去向：N-FD 推迟到 D 点续讲');
  b.delegateNarration(tkId, 'N-FD', 'defer_to_checkpoint', { resumeCheckpoint: 'D' });
  const st = b.status();
  check('N-FD 去向 = 推迟到检查点 D',
    st.progress.unfinished_narrations.some(
      (n) => n.id === 'N-FD' && n.disposition === 'defer_to_checkpoint' && n.resume_checkpoint === 'D'));

  head('09:38-10:44 断网：边缘只缓存授权摘要，影像永不上云，联网不扩权');
  at('2026-09-20T09:38:00+08:00');
  b.setConnectivity(false);
  const chatCap = b.edgeCapture({
    data_class: 'visitor_chat',
    fields: {
      help_flag: true, topic_tag: 'lost_family', consent: true,
      captured_at: clock.iso(), raw_utterance: '我和奶奶走散了', voice_clip: '<audio>',
    },
  });
  check('对话离线只留白名单摘要',
    chatCap.accepted && chatCap.filtered.summary.topic_tag === 'lost_family'
    && chatCap.filtered.denied_fields.includes('raw_utterance')
    && chatCap.filtered.denied_fields.includes('voice_clip'));
  const vidCap = b.edgeCapture({
    data_class: 'visitor_video',
    fields: {
      frame_hash: 'sha256:9f2c', obstacle_flag: false, captured_at: clock.iso(),
      frame_bytes: '<jpeg>', face_crop: '<jpeg>',
    },
  });
  check('影像离线只留哈希/障碍标记，帧数据不落盘',
    vidCap.accepted && vidCap.filtered.denied_fields.includes('frame_bytes')
    && vidCap.filtered.denied_fields.includes('face_crop'));
  const videoUplink = b.syncUplink({
    data_class: 'visitor_video', purpose: 'obstacle_safety_check',
    fields: { frame_hash: 'sha256:9f2c' },
  });
  check('影像按授权永不上云（即使恢复联网）', videoUplink.accepted === false);

  head('断网期重发/乱序/断链/过期消息一律拒绝，设备状态不倒退');
  const dup = b.ingest({ ...helpRes.envelope });
  check('重复消息拒绝', dup.accepted === false && dup.code === 'duplicate');
  const deviceNow = b.state.perSourceSeq.get('device');
  const stale = b.ingest({
    message_id: `device:1:stale-resend`, source: 'device', seq: 1,
    type: T.POSITION, occurred_at: clock.iso(),
    payload: { lat: 1, lng: 1, confidence: 0.99 },
  });
  check('旧序号（乱序/倒退）拒绝', stale.accepted === false && stale.code === 'stale');
  const orphan = b.ingest({
    message_id: `cloud:${cloudNext()}:orphan`, source: 'cloud', seq: cloudNext(),
    type: T.ROAD_REOPENED, occurred_at: clock.iso(),
    causal_prev: 'evt-never-existed', payload: { from: 'A', to: 'B' },
  });
  check('前因未知（断链）拒绝', orphan.accepted === false && orphan.code === 'orphan');
  const expired = b.ingest({
    message_id: `cloud:${cloudNext()}:expired`, source: 'cloud', seq: cloudNext(),
    type: T.CONSTRAINT_UPDATED, occurred_at: clock.iso(),
    valid_to: '2026-09-20T09:00:00+08:00',
    payload: { code: 'storm', condition: { storm_level_gte: 9 }, seq: 9 },
  });
  check('接收时已过期的消息拒绝', expired.accepted === false && expired.code === 'expired');
  check('被拒消息不占序号（device 序号空间无空洞）',
    b.state.perSourceSeq.get('device') === deviceNow);
  check('全部拒绝后位置仍在 F、状态仍为接管冻结',
    b.status().progress.checkpoint_id === 'F' && b.status().control_mode === 'manual');

  head('10:44 恢复联网：对话摘要只按授权用途上传，尝试扩大用途被拦截');
  at('2026-09-20T10:44:00+08:00');
  b.setConnectivity(true);
  const uplinkOk = b.syncUplink({
    data_class: 'visitor_chat', purpose: 'handoff_summary_to_operator',
    fields: { help_flag: true, topic_tag: 'lost_family', raw_utterance: '我和奶奶走散了' },
  });
  check('授权用途内上传成功且仅含白名单字段',
    uplinkOk.accepted
    && uplinkOk.envelope.payload.fields.topic_tag === 'lost_family'
    && !('raw_utterance' in uplinkOk.envelope.payload.fields));
  const uplinkBadPurpose = b.syncUplink({
    data_class: 'visitor_chat', purpose: 'marketing_profile', fields: { topic_tag: 'x' },
  });
  check('未授权用途（营销画像）拒绝', uplinkBadPurpose.accepted === false);

  head('10:40-10:42 测绘定稿：地图 v2 正式移除 B→C，路线 v2 走 F→X→D（林荫道）');
  at('2026-09-20T10:40:00+08:00');
  b.publishMapByVersion('2');
  at('2026-09-20T10:41:00+08:00');
  b.publishRouteByVersion('2', { setCurrent: false }); // 先备可用，恢复时经检查点核对再切换
  // 路线不再经过暴晒段 F→D：讲解主管对已推迟的 N-FD 明确替代去向
  b.delegateNarration(tkId, 'N-FD', 'replaced_by', { replacedBy: 'N-XD' });
  check('接管期间当前路线仍冻结在 1.1', b.status().versions.route.version === '1.1');
  check('N-FD 已被 N-XD 替代（不再占未完成清单，去向可查）',
    b.state.narrations.get('N-FD').status === 'replaced'
    && b.state.narrations.get('N-FD').replaced_by === 'N-XD');
  at('2026-09-20T10:42:00+08:00');
  weather({ temperature_c: 33, storm_level: 0, storm_level_label: '无' });
  battery(82); // 人工更换满电电池
  b.observe('device', T.VISITOR_HELP, { resolved: true, resolution_note: '已与家人汇合' });
  check('接管期间不做自动派生：降级保留在账面，模式仍为 manual',
    b.status().control_mode === 'manual' && !!findDeg('storm_suspend'));

  head('10:45 人工驾驶到 X 点，逐项安全核验后准备恢复（新检查点+新版本双核对）');
  at('2026-09-20T10:45:00+08:00');
  b.checkpoint('X');
  b.prepareResume(tkId, {
    checkpoint_id: 'X',
    checked_by: { staff_id: 'S-309', name: '高越', role: 'duty:engineer' },
    safety_checks: [
      { item: '围挡仍在、B→C 不放行', result: 'pass' },
      { item: 'F→X→D 路宽与路面', result: 'pass' },
      { item: '无积水（暴雨已过）', result: 'pass' },
      { item: '电量 82%', result: 'pass' },
      { item: '定位置信度', result: 'pass' },
    ],
    map_version: 2, route_version: '2', content_version: '1.1',
  });
  const wrongVersion = b.resumeAuto(tkId, {
    at_checkpoint: 'X', observed_map_version: '1.1', confirmed_by: { staff_id: 'S-309' },
  });
  check('设备自报地图仍是 1.1 时拒绝自动恢复', wrongVersion.accepted === false);
  const wrongCheckpoint = b.resumeAuto(tkId, {
    at_checkpoint: 'F', observed_map_version: 2, confirmed_by: { staff_id: 'S-309' },
  });
  check('设备实际位置与恢复检查点不符时拒绝', wrongCheckpoint.accepted === false);

  at('2026-09-20T10:46:00+08:00');
  const resumeRes = b.resumeAuto(tkId, {
    at_checkpoint: 'X', observed_map_version: 2,
    confirmed_by: { staff_id: 'S-309', name: '高越' },
  });
  check('在 X 点、设备自报地图 v2 → 恢复成功', resumeRes.accepted);
  check('恢复后当前地图/路线切到 v2/2',
    b.status().versions.map.version === '2' && b.status().versions.route.version === '2');
  pos(30.25181, 120.15221, 0.95);
  check('恢复后首个观察触发重估：暴雨/高温/电量/求助降级全部清除',
    !findDeg('storm_suspend') && !findDeg('extreme_heat')
    && !findDeg('battery_insufficient') && !findDeg('visitor_help'),
    JSON.stringify(activeDeg()));
  check('控制模式回到 auto', b.status().control_mode === 'auto');

  head('10:50 在 X→D 段播放林荫道讲解 N-XD');
  at('2026-09-20T10:50:00+08:00');
  b.startNarration('N-XD', 4);
  at('2026-09-20T10:55:00+08:00');
  b.completeNarration('N-XD');
  b.completeSegment(); // 到达 D（段4 X→D 完成，进入段5 D→E）

  head('11:02 到达 D：被推迟的望春桥讲解 N-BC 在此续讲，不静默丢失');
  at('2026-09-20T11:02:00+08:00');
  b.startNarration('N-BC', 5);
  const nBc = b.state.narrations.get('N-BC');
  check('N-BC 在 D 点续播，且保留"曾推迟到 D"的去向历史',
    nBc.status === 'playing' && nBc.history.some(
      (h) => h.disposition === 'defer_to_checkpoint'),
    JSON.stringify(nBc.history));
  at('2026-09-20T11:05:00+08:00');
  b.completeNarration('N-BC');
  b.startNarration('N-DE', 5);
  at('2026-09-20T11:18:00+08:00');
  b.completeNarration('N-DE');
  b.completeSegment(); // 到达 E，任务完成
  b.closeTakeover(tkId, '游客已安置，任务在 v2 路线下完成，接管关闭');
  check('任务完成', b.status().progress.status === 'completed');

  head('复盘：值班员以发生时的版本回答“哪里降级、谁接手”');
  const a1 = b.answerAt('2026-09-20T09:33:30+08:00');
  check('09:33:30 复盘：暂停原因含暴雨，责任人安全员郑海',
    a1.degradations.some((d) => d.code === 'storm_suspend' && d.owner.staff_id === 'S-204'));
  check('09:33:30 复盘：当时路线仍是 v1.1（不被现在的 v2 污染）',
    String(a1.versions.route.version) === '1.1');
  const a2 = b.answerAt('2026-09-20T09:37:30+08:00');
  check('09:37:30 复盘：人工接管中，能还原请求人/确认人/冻结点/未完成讲解',
    a2.takeover && a2.takeover.confirmed_by.staff_id === 'S-204'
    && a2.takeover.freeze.checkpoint_id === 'F'
    && a2.progress.unfinished_narrations.some((n) => n.id === 'N-FD'));
  const a3 = b.answerAt('2026-09-20T09:12:40+08:00');
  check('09:12:40 复盘：只能看到地图 v1（v2 尚未发生，不靠当前状态猜历史）',
    a3.versions.map.version === '1' && a3.degradations.length >= 1);
  const a4 = b.answerAt('2026-09-20T10:46:30+08:00');
  check('10:46:30 复盘：已在 v2 地图/路线恢复自动',
    a4.versions.map.version === '2' && String(a4.versions.route.version) === '2'
    && a4.control_mode === 'auto');

  line('');
  line(`场景结束：${pass} 项通过，${fail} 项失败；事件总数 ${b.events().length}，接入拒绝 ${b.state.rejects.length} 条（均已审计）。`);
  return { pass, fail, failDetails, backend: b, events: b.events() };
}

// 场景作为库运行（npm run demo 走 src/console.js demo，以写入正式数据目录）。
