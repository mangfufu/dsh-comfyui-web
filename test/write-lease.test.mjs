import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime } from '../lib/runtime.js';
import { callComfyTool } from '../lib/mcp.js';
import { MCP_TOOLS } from '../lib/tool-definitions.js';

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-lease-'));
  return new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
}
const panel = (id, sessionId) => ({ id, sessionId, ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });

test('the first canvas write takes the lease and a second conversation is refused', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  const dispatched = [];
  rt.command = async (sessionId, action) => { dispatched.push({ sessionId, action }); return { nodes: [] }; };

  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 3 }] }, { dshSessionId: 'A' });
  assert.equal(rt.leaseState().holder, 'A', 'a write renews the lease for its own session');
  assert.equal(rt.leaseState().heldForMs >= 0, true);

  await assert.rejects(callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 4 }] }, { dshSessionId: 'B' }),
    /写租约被另一条对话持有（A，空闲 \d+ 秒）/);
  assert.equal(dispatched.length, 1, 'the refused write never reached the canvas');

  // Reads stay free while someone holds the lease.
  const read = await callComfyTool(rt, 'list_nodes', {}, { dshSessionId: 'B' });
  assert.equal(read.structuredContent.nodes.length, 0);
  assert.equal(rt.leaseState().holder, 'A', 'reading does not steal the lease');
});

test('a dead holder is reclaimed and only the holder may release without force', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.command = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });

  await assert.rejects(callComfyTool(rt, 'lease', { op: 'release' }, { dshSessionId: 'B' }), /不能替它释放/);
  const who = await callComfyTool(rt, 'lease', {}, { dshSessionId: 'B' });
  assert.equal(who.structuredContent.holder, 'A');

  // The holder's panel disappears (conversation closed) and the TTL passes.
  rt.clients.delete('pA');
  rt.lease.renewedAt = Date.now() - 6 * 60 * 1000;
  assert.equal((await callComfyTool(rt, 'lease', { op: 'who' })).structuredContent.holder, null,
    'an abandoned lease must not block the canvas until the next restart');

  const taken = await callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' });
  assert.equal(taken.structuredContent.holder, 'B');
});

test('force takeover is possible but has to be asked for explicitly', async t => {
  const rt = await runtime(); t.after(() => rt.stop());
  rt.clients.set('pA', panel('pA', 'A'));
  rt.command = async () => ({ nodes: [] });
  await callComfyTool(rt, 'update_nodes', { changes: [{ nodeId: 1, widget: 'seed', value: 1 }] }, { dshSessionId: 'A' });
  await assert.rejects(callComfyTool(rt, 'lease', { op: 'take' }, { dshSessionId: 'B' }), /另一条对话持有/);
  const forced = await callComfyTool(rt, 'lease', { op: 'take', force: true }, { dshSessionId: 'B' });
  assert.equal(forced.structuredContent.holder, 'B');
});

test('lease is registered as a state-changing tool with explicit operations', () => {
  const lease = MCP_TOOLS.find(tool => tool.name === 'lease');
  assert.ok(lease);
  assert.equal(lease.annotations.readOnlyHint, false, 'lease can change state, so it is not read-only');
  assert.deepEqual(lease.inputSchema.properties.op.enum, ['who', 'take', 'release']);
});
