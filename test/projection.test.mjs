import test from 'node:test';
import assert from 'node:assert/strict';
import { callComfyTool, backstopWorkflowProjection } from '../lib/mcp.js';
import { MCP_TOOLS } from '../lib/tool-definitions.js';
import {
  FULL_GRAPH_BUDGET_BYTES, byteLength, resolveMode, summarizeWorkflow,
  digestQueue, digestHistory, maybeProject
} from '../lib/projection.js';

// A stand-in for a real H3 workflow on this machine (96–171 KB): every queued or
// recorded item embeds the whole prompt graph, which used to reach the model verbatim.
function fatGraph(nodes = 120) {
  const graph = {};
  for (let i = 1; i <= nodes; i++) {
    graph[String(i)] = { class_type: 'KSampler', inputs: { seed: i, prompt: 'a '.repeat(200), steps: 30 } };
  }
  return graph;
}
const fatWorkflow = { nodes: Array.from({ length: 120 }, (_, i) => ({ id: i + 1, type: 'KSampler', widgets_values: ['a'.repeat(400)] })), links: [], groups: [] };

test('queue and history digests keep identity and outputs but drop the embedded graph', () => {
  const raw = { queue_running: [[0, 'p-run', fatGraph(), ['9'], {}]], queue_pending: [[1, 'p-wait', fatGraph(), ['9'], {}]] };
  assert.ok(byteLength(raw) > 50_000, 'fixture must be fat enough to matter');
  const digest = digestQueue(raw);
  assert.equal(digest.counts.running, 1);
  assert.deepEqual([digest.running[0].promptId, digest.running[0].number, digest.running[0].state], ['p-run', 0, 'running']);
  assert.equal(digest.running[0].nodeCount, 120);
  assert.deepEqual(digest.running[0].outputNodes, ['9']);
  assert.equal(JSON.stringify(digest).includes('KSampler'), false, 'no node payloads leak into the digest');
  assert.ok(byteLength(digest) < 600);

  const history = { 'p-run': { prompt: [5, 'x', fatGraph(), { extra_pnginfo: { workflow: { extra: { ds: { workflow_id: 'wf-1' } } } } }, []],
    outputs: { 9: { images: [{ filename: 'h3.mp4', subfolder: 'vid', type: 'output' }] }, 12: { videos: [{ filename: 'h3.mp4' }] } },
    status: { status_str: 'error', completed: false, timestamp: 1700, messages: [['execution_error', { node_id: 7, node_type: 'KSampler', exception_message: 'CUDA out of memory' }], ['execution_interrupted', {}]] } } };
  const record = digestHistory(history).items[0];
  assert.equal(record.status, 'error');
  assert.equal(record.nodeCount, 120);
  assert.equal(record.workflowId, 'wf-1');
  assert.deepEqual(record.outputs.map(output => output.nodeId), ['9', '12']);
  assert.equal(record.errors[0].message, 'CUDA out of memory');
  assert.equal(record.interrupted, true);
  assert.equal(JSON.stringify(record).includes('a '.repeat(50)), false);
});

test('projection is size-gated and reversible, and never touches small payloads', () => {
  const small = { queue_running: [[0, 'p', { 1: { class_type: 'A' } }, [], {}]], queue_pending: [] };
  const passthrough = maybeProject('auto', small, { budgetBytes: 8192, shape: '队列摘要', tool: 'queue', build: digestQueue, reason: '测试' });
  assert.equal(passthrough.projected, false);
  assert.deepEqual(passthrough.value, small, 'small graphs must stay byte-for-byte identical');

  const fat = maybeProject('auto', { queue_running: [[0, 'p', fatGraph(), [], {}]] }, { budgetBytes: 8192, shape: '队列摘要', tool: 'queue', build: digestQueue, reason: '队列内嵌整图' });
  assert.equal(fat.projected, true);
  assert.equal(fat.projection.fullCall.tool, 'queue');
  assert.match(fat.projection.reason, /超过/);

  const forced = maybeProject('full', small, { budgetBytes: 1, shape: 'x', tool: 'queue', build: digestQueue, reason: '测试' });
  assert.equal(forced.projected, false);
  assert.deepEqual(forced.value, small);

  assert.throws(() => resolveMode('nope', 'queue'), /mode 只能是/);
  assert.equal(resolveMode(undefined, 'history'), 'auto');
  assert.throws(() => resolveMode('summary', 'history'), /auto \/ full/);
  assert.equal(resolveMode('summary', 'get_workflow'), 'summary');
});

test('get_workflow summary carries structure without widget payloads', () => {
  const summary = summarizeWorkflow(fatWorkflow, { promptNodes: 120 });
  assert.equal(summary.nodeCount, 120);
  assert.equal(summary.promptNodeCount, 120);
  assert.equal(summary.nodes[0].widgetCount, 1);
  assert.equal(JSON.stringify(summary).includes('aaaa'), false, 'values must not be copied');
  assert.ok(byteLength(summary) < FULL_GRAPH_BUDGET_BYTES);
});

test('MCP tools project oversized replies and honour mode=full', async () => {
  const fatQueue = { queue_running: [[0, 'p', fatGraph(), [], {}]], queue_pending: [] };
  const calls = [];
  const runtime = { mcpEnabled: true, async request(path) { calls.push(path); return fatQueue; } };
  const result = await callComfyTool(runtime, 'queue', {});
  assert.equal(result.structuredContent.projection.projected, true);
  assert.ok(result.content[0].text.length < 2000, `projected reply stayed small: ${result.content[0].text.length}`);
  const full = await callComfyTool(runtime, 'queue', { mode: 'full' });
  assert.equal(full.structuredContent.projection, undefined);
  assert.equal(full.structuredContent.queue_running[0][2]['1'].class_type, 'KSampler', 'mode=full returns the raw payload');

  const small = { queue_running: [], queue_pending: [[0, 'p', { 1: { class_type: 'A' } }, [], {}]] };
  const tiny = await callComfyTool({ ...runtime, request: async () => small }, 'queue', {});
  assert.deepEqual(tiny.structuredContent, small);
});

