import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyRuntime, BRIDGE_PROTOCOL } from '../lib/runtime.js';
import { WorkflowSync } from '../lib/sync.js';
import { connectMcp } from '../lib/mcp.js';
import { apply } from '../lib/host.js';

test('native MCP run works with a global jobs service but no controller in the minimal agent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-comfy-minimal-')), previousHome = process.env.DSH_HOME;
  const effects = [], tools = [], sockets = new Set();
  let completed = false, runCommands = 0, stopQueued = false, stopped = false, admissions = 0;
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const history = { ...(completed ? { 'minimal-prompt': { status: { status_str: 'success' },
      outputs: { 9: { images: [{ filename: 'minimal.png', type: 'output', subfolder: '' }] } } } } : {}),
      ...(stopped ? { 'stopped-prompt': { status: { status_str: 'error', messages: [['execution_interrupted', {}]] }, outputs: {} } } : {}) };
    res.end(JSON.stringify(req.url === '/queue' ? { queue_running: [], queue_pending:
      [...(completed ? [] : [[0, 'minimal-prompt']]), ...(stopQueued && !stopped ? [[1, 'stopped-prompt']] : [])] }
      : req.url.startsWith('/history') ? history
      : { system: {} }));
  });
  upstream.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  process.env.DSH_HOME = directory;
  await mkdir(join(directory, 'comfyui'));
  await writeFile(join(directory, 'comfyui', 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:' + upstream.address().port }));
  const jobs = { start() { admissions++; throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)'); } };
  await apply({ get(name) { if (name === 'jobs') return jobs; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose; },
    tools: { register(tool) { tools.push(tool); } }, webServer: { register() {} } });
  const { endpoint, token } = JSON.parse(await readFile(join(directory, 'comfyui', 'connection.json'), 'utf8'));
  const base = new URL(endpoint).origin;
  async function bridge(path, extra = {}) {
    const response = await fetch(base + '/__dsh_comfyui/' + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token },
      body: JSON.stringify({ clientId: 'minimal-panel', sessionId: 'owner', bridgeProtocol: BRIDGE_PROTOCOL,
        ready: true, allowAI: true, visible: true, ...extra }) });
    return response.json();
  }
  await bridge('poll');
  const messages = [{ id: 'human-first', role: 'user', source: { kind: 'user' } }];
  const execution = { agent: { session: { id: 'owner', deriveMessages: () => messages }, ctx: { get: () => jobs } }, signal: new AbortController().signal };
  const submitted = tools.find(tool => tool.name === 'mcp__comfyui__run').execute({}, execution);
  let commands = [];
  for (let attempt = 0; attempt < 60 && !commands.length; attempt++) {
    commands = (await bridge('poll')).commands;
    if (!commands.length) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(commands.length, 1); assert.equal(commands[0].action, 'run'); runCommands++;
  await bridge('result', { id: commands[0].id, result: { submitted: true, prompt_id: 'minimal-prompt' } });
  const result = await submitted;
  assert.equal(result.structuredContent.completionNotification, false);
  assert.equal(result.structuredContent.prompt_id, 'minimal-prompt');
  const status = await tools.find(tool => tool.name === 'mcp__comfyui__server_info').execute({}, execution);
  assert.equal(status.structuredContent.completionNotificationsAvailable, false);
  completed = true;
  const message = Buffer.from(JSON.stringify({ type: 'status', data: {} }));
  for (const socket of sockets) socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  let tasks;
  for (let attempt = 0; attempt < 60; attempt++) {
    tasks = (await tools.find(tool => tool.name === 'mcp__comfyui__list_tasks').execute({}, execution)).structuredContent.tasks;
    if (tasks[0]?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(tasks[0].status, 'completed'); assert.equal(tasks[0].media[0].filename, 'minimal.png');
  assert.equal((await bridge('poll')).commands.length, 0);
  assert.equal(runCommands, 1);
  stopQueued = true;
  const runTool = tools.find(tool => tool.name === 'mcp__comfyui__run');
  const second = runTool.execute({}, execution);
  commands = [];
  for (let attempt = 0; attempt < 60 && !commands.length; attempt++) {
    commands = (await bridge('poll')).commands;
    if (!commands.length) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(commands.length, 1); runCommands++;
  await bridge('result', { id: commands[0].id, result: { submitted: true, prompt_id: 'stopped-prompt' } });
  await second;
  stopped = true;
  for (const socket of sockets) socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  for (let attempt = 0; attempt < 60; attempt++) {
    tasks = (await tools.find(tool => tool.name === 'mcp__comfyui__list_tasks').execute({}, execution)).structuredContent.tasks;
    if (tasks.find(task => task.promptId === 'stopped-prompt')?.status === 'interrupted') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(tasks.find(task => task.promptId === 'stopped-prompt')?.result?.retryAllowed, false);
  messages.push({ id: 'completion-notice', role: 'user', source: { kind: 'tool-jobs', form: 'notice' } });
  const priorAdmissions = admissions;
  await assert.rejects(runTool.execute({}, execution), /本次 run 未提交/);
  assert.equal(admissions, priorAdmissions, 'blocked retries must not even create a background job');
  assert.equal((await bridge('poll')).commands.length, 0, 'no run command reaches ComfyUI after manual interruption');
  assert.equal(runCommands, 2);
});

test('shared canvas accepts changes, delivers them to other tabs, and preserves conflicting edit', () => {
  const sync = new WorkflowSync();
  const original = { nodes: [{ id: 6, widgets_values: ['cat'] }], links: [] };
  const updated = { nodes: [{ id: 6, widgets_values: ['dog'] }], links: [] };
  assert.equal(sync.exchange({ clientId: 'original', revision: 0, workflow: original, fingerprint: 'cat' }).revision, 1);
  assert.deepEqual(sync.exchange({ clientId: 'dsh', revision: 0 }).workflow, original);
  assert.equal(sync.exchange({ clientId: 'dsh', revision: 1, workflow: updated, fingerprint: 'dog' }).revision, 2);
  assert.deepEqual(sync.exchange({ clientId: 'original', revision: 1 }).workflow, updated);
  const conflict = sync.exchange({ clientId: 'original', revision: 1, workflow: original, fingerprint: 'cat' });
  assert.equal(conflict.conflict, true); assert.deepEqual(conflict.workflow, updated);
});

test('MCP endpoint authenticates, lists real tools, accepts calls, interoperates with official SDK', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-mcp-'));
  const runtime = await new ComfyRuntime(join(dir, 'config.json'), { port: 0 }).start();
  t.after(() => runtime.stop());
  const noAuth = await fetch(runtime.frameOrigin + '/mcp', { method: 'POST', body: '{}' }); assert.equal(noAuth.status, 401);
  const foreign = await fetch(runtime.frameOrigin + '/mcp', { method: 'POST', headers: { Origin: 'https://example.com', Authorization: 'Bearer ' + runtime.token }, body: '{}' }); assert.equal(foreign.status, 403);
  const client = await connectMcp(runtime.frameOrigin + '/mcp', runtime.token);
  assert.equal(client.initialized, true); assert.equal(client.tools.length, 28);
  const failure = await client.rpc('tools/call', { name: 'get_workflow', arguments: {} }); assert.equal(failure.isError, true);
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-mcp-client'));
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')));
  const sdk = new Client({ name: 'dsh-comfyui-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(runtime.frameOrigin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + runtime.token } } });
  await sdk.connect(transport); t.after(() => sdk.close());
  const tools = await sdk.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'get_workflow'));
  const error = await sdk.callTool({ name: 'get_workflow', arguments: {} }); assert.equal(error.isError, true);
});

test('dsh MCP adapter obtains runtime agent.session.id and cannot capture another conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-host-')); const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const effects = []; const tools = []; const routes = [];
  const ctx = {
    effect(fn) { const disposer = fn(); if (typeof disposer === 'function') effects.push(disposer); return disposer; },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    webServer: { register(route) { routes.push(route); return () => {}; } }
  };
  t.after(async () => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; for (const dispose of effects.reverse()) await dispose(); });
  await apply(ctx);
  const { endpoint, token } = JSON.parse(await readFile(join(dir, 'comfyui', 'connection.json'), 'utf8'));
  const base = new URL(endpoint).origin;
  async function bridge(path, extra = {}) {
    const response = await fetch(base + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId: 'panel', sessionId: 'owned', bridgeProtocol: BRIDGE_PROTOCOL, ready: true, allowAI: true, visible: true, ...extra }) });
    return response.json();
  }
  await bridge('poll');
  const tool = tools.find(tool => tool.name === 'mcp__comfyui__get_workflow'); assert.ok(tool);
  const execution = { agent: { session: { id: 'owned' } }, signal: new AbortController().signal };
  const result = tool.execute({}, execution);
  let commands = [];
  for (let attempt = 0; attempt < 30 && !commands.length; attempt++) { commands = (await bridge('poll')).commands; if (!commands.length) await new Promise(r => setTimeout(r, 10)); }
  assert.equal(commands[0].action, 'get_workflow');
  await bridge('result', { id: commands[0].id, result: { workflow: { nodes: [], links: [] }, prompt: {} } });
  assert.deepEqual((await result).structuredContent.workflow, { nodes: [], links: [] });
  await assert.rejects(() => tool.execute({}, { ...execution, agent: { session: { id: 'elsewhere' } } }), /这条|本条/);
  await assert.rejects(() => tool.execute({}, { ...execution, agent: { sessionId: 'owned' } }), /当前对话身份/);
});

