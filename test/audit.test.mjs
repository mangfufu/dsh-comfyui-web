import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { callComfyTool } from '../lib/mcp.js';
import { MCP_TOOLS } from '../lib/tool-definitions.js';
import { auditGraph, auditParams, defInputs } from '../lib/audit.js';

// ---------------------------------------------------------------- definitions

test('object_info inputs normalize into connect / widget / combo kinds', () => {
  // Shape taken verbatim from the server: `GET /object_info/<type>` returns
  // { <type>: { input: { required, optional }, output, ... } }.
  const inputs = defInputs({
    name: 'Something',
    input: {
      required: {
        model: ['MODEL', { control_after_generate: undefined }],
        seed: ['INT', { min: 0, max: 1125899906842624, default: 0 }],
        text: ['STRING', { multiline: true, default: '' }],
        ckpt_name: [['a.safetensors', 'b.safetensors'], { default: 'a.safetensors' }],
        alt_combo: ['COMBO', { values: ['x', 'y'] }],
        images: ['IMAGE'],
        both: ['IMAGE', 'MASK'],
        format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: {} }, { key: 'mp4', inputs: {} }] }],
        style: ['COMBO', { options: ['flat', 'photo'] }],
        hypernetwork_name: ['COMBO', { multiselect: false, options: [] }],
        control_net_name: [[]]
      },
      optional: { vae: ['VAE'] }
    }
  });
  assert.equal(inputs.model.kind, 'connect');
  assert.equal(inputs.model.type, 'MODEL');
  assert.equal(inputs.model.group, 'required');
  assert.equal(inputs.seed.kind, 'int');
  assert.equal(inputs.seed.min, 0);
  assert.equal(inputs.text.kind, 'string');
  assert.equal(inputs.ckpt_name.kind, 'combo');
  assert.deepEqual(inputs.ckpt_name.options, ['a.safetensors', 'b.safetensors']);
  assert.deepEqual(inputs.alt_combo.options, ['x', 'y'], 'COMBO with values: is read as an option list too');
  assert.equal(inputs.vae.group, 'optional');
  assert.equal(inputs.both.kind, 'connect', 'a list of accepted class codes is a wire, not a combo');
  assert.equal(inputs.both.type, 'IMAGE');
  assert.equal(inputs.format.kind, 'combo', 'V3 dynamic combo is a widget, so it is never "unwired required input"');
  assert.deepEqual(inputs.format.options, ['auto', 'mp4'], 'the dynamic option keys are what the canvas stores');
  assert.deepEqual(inputs.style.options, ['flat', 'photo'], 'options as the second element is an option list too');
  assert.equal(inputs.hypernetwork_name.kind, 'combo');
  assert.equal(inputs.hypernetwork_name.options, undefined, 'an empty list means filled at run time, not "nothing accepted"');
  assert.equal(inputs.control_net_name.kind, 'combo');
  assert.equal(inputs.control_net_name.options, undefined);
  assert.deepEqual(defInputs({ required: { seed: ['INT', {}] } }), {},
    'a block without the server\'s `input` envelope is not a definition — reading one must not look like "no constraints"');
});

// ---------------------------------------------------------------- graph audit