test('get_workflow projects oversized graphs but leaves the documented raw shape alone', async () => {
  const fat = { workflow: fatWorkflow, prompt: fatGraph() };
  const command = async () => fat;
  const projected = await callComfyTool({ mcpEnabled: true, command }, 'get_workflow', {}, { dshSessionId: 'own' });
  assert.equal(projected.structuredContent.projection.projected, true);
  assert.equal(projected.structuredContent.nodeCount, 120);
  assert.ok(projected.content[0].text.length < 8000, `summary is small: ${projected.content[0].text.length}`);

  // The contract old clients rely on: an empty graph comes back exactly as sent.
  const empty = { workflow: { nodes: [], links: [] }, prompt: {} };
  const kept = await callComfyTool({ mcpEnabled: true, command: async () => empty }, 'get_workflow', {}, { dshSessionId: 'own' });
  assert.deepEqual(kept.structuredContent, empty);

  const forced = await callComfyTool({ mcpEnabled: true, command: async (session, action, args) => {
    assert.equal(args.mode, 'full'); return fat; } }, 'get_workflow', { mode: 'full' }, { dshSessionId: 'own' });
  assert.deepEqual(forced.structuredContent, fat);

  // A page running an older bridge.js ignores mode and returns the whole graph anyway.
  const backstopped = backstopWorkflowProjection({ mode: 'auto' }, fat);
  assert.equal(backstopped.projection.projected, true);
  assert.match(backstopped.fallbackNote, /较旧/);
  assert.equal(backstopWorkflowProjection({ mode: 'full' }, fat), fat);
});

test('list_nodes drops parameter values above the budget and restores them on demand', async () => {
  const fat = { nodes: Array.from({ length: 40 }, (_, index) => ({ id: String(index + 1), type: 'KSampler', mode: 0,
    widgets: [{ name: 'seed', type: 'number', value: 123, min: 0, max: 1e15 }, { name: 'prompt', type: 'STRING', value: 'x'.repeat(3000) }],
    inputs: [{ name: 'latent', type: 'LATENT', slot: 0, link: 5 }], outputs: [{ name: 'image', type: 'IMAGE', slot: 0, links: [7, 8] }] })) };
  const asked = [];
  const runtime = { mcpEnabled: true, async command(session, action, args) { asked.push(args); return fat; } };
  const projected = await callComfyTool(runtime, 'list_nodes', {}, { dshSessionId: 'own' });
  const text = projected.content[0].text;
  assert.equal(projected.structuredContent.projection.projected, true);
  assert.equal(projected.structuredContent.nodeCount, 40);
  assert.equal(text.includes('xxxx'), false, 'values must not be copied into the skeleton');
  assert.equal(text.includes('"min"'), false, 'ranges belong to detail=values');
  assert.deepEqual(projected.structuredContent.nodes[0].widgets.map(w => w.name), ['seed', 'prompt']);
  assert.equal(projected.structuredContent.nodes[0].outputs[0].links, 2);
  assert.equal(projected.structuredContent.nodes[0].inputs[0].connected, true);
  assert.equal(projected.structuredContent.projection.fullCall.args.detail, 'values');

  const values = await callComfyTool(runtime, 'list_nodes', { detail: 'values', filter: 'KSampler' }, { dshSessionId: 'own' });
  assert.equal(values.structuredContent.projection, undefined);
  assert.equal(values.structuredContent.nodes[0].widgets[0].value, 123);
  assert.deepEqual(asked.at(-1), { filter: 'KSampler' }, 'detail must stay plugin-side, not leak into the bridge command');

  const forced = await callComfyTool(runtime, 'list_nodes', { detail: 'skeleton' }, { dshSessionId: 'own' });
  assert.equal(forced.structuredContent.projection.projected, true);
  await assert.rejects(callComfyTool(runtime, 'list_nodes', { detail: 'nope' }, { dshSessionId: 'own' }), /detail 只能是/);

  const small = { nodes: [{ id: '1', type: 'KSampler', widgets: [{ name: 'seed', type: 'number', value: 7 }], inputs: [], outputs: [] }] };
  const tiny = await callComfyTool({ mcpEnabled: true, command: async () => small }, 'list_nodes', {}, { dshSessionId: 'own' });
  assert.deepEqual(tiny.structuredContent, small, 'small canvases keep the original reply exactly');
});

test('tool surface keeps its size and gains only optional projection modes', () => {
  assert.equal(MCP_TOOLS.length, 27, 'no tools added or removed');
  for (const name of ['get_workflow', 'queue', 'history']) {
    const tool = MCP_TOOLS.find(item => item.name === name);
    assert.deepEqual(tool.inputSchema.properties.mode.enum, name === 'get_workflow' ? ['auto', 'full', 'summary'] : ['auto', 'full']);
    assert.equal((tool.inputSchema.required || []).includes('mode'), false, 'mode must stay optional');
    assert.ok(tool.annotations.readOnlyHint, name + ' stays read-only');
  }
  const listed = MCP_TOOLS.find(tool => tool.name === 'list_nodes');
  assert.deepEqual(listed.inputSchema.properties.detail.enum, ['auto', 'values', 'skeleton']);
  assert.equal((listed.inputSchema.required || []).includes('detail'), false);
  assert.ok(listed.annotations.readOnlyHint);
});