test('MCP defaults on, disabling persists and blocks tools while preserving manual sync', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-switch-'));
  const configFile = join(dir, 'config.json');
  const runtime = await new ComfyRuntime(configFile, { port: 0 }).start();
  t.after(() => runtime.stop());
  assert.equal(runtime.mcpEnabled, true);
  const client = await connectMcp(runtime.frameOrigin + '/mcp', runtime.token);
  runtime.clients.set('panel', { id: 'panel', sessionId: 'owned', ready: true, allowAI: true, visible: true, seen: Date.now(), queue: [] });
  const queued = runtime.command('owned', 'run');
  const cancelled = assert.rejects(queued, /MCP 已关闭/);
  await runtime.setMcpEnabled(false); await cancelled;
  assert.equal(runtime.clients.get('panel').queue.length, 0);
  assert.throws(() => runtime.command('owned', 'get_workflow'), /MCP 已关闭/);
  for (const name of ['queue', 'get_workflow', 'run', 'get_image']) {
    const result = await client.rpc('tools/call', { name, arguments: { sessionId: 'owned' } });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /MCP 已关闭/);
  }
  const sync = await fetch(runtime.frameOrigin + '/__dsh_comfyui/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': runtime.token },
    body: JSON.stringify({ clientId: 'manual', sessionId: 'comfyui-external', bridgeProtocol: BRIDGE_PROTOCOL, revision: 0, workflow: { nodes: [], links: [] }, fingerprint: 'empty' }) });
  assert.equal(sync.status, 200); assert.equal((await sync.json()).revision, 1);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).mcpEnabled, false);
  const restarted = await new ComfyRuntime(configFile, { port: 0 }).start();
  t.after(() => restarted.stop()); assert.equal(restarted.mcpEnabled, false);
  await restarted.setMcpEnabled(true); assert.equal(restarted.mcpEnabled, true);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).mcpEnabled, true);
});

