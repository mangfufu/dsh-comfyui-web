import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoteStore, normalizeTarget } from '../lib/notes.js';
import { callComfyTool } from '../lib/mcp.js';

const store = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-notes-'));
  return { dir, notes: await new NoteStore(join(dir, 'usage-notes.json')).start() };
};

test('a bare node type and an explicit prefix land on the same key', () => {
  assert.equal(normalizeTarget('KSampler'), 'node:KSampler');
  assert.equal(normalizeTarget('node:KSampler'), 'node:KSampler');
  assert.equal(normalizeTarget('workflows/demo.json'), 'workflow:workflows/demo.json');
  assert.equal(normalizeTarget('demo.json'), 'workflow:demo.json');
  assert.equal(normalizeTarget('  '), null, 'an empty target is refused rather than silently keyed under ""');
});

test('notes dedupe, keep newest last, and cap at five', async () => {
  const { notes } = await store();
  const target = 'node:AICG3DPromptSegmentSplit';
  await notes.add(target, 'first');
  const again = await notes.add(target, 'first');
  assert.equal(again.deduplicated, true, 'the same line must not accumulate');
  assert.deepEqual(again.notes, ['first']);
  for (const line of ['second', 'third', 'fourth', 'fifth', 'sixth']) await notes.add(target, line);
  const { notes: capped } = await notes.add(target, 'seventh');
  assert.equal(capped.length, 5, 'it is a note list, not a log');
  assert.equal(capped.at(-1), 'seventh', 'the newest line is the one that survives');
  assert.equal(capped.includes('first'), false, 'the oldest line is the one that goes');
});

test('notes survive a restart and collapse whitespace', async () => {
  const { dir, notes } = await store();
  await notes.add('node:KSampler', '  write   the\nshadow doc  ');
  const reopened = await new NoteStore(join(dir, 'usage-notes.json')).start();
  assert.deepEqual(reopened.read('KSampler'), ['write the shadow doc']);
  const raw = JSON.parse(await readFile(join(dir, 'usage-notes.json'), 'utf8'));
  assert.equal(raw.version, 1);
});

test('relevant() answers with the active workflow plus only the types asked for', async () => {
  const { notes } = await store();
  await notes.add('workflow:workflows/demo.json', 'this graph needs the H3 pack loaded first');
  await notes.add('node:KSampler', 'steps above 30 times out on this box');
  await notes.add('node:AICG3DPromptSegmentSplit', 'write it through globalThis.AICG3D_H3.setPromptText');
  const found = notes.relevant({ workflowPath: 'workflows/demo.json', types: ['KSampler'] });
  assert.deepEqual(found.map(item => item.target), ['workflow:workflows/demo.json', 'node:KSampler'],
    'an unrelated node type must not ride along and push the useful line out of the reply');
  assert.deepEqual(notes.relevant({ workflowPath: 'workflows/other.json', types: ['Unknown'] }), []);
});

test('forget removes exactly the line asked for and keeps the rest', async () => {
  const { notes } = await store();
  const target = 'node:AICG3DPromptSegmentSplit';
  await notes.add(target, 'write it through globalThis.AICG3D_H3.setPromptText');
  await notes.add(target, 'the prompt doc lives on node.properties, not on the widget');
  const dropped = await notes.forget(target, 'write it through globalThis.AICG3D_H3.setPromptText');
  assert.deepEqual(dropped.removed, ['write it through globalThis.AICG3D_H3.setPromptText']);
  assert.deepEqual(dropped.notes, ['the prompt doc lives on node.properties, not on the widget'], 'the other line must survive');
  assert.equal(dropped.cleared, false);
});

test('forget without a line clears the target instead of leaving an empty entry behind', async () => {
  const { dir, notes } = await store();
  await notes.add('node:KSampler', 'one'); await notes.add('node:ShowText', 'two');
  const cleared = await notes.forget('node:KSampler');
  assert.equal(cleared.cleared, true);
  assert.deepEqual(cleared.removed, ['one']);
  assert.deepEqual(notes.all().map(item => item.target), ['node:ShowText'], 'a target that knows nothing must not linger in list');
  const reopened = await new NoteStore(join(dir, 'usage-notes.json')).start();
  assert.deepEqual(reopened.read('KSampler'), [], 'the deletion has to reach the disk, not just memory');
  assert.deepEqual(reopened.read('ShowText'), ['two']);
});