const defs = {
  KSampler: { input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'],
    latent_image: ['LATENT'], seed: ['INT', { min: 0, max: 9 }], steps: ['INT', { min: 1, max: 50 }] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd1.safetensors', 'sd2.safetensors']] } } },
  SaveImage: { input: { required: { images: ['IMAGE'] } } }
};
const node = (id, type, extra = {}) => ({ id: String(id), type, title: '', mode: 0, widgets: [], inputs: [], outputs: [], shadowDocs: [], ...extra });

test('graph audit refutes a required connection that nothing feeds', () => {
  const page = { nodes: [node(1, 'KSampler', { inputs: [{ name: 'model', type: 'MODEL', link: 3 },
    { name: 'positive', type: 'CONDITIONING', link: 4 }, { name: 'negative', type: 'CONDITIONING', link: 5 },
    { name: 'latent_image', type: 'LATENT', link: null }] })], linkCount: 3 };
  const result = auditGraph({ page, defs });
  assert.equal(result.verdict, 'refuted');
  const dangling = result.checks.find(check => check.id === 'dangling-required-input');
  assert.equal(dangling.verdict, 'refuted');
  assert.deepEqual(dangling.evidence[0], { nodeId: '1', type: 'KSampler', title: '', input: 'latent_image', needs: 'LATENT' });
});

test('a widget-backed input slot with no link is not an unwired required input', () => {
  // Real shape: the page lists combo widgets among node.inputs with link null, and V3
  // dynamic combos (SaveVideo.format) are spelled with a class-code-looking label.
  const saverDefs = { SaveVideo: { input: { required: {
    video: ['VIDEO'],
    format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto', inputs: {} }, { key: 'mp4', inputs: {} }] }] } } } };
  const page = { nodes: [node(205, 'SaveVideo', { inputs: [{ name: 'video', type: 'VIDEO', link: 12 },
    { name: 'format', type: 'COMFY_DYNAMICCOMBO_V3', slot: 1, link: null }],
  widgets: [{ name: 'format', kind: 'dom', type: 'combo', value: 'auto' }] })], linkCount: 1 };
  const result = auditGraph({ page, defs: saverDefs });
  assert.equal(result.checks.find(check => check.id === 'dangling-required-input').verdict, 'supported');
  assert.equal(result.checks.find(check => check.id === 'param-values'), undefined);
});

test('graph audit separates intentional bypass, shadowed widgets and a missing saver', () => {
  const healthy = { nodes: [node(1, 'CheckpointLoaderSimple'), node(2, 'SaveImage', { inputs: [{ name: 'images', type: 'IMAGE', link: 9 }] })], linkCount: 1 };
  assert.equal(auditGraph({ page: healthy, defs }).verdict, 'supported');
  assert.equal(auditGraph({ page: healthy, defs }).checks.find(c => c.id === 'saver-present').verdict, 'supported');

  const noSaver = { nodes: [node(1, 'CheckpointLoaderSimple')], linkCount: 0 };
  const missing = auditGraph({ page: noSaver, defs }).checks.find(c => c.id === 'saver-present');
  assert.equal(missing.verdict, 'refuted');

  const bypassed = auditGraph({ page: { nodes: [node(3, 'KSampler', { mode: 4 })], linkCount: 0 }, defs });
  assert.equal(bypassed.checks.find(c => c.id === 'bypassed-nodes').verdict, 'unresolved',
    'a bypass may be deliberate, so it must not read as a hard failure');
  assert.equal(bypassed.checks.find(c => c.id === 'dangling-required-input').verdict, 'supported',
    'muted or bypassed nodes are exempt from the wiring check');

  const shadowed = auditGraph({ page: { nodes: [node(7, 'AICG3D_H3', { shadowDocs: ['minimax_h3_prompt_reference_doc'],
    widgets: [{ name: 'prompt', kind: 'hidden' }] })], linkCount: 0 }, defs: { ...defs, AICG3D_H3: { input: { required: {} } } } });
  const shadow = shadowed.checks.find(c => c.id === 'shadowed-widgets');
  assert.equal(shadow.verdict, 'unresolved');
  assert.equal(shadow.evidence[0].hiddenPrompt, true);
  assert.match(shadow.hint, /verified/);

  const wiredUnknown = auditGraph({ page: { nodes: [node(8, 'MissingPackNode', { inputs: [{ name: 'image', type: 'IMAGE', link: 4 }],
    outputs: [{ name: 'image', type: 'IMAGE', links: [] }] })], linkCount: 1 }, defs });
  assert.equal(wiredUnknown.checks.find(c => c.id === 'definitions-known').verdict, 'unresolved',
    'an unknown type wired into the graph is a real open question');

  const annotation = auditGraph({ page: { nodes: [node(9, 'MarkdownNote', { widgets: [{ name: 'text', kind: 'plain', type: 'string', value: '备注' }] })], linkCount: 0 }, defs });
  assert.equal(annotation.checks.find(c => c.id === 'definitions-known').verdict, 'supported', 'an unwired annotation node is not an open question');
  assert.deepEqual(annotation.ignoredIsolatedTypes.types, ['MarkdownNote'], 'but it is still reported, not hidden');
  assert.equal(annotation.verdict, 'refuted', 'the missing saver still refutes on its own merits');
});

// ---------------------------------------------------------------- param audit

test('a combo whose option list is server-filled is not judged against an empty set', () => {
  const comboDefs = {
    SaveVideo: { input: { required: { format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'auto' }, { key: 'mp4' }] }] } } },
    HypernetworkLoader: { input: { required: { hypernetwork_name: ['COMBO', { options: [] }] } } }
  };
  const page = { nodes: [node(1, 'SaveVideo', { widgets: [{ name: 'format', kind: 'dom', value: 'prores' }] }),
    node(2, 'HypernetworkLoader', { widgets: [{ name: 'hypernetwork_name', kind: 'dom', value: 'something.data' }] })] };
  const values = auditParams({ page, defs: comboDefs }).checks.find(c => c.id === 'param-values');
  assert.equal(values.count, 1, 'only the value the definition really rules out is reported');
  assert.equal(values.evidence[0].nodeId, '1');
  assert.deepEqual(values.evidence[0].accepted, ['auto', 'mp4']);
});

test('param audit catches canvas values the server would reject', () => {
  const page = { nodes: [node(1, 'KSampler', { widgets: [{ name: 'seed', kind: 'plain', type: 'number', value: 99 },
    { name: 'steps', kind: 'plain', type: 'number', value: 20 }] }),
  node(2, 'CheckpointLoaderSimple', { widgets: [{ name: 'ckpt_name', kind: 'dom', type: 'combo', value: '稳定1.5（推荐）', shown: ['稳定1.5（推荐）', 'SD2'] }] })] };
  const result = auditParams({ page, defs });
  assert.equal(result.verdict, 'refuted');
  const values = result.checks.find(c => c.id === 'param-values');
  assert.equal(values.count, 2, 'the out-of-range seed and the localized combo label are both flagged');
  assert.deepEqual(values.evidence.map(item => item.widget), ['seed', 'ckpt_name']);
  assert.equal(values.evidence[0].value, 99);
  assert.deepEqual(values.evidence[0].accepted, [0, 9], 'steps=20 is inside 1..50 so it is not reported');

  const localized = auditParams({ page, defs: { ...defs, CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd1.safetensors']] } } } } });
  const flagged = localized.checks.find(c => c.id === 'param-values').evidence.find(item => item.widget === 'ckpt_name');
  assert.deepEqual(flagged.accepted, ['sd1.safetensors'], 'the reply carries the authoritative options');
  assert.match(flagged.likely, /前端本地化|提交时转换/);

  const filtered = auditParams({ page, defs, filter: 'Checkpoint' });
  assert.equal(filtered.checkedNodes, 1);
  assert.equal(filtered.checks.find(c => c.id === 'param-values').count, 1);

  const withNotes = auditParams({ page: { nodes: [...page.nodes, node(99, 'MarkdownNote', { widgets: [{ name: 'text', kind: 'plain', value: '备注' }] })] }, defs });
  assert.equal(withNotes.checks.find(c => c.id === 'uncheckable').verdict, 'supported', 'unwired annotation nodes are not open questions');
  assert.deepEqual(withNotes.ignoredUncheckable.types, ['MarkdownNote']);
  assert.equal(withNotes.checks.find(c => c.id === 'param-values').count, 2, 'the real violations are still reported');
});

// ---------------------------------------------------------------- audit tool wiring

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-audit-'));
  return new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
}
const panel = (id, sessionId) => ({ id, sessionId, ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });

test('audit pulls page facts and one object_info per distinct node type', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  const asked = [];
  rt.command = async (sessionId, action) => { asked.push(['command', action]); return {
    linkCount: 1, nodes: [node(1, 'KSampler', { widgets: [{ name: 'seed', kind: 'plain', type: 'number', value: 3 }] })] }; };
  rt.request = async path => { asked.push(['request', path]); return { KSampler: defs.KSampler }; };

  const graph = await callComfyTool(rt, 'audit', { op: 'graph' }, { dshSessionId: 'A' });
  assert.equal(graph.structuredContent.op, 'graph');
  assert.ok(['refuted', 'unresolved', 'supported'].includes(graph.structuredContent.verdict));
  assert.equal(graph.structuredContent.nodeCount, 1);
  assert.deepEqual(asked.filter(a => a[0] === 'request'), [['request', '/object_info/KSampler']], 'one lookup per distinct type');

  const params = await callComfyTool(rt, 'audit', { op: 'params', filter: 'KSampler' }, { dshSessionId: 'A' });
  assert.equal(params.structuredContent.op, 'params');
  assert.equal(params.structuredContent.checkedNodes, 1);

  await assert.rejects(callComfyTool(rt, 'audit', { op: 'nonsense' }, { dshSessionId: 'A' }), /op 只能是 graph \/ params/);
  await assert.rejects(callComfyTool(rt, 'audit', {}, {}), /需要当前对话身份/);
});

test('audit is registered as a read-only tool', () => {
  const audit = MCP_TOOLS.find(tool => tool.name === 'audit');
  assert.ok(audit);
  assert.equal(audit.annotations.readOnlyHint, true, 'audit must stay exempt from the write lease');
  assert.deepEqual(audit.inputSchema.properties.op.enum, ['graph', 'params']);
});
