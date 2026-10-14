import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installComfyExtension } from '../lib/extension-install.js';
import { apply } from '../lib/host.js';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('custom_nodes installs a discoverable frontend-only package and keeps unrelated files on update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-custom-extension-'));
  await mkdir(join(root, 'other-node'));
  await writeFile(join(root, 'other-node', '__init__.py'), 'KEEP');
  const installed = await installComfyExtension({ customNodesDir: root }, 'http://127.0.0.1:19000');
  assert.equal(installed.status, 'installed'); assert.equal(installed.mode, 'custom_nodes');
  const init = await readFile(join(root, 'dsh-comfyui-bridge', '__init__.py'), 'utf8');
  assert.match(init, /WEB_DIRECTORY = "\.\/web"/); assert.match(init, /NODE_CLASS_MAPPINGS = \{\}/);
  const loader = await readFile(join(root, 'dsh-comfyui-bridge', 'web', 'loader.js'), 'utf8');
  assert.ok(loader.includes('http://127.0.0.1:19000')); assert.equal(loader.includes('__DSH_DEFAULT_BRIDGE__'), false);
  assert.equal(new URL('../../scripts/app.js', 'http://comfy/extensions/dsh-comfyui-bridge/loader.js').pathname, '/scripts/app.js');
  await installComfyExtension({ customNodesDir: root }, 'http://127.0.0.1:19001');
  const updated = await readFile(join(root, 'dsh-comfyui-bridge', 'web', 'loader.js'), 'utf8');
  assert.ok(updated.includes('http://127.0.0.1:19001')); assert.equal(updated.includes('19000'), false);
  assert.equal(await readFile(join(root, 'other-node', '__init__.py'), 'utf8'), 'KEEP');
});

test('existing frontendExtensionsDir installation remains supported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-frontend-extension-'));
  const installed = await installComfyExtension({ frontendExtensionsDir: root }, 'http://127.0.0.1:19000');
  assert.equal(installed.status, 'installed'); assert.equal(installed.mode, 'frontend');
  const loader = await readFile(join(root, 'dsh-comfyui', 'loader.js'), 'utf8');
  assert.equal(loader.includes('__DSH_DEFAULT_BRIDGE__'), false);
  assert.ok(loader.includes('http://127.0.0.1:19000'));
});

test('missing paths, invalid host paths, conflicting modes and unwritable targets return actionable diagnostics', async () => {
  const missing = await installComfyExtension({}, 'http://127.0.0.1:19000');
  assert.equal(missing.status, 'unconfigured'); assert.match(missing.message, /customNodesDir.*frontendExtensionsDir/);
  assert.equal((await installComfyExtension({ customNodesDir: 'relative' }, 'http://127.0.0.1:19000')).status, 'failed');
  const root = await mkdtemp(join(tmpdir(), 'dsh-blocked-extension-')), blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'KEEP');
  const failed = await installComfyExtension({ customNodesDir: blocked }, 'http://127.0.0.1:19000');
  assert.equal(failed.status, 'failed'); assert.match(failed.message, /安装失败/);
  assert.equal(await readFile(blocked, 'utf8'), 'KEEP');
  const conflict = await installComfyExtension({ customNodesDir: root, frontendExtensionsDir: root }, 'http://127.0.0.1:19000');
  assert.equal(conflict.status, 'failed'); assert.match(conflict.message, /只设置一个/);
  if (process.platform === 'win32') {
    const unix = await installComfyExtension({ customNodesDir: '/usr/local/container-only' }, 'http://127.0.0.1:19000');
    assert.equal(unix.status, 'failed'); assert.match(unix.message, /Windows/);
  }
});

test('extension installation failure does not prevent host settings and MCP tools from starting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-install-host-')), blocked = join(root, 'not-a-directory');
  await writeFile(blocked, 'KEEP'); await mkdir(join(root, 'comfyui'));
  await writeFile(join(root, 'comfyui', 'config.json'), JSON.stringify({ customNodesDir: blocked }));
  const previousHome = process.env.DSH_HOME, effects = [], routes = [], tools = [], warnings = [];
  process.env.DSH_HOME = root;
  t.after(async () => {
    for (const dispose of effects.reverse()) await dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  });
  await apply({ effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); },
    logger: { warn: text => warnings.push(text) }, webServer: { register(route) { routes.push(route); } },
    tools: { register(tool) { tools.push(tool); } } });
  assert.equal(tools.length, 27); assert.equal(warnings.length, 1); assert.match(warnings[0], /安装失败/);
  let settings;
  const response = { writeHead(code) { assert.equal(code, 200); }, end(body) { settings = JSON.parse(body); } };
  await routes.find(route => route.path === '/dsh-comfyui/api').handler({ method: 'GET', headers: {} }, response);
  assert.equal(settings.extensionInstallation.status, 'failed');
  assert.ok(settings.mcp.endpoint);
});

function loaderPage(source, search = '') {
  let extension;
  const requests = [], scripts = [], timers = [];
  const context = vm.createContext({ app: { registerExtension(value) { extension = value; } },
    window: {}, location: { search }, URLSearchParams,
    document: { createElement: () => ({}), head: { appendChild(script) { scripts.push(script); } } },
    fetch: async path => { requests.push(path); return { ok: true, json: async () => ({ token: 'fixture' }) }; },
    setTimeout(fn) { timers.push(fn); } });
  vm.runInContext(source.replace(/^import[^\n]*\n/, ''), context);
  return { setup: () => extension.setup(), requests, scripts, timers };
}

test('a raw portable loader is inert on standalone pages and connects from panel parameters', async () => {
  const source = await readFile(new URL('../comfy-extension.js', import.meta.url), 'utf8');
  const standalone = loaderPage(source); await standalone.setup(); await flush();
  assert.equal(standalone.requests.length, 0); assert.equal(standalone.timers.length, 0);
  const panel = loaderPage(source, '?dsh_bridge=' + encodeURIComponent('http://127.0.0.1:19000'));
  await panel.setup(); await flush();
  assert.deepEqual(panel.requests, ['http://127.0.0.1:19000/__dsh_comfyui/bootstrap']);
  assert.equal(panel.scripts[0].src, 'http://127.0.0.1:19000/__dsh_comfyui/bridge.js');
});

test('installed defaults still synchronize standalone pages and explicit panel origins take priority', async () => {
  const source = (await readFile(new URL('../comfy-extension.js', import.meta.url), 'utf8'))
    .replaceAll('__DSH_DEFAULT_BRIDGE__', JSON.stringify('http://127.0.0.1:19000'));
  const standalone = loaderPage(source); await standalone.setup(); await flush();
  assert.equal(standalone.requests[0], 'http://127.0.0.1:19000/__dsh_comfyui/bootstrap');
  const panel = loaderPage(source, '?dsh_bridge=' + encodeURIComponent('http://127.0.0.1:19001'));
  await panel.setup(); await flush();
  assert.equal(panel.requests[0], 'http://127.0.0.1:19001/__dsh_comfyui/bootstrap');
});
