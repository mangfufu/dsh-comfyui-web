import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return;
  if (predicate(tree)) return tree;
  for (const child of tree.props?.children || []) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || tree.type === 'style') return '';
  return (tree.props?.children || []).map(text).join(' ');
}

async function panel(installation) {
  let plugin, index = 0, nextTimer = 0, rendered;
  const hooks = [], effects = [], registrations = [], timers = new Map(), listeners = new Map();
  const frameWindow = { postMessage() {} };
  const settings = { url: 'http://127.0.0.1:8188', frameOrigin: 'http://127.0.0.1:19000', token: 'fixture',
    mcp: { enabled: true, endpoint: 'http://127.0.0.1:19000/mcp', clientConfig: {} }, extensionInstallation: installation };
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const at = index++;
      if (!(at in hooks)) hooks[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[at].value, value => { hooks[at].value = typeof value === 'function' ? value(hooks[at].value) : value; }];
    },
    useRef(initial) { const at = index++; if (!(at in hooks)) hooks[at] = { current: initial }; return hooks[at]; },
    useEffect(fn, deps) {
      const at = index++, old = hooks[at];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects.push(() => {
        old?.cleanup?.(); hooks[at] = { deps, cleanup: fn() };
      });
    },
    useSyncExternalStore(_subscribe, read) { return read(); }
  };
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => React); } },
      addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
    crypto: { randomUUID: () => 'panel-client' }, URL, URLSearchParams, AbortController,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    fetch: async (_path, options) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (body.op === 'setMcpEnabled') settings.mcp = { ...settings.mcp, enabled: body.enabled };
      return { ok: true, json: async () => structuredClone(settings) };
    }
  });
  plugin.apply({ effect(fn) { fn(); }, sidebarRightTabs: { register() {} }, sidebarRight: { openTab() {} },
    slots: { inject(_name, fn) { fn(); }, register(def, component) { registrations.push({ def, component }); } } });
  const Body = registrations.find(row => row.def.name === 'sidebar.right.pane.tab').component;
  function render() {
    index = 0;
    rendered = Body({ sessionId: 'owner', useTabInfo: () => ({ tab: { visible: true } }) });
    const frame = find(rendered, element => element.type === 'iframe');
    if (frame) frame.props.ref.current = { contentWindow: frameWindow };
    for (const effect of effects.splice(0)) effect();
    return rendered;
  }
  render(); await flush(); render(); render();
  return { render, get tree() { return rendered; },
    expire() { const waiting = [...timers.values()].find(timer => timer.delay === 12000); assert.ok(waiting); waiting.fn(); render(); },
    receive(origin = settings.url) { listeners.get('message')({ origin, source: frameWindow,
      data: { source: 'dsh-comfyui', clientId: 'panel-client', ready: true } }); render(); },
    close() { for (const hook of hooks) hook?.cleanup?.(); } };
}

test('missing extension has a useful timeout notice, clears after a valid manual installation handshake and resets on refresh', async t => {
  const page = await panel({ status: 'unconfigured', message: '请配置 customNodesDir 或 frontendExtensionsDir。' });
  t.after(() => page.close());
  assert.equal(find(page.tree, node => node.props?.role === 'alert'), undefined);
  page.expire();
  assert.match(text(page.tree), /AI 桥接扩展未连接/);
  assert.match(text(find(page.tree, node => node.props?.role === 'alert')), /customNodesDir/);
  page.receive('https://unrelated.example');
  assert.match(text(page.tree), /AI 桥接扩展未连接/, 'an unrelated window cannot clear installation warnings');
  page.receive();
  assert.match(text(page.tree), /MCP · 共享画布已连接/);
  assert.equal(find(page.tree, node => node.props?.role === 'alert'), undefined,
    'a manually installed remote extension must not keep showing unconfigured warnings');
  find(page.tree, node => node.type === 'button' && text(node) === '刷新').props.onClick();
  page.render(); page.render();
  assert.match(text(page.tree), /等待 ComfyUI/);
  page.expire(); assert.match(text(page.tree), /AI 桥接扩展未连接/);
});

test('failed writes appear in MCP settings and disabling MCP removes the missing-bridge alarm', async t => {
  const page = await panel({ status: 'failed', message: '安装失败：目录不可写，请检查挂载。' });
  t.after(() => page.close());
  find(page.tree, node => node.type === 'button' && text(node) === 'MCP 设置').props.onClick(); page.render();
  assert.match(text(page.tree), /目录不可写/);
  const help = find(page.tree, node => node.type === 'a');
  assert.match(help.props.href, /#comfyui-extension-install$/);
  page.expire();
  await find(page.tree, node => node.type === 'input' && node.props?.role === 'switch').props.onChange({ target: { checked: false } });
  page.render();
  assert.match(text(page.tree), /MCP 已关闭/);
  assert.equal(find(page.tree, node => node.props?.role === 'alert'), undefined);
});
