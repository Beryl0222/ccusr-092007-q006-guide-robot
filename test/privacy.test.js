import test from 'node:test';
import assert from 'node:assert/strict';
import { movingBackend } from './helpers.js';

test('对话离线采集只保留授权白名单字段', async () => {
  const { b, clock } = await movingBackend();
  clock.set('2026-09-20T09:40:00+08:00');
  b.setConnectivity(false);
  const res = b.edgeCapture({
    data_class: 'visitor_chat',
    fields: {
      help_flag: true, topic_tag: 'lost_family', consent: true,
      captured_at: clock.iso(),
      raw_utterance: '原始对话绝不落盘', voice_clip: '<audio>',
    },
  });
  assert.equal(res.accepted, true);
  assert.equal(res.filtered.summary.raw_utterance, undefined);
  assert.deepEqual(res.filtered.denied_fields.sort(), ['raw_utterance', 'voice_clip']);
  const stored = b.state.edgeCaptures.at(-1);
  assert.equal(stored.raw_utterance, undefined);
  assert.equal(stored.topic_tag, 'lost_family');
});

test('影像离线只存哈希与障碍标记，帧与抠图被剔除', async () => {
  const { b } = await movingBackend();
  b.setConnectivity(false);
  const res = b.edgeCapture({
    data_class: 'visitor_video',
    fields: {
      frame_hash: 'sha256:aa', obstacle_flag: true, captured_at: 't',
      frame_bytes: 'BLOB', face_crop: 'BLOB',
    },
  });
  assert.equal(res.accepted, true);
  assert.deepEqual(res.filtered.denied_fields.sort(), ['face_crop', 'frame_bytes']);
});

test('影像授权永不上云：恢复联网也被拒绝', async () => {
  const { b } = await movingBackend();
  b.setConnectivity(true);
  const res = b.syncUplink({
    data_class: 'visitor_video', purpose: 'obstacle_safety_check',
    fields: { frame_hash: 'x' },
  });
  assert.equal(res.accepted, false);
});

test('对话恢复联网：授权用途可上传白名单摘要，扩大用途被拒', async () => {
  const { b } = await movingBackend();
  const ok = b.syncUplink({
    data_class: 'visitor_chat', purpose: 'handoff_summary_to_operator',
    fields: { help_flag: true, topic_tag: 'lost', raw_utterance: '不应上传' },
  });
  assert.equal(ok.accepted, true);
  assert.equal(ok.envelope.payload.fields.raw_utterance, undefined);
  const bad = b.syncUplink({
    data_class: 'visitor_chat', purpose: 'marketing_profile', fields: { topic_tag: 'x' },
  });
  assert.equal(bad.accepted, false);
});

test('无授权的数据类别离线采集被拒并审计', async () => {
  const { b } = await movingBackend();
  const res = b.edgeCapture({
    data_class: 'visitor_face_template',
    fields: { embedding: [0.1, 0.2] },
  });
  assert.equal(res.accepted, false);
  assert.ok(b.events().some((e) => e.type === 'access.denied'
    && e.payload.data_class === 'visitor_face_template'));
});