test('native reference tools fence attachment IDs to their session and protect the result event stream', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-comfy-references-')), oldHome = process.env.DSH_HOME;
  const upstream = http.createServer((req, res) => { req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'own.png', type: 'input' })); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  await mkdir(join(dir, 'comfyui')); await writeFile(join(dir, 'comfyui', 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:' + upstream.address().port }));
  process.env.DSH_HOME = dir;
  const effects = [], tools = [], routes = [], reads = [];
  const ctx = { effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); },
    get(service) { if (service === 'attachments') return { async readImage(ref) { reads.push(ref.attachmentId); return { data: Buffer.from('fixture') }; } }; },
    tools: { register(tool) { tools.push(tool); } }, webServer: { register(route) { routes.push(route); } } };
  t.after(async () => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    for (const dispose of effects.reverse()) await dispose(); await new Promise(r => upstream.close(r)); });
  await apply(ctx);
  const reference = { attachmentId: 'own-image', mediaType: 'image/png', width: 1, height: 1, bytes: 7 };
  const exec = { agent: { session: { id: 'own', deriveMessages: () => [{ role: 'user', content: [{ type: 'image', attachment: reference }] }] } } };
  const listing = await tools.find(tool => tool.name === 'mcp__comfyui__list_reference_images').execute({}, exec);
  assert.equal(listing.structuredContent.images[0].attachmentId, 'own-image');
  const upload = tools.find(tool => tool.name === 'mcp__comfyui__upload_image');
  await assert.rejects(upload.execute({ attachmentId: 'foreign-image' }, exec), /没有该参考图/); assert.equal(reads.length, 0);
  assert.equal((await upload.execute({ attachmentId: 'own-image' }, exec)).structuredContent.widgetValue, 'own.png');
  assert.deepEqual(reads, ['own-image']);
  const route = routes.find(route => route.path === '/dsh-comfyui/events');
  const server = http.createServer(route.handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const connection = JSON.parse(await readFile(join(dir, 'comfyui', 'connection.json'), 'utf8'));
  assert.equal((await fetch(base + '/?sessionId=own&token=bad')).status, 403);
  const stream = await fetch(base + '/?sessionId=own&token=' + connection.token);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader(); const chunk = await reader.read(); await reader.cancel();
  assert.match(Buffer.from(chunk.value).toString(), /"tasks":\[\]/);
});