test('forget refuses a line that is not there and echoes what is', async () => {
  const { notes } = await store();
  await notes.add('node:KSampler', 'steps above 30 times out on this box');
  await assert.rejects(notes.forget('node:KSampler', 'steps above 40 times out'),
    error => /这条笔记不存在/.test(error.message)
      && error.message.includes('steps above 30 times out on this box'),
    'the refusal has to quote the real line, otherwise the caller deletes blind');
  assert.deepEqual(notes.read('KSampler'), ['steps above 30 times out on this box'], 'a refused delete must not change anything');
  await assert.rejects(notes.forget('node:KSampler', '   '), /要删的那一句是空的/);
  await assert.rejects(notes.forget('', 'x'), /note 需要 target/);
});

test('forget is safe to repeat and harmless on a target nobody wrote to', async () => {
  const { notes } = await store();
  const first = await notes.forget('node:NeverSeen');
  assert.deepEqual(first.removed, []); assert.equal(first.cleared, true);
  await notes.add('node:KSampler', 'x');
  await notes.forget('node:KSampler');
  const again = await notes.forget('node:KSampler');
  assert.deepEqual(again.removed, [], 'cleanup has to survive being run twice');
});

test('note_workflow deletes through MCP and echoes the surviving list', async () => {
  const { notes } = await store();
  const runtime = { mcpEnabled: true, noteStore: notes };
  const meta = { dshSessionId: 'A' };
  const target = 'node:AICG3DPromptSegmentSplit';
  await callComfyTool(runtime, 'note_workflow', { target, note: 'first line' }, meta);
  await callComfyTool(runtime, 'note_workflow', { target, note: 'second line' }, meta);
  const removed = (await callComfyTool(runtime, 'note_workflow', { target, note: 'first line', forget: true }, meta)).structuredContent;
  assert.equal(removed.forgotten, true);
  assert.deepEqual(removed.removed, ['first line']);
  assert.deepEqual(removed.notes, ['second line'], 'the reply lists what is left, so the caller need not ask again');
  const cleared = (await callComfyTool(runtime, 'note_workflow', { target, forget: true }, meta)).structuredContent;
  assert.deepEqual(cleared.notes, []);
  const listed = (await callComfyTool(runtime, 'note_workflow', { list: true }, meta)).structuredContent;
  assert.deepEqual(listed.notes, [], 'a cleared target must not keep showing up in list');
});

test('note_workflow still refuses a write with no note instead of deleting by accident', async () => {
  const { notes } = await store();
  const runtime = { mcpEnabled: true, noteStore: notes };
  await notes.add('node:KSampler', 'keep me');
  await assert.rejects(callComfyTool(runtime, 'note_workflow', { target: 'node:KSampler' }, { dshSessionId: 'A' }), /note 不能为空/);
  await assert.rejects(callComfyTool(runtime, 'note_workflow', { target: 'node:KSampler', list: true, forget: true }, { dshSessionId: 'A' }),
    /不能同时用/, 'a read/delete conflict has to be refused, not resolved by branch order');
  assert.deepEqual(notes.read('KSampler'), ['keep me'], 'forget is opt-in and never the default branch');
});

test('note_workflow without a store says so instead of pretending', async () => {
  const runtime = { mcpEnabled: false, noteStore: null };
  await assert.rejects(callComfyTool(runtime, 'note_workflow', { target: 'node:X', note: 'y' }, { dshSessionId: 'A' }), /MCP 已关闭/);
  const open = { mcpEnabled: true, noteStore: null };
  await assert.rejects(callComfyTool(open, 'note_workflow', { target: 'node:X', note: 'y' }, { dshSessionId: 'A' }), /笔记存储未就绪/);
  await assert.rejects(callComfyTool(open, 'note_workflow', { target: 'node:X', forget: true }, { dshSessionId: 'A' }), /笔记存储未就绪/);
});

test('an empty note is refused with the sentence to write instead', async () => {
  const { notes } = await store();
  await assert.rejects(notes.add('node:KSampler', '   '), /note 不能为空/);
  await assert.rejects(notes.add('', 'x'), /note 需要 target/);
});
