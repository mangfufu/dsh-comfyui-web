import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// Boots bridge.js against a fake ComfyUI page whose widgets reproduce the real failure
// classes found in the installed packs: a hidden original widget replaced by a DOM widget
// that owns the value, a structured "reference document" in node.properties that shadows
// writes, a localized combo whose options are display strings, and a setter that just
// refuses to apply.
async function boot(nodes) {
  const code = (await readFile(new URL('../bridge.js', import.meta.url), 'utf8')).replace('__DSH_BRIDGE_TOKEN__', '"test"');
  const timers = [], replies = [], commands = [];
  const graph = {
    _nodes: nodes,
    serialize: () => ({ nodes: nodes.map(n => ({ id: n.id, type: n.type, widgets_values: (n.widgets || []).map(w => w.value) })), links: [], groups: [] }),
    setDirtyCanvas() {},
    getNodeById(id) { return nodes.find(node => String(node.id) === String(id)); }
  };
  const workflow = { path: 'workflows/H3.json', filename: 'H3', isLoaded: true, isPersisted: true, isModified: false };
  const app = { rootGraph: graph, graph, canvas: {}, configuringGraph: false,
    extensionManager: { workflow: { activeWorkflow: workflow, openWorkflows: [workflow] } },
    async graphToPrompt() { return { output: {} }; } };
  vm.runInContext(code, vm.createContext({
    window: { parent: { postMessage() {} }, comfyAPI: { app: { app } }, addEventListener() {}, LiteGraph: { createNode: () => null } },
    crypto: { randomUUID: () => 'u' + Math.random() }, URL, URLSearchParams, console,
    location: { origin: 'http://comfy.test', search: '?dsh_client=p&dsh_session=own', href: 'http://comfy.test/' },
    document: { referrer: 'http://dsh.test/', visibilityState: 'visible', addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: fn => timers.push(fn), clearTimeout() {},
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      if (String(url).includes('/result')) replies.push(body);
      return { ok: true, status: 200, json: async () => String(url).includes('/poll') ? { commands: commands.splice(0) } : { revision: 1 } };
    }
  }));
  await flush();
  return async (action, args = {}) => {
    commands.push({ id: 'c' + (replies.length + 1), action, args });
    timers.shift()(); await flush();
    const reply = replies.at(-1);
    if (reply?.error) throw Object.assign(new Error(reply.error), { bridgeError: reply.error });
    return reply.result;
  };
}

const plainNode = () => ({ id: 1, type: 'KSampler', title: '', mode: 0, properties: {},
  widgets: [{ name: 'steps', type: 'number', value: 20, min: 1, max: 100, options: { min: 1, max: 100 }, callback: () => {} },
    { name: 'mode', type: 'combo', value: 'T2VA 文生视频', options: { values: ['T2VA 文生视频', 'I2VA 图生视频'] }, callback: () => {} }],
  inputs: [], outputs: [] });

// The AICG3D shape: `prompt` is hidden and its value is only reachable through the DOM
// widget, which refuses to apply while a reference document shadows it.
const editorNode = () => {
  const prompt = { name: 'prompt', type: 'hidden', hidden: true, value: '旧内容', options: { hidden: true }, callback: () => {} };
  const doc = () => node.properties['minimax_h3_prompt_reference_doc'];
  const node = { id: 2, type: 'AICG3D_H3', title: '', mode: 0, properties: { minimax_h3_prompt_reference_doc: { parts: ['a', 'b'] } },
    widgets: [prompt, { name: 'h3_prompt_mentions', type: 'h3_prompt_mentions', value: undefined, serialize: false,
      options: { serialize: false,
        getValue: () => String(prompt.value || ''),
        setValue: value => { if (doc()) return; prompt.value = String(value); } } }],
    inputs: [], outputs: [] };
  return node;
};

const stubbornNode = () => ({ id: 3, type: 'SomeVueNode', title: '', mode: 0, properties: {},
  widgets: [{ name: 'text', type: 'custom', value: 'kept', options: { getValue: () => 'kept', setValue: () => {} } }],
  inputs: [], outputs: [] });

test('list_nodes marks the widgets whose value is not the source of truth', async () => {
  const command = await boot([plainNode(), editorNode(), stubbornNode()]);
  const listed = await command('list_nodes');
  const byId = id => listed.nodes.find(node => node.id === String(id));
  assert.equal(byId(1).widgets.find(w => w.name === 'steps').kind, undefined, 'a plain widget needs no warning');
  assert.equal(byId(1).widgets.find(w => w.name === 'mode').kind, undefined);
  assert.equal(byId(2).widgets.find(w => w.name === 'prompt').kind, 'hidden');
  assert.equal(byId(2).widgets.find(w => w.name === 'h3_prompt_mentions').kind, 'dom');
  assert.equal(byId(3).widgets.find(w => w.name === 'text').kind, 'dom');
});

test('writing a hidden prompt reroutes to the DOM widget and clears the shadowing document', async () => {
  const node = editorNode();
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 2, widget: 'prompt', value: '镜1：手腕举起座套' }] });
  const change = result.changed[0];
  assert.equal(change.requestedWidget, 'prompt', 'the reply says which widget was asked for');
  assert.equal(change.widget, 'h3_prompt_mentions', 'and which one actually owns the value');
  assert.equal(change.warning, undefined);
  assert.equal(result.warning, undefined, 'no warning when everything verified');
  assert.equal(change.verified, true);
  assert.equal(change.via, 'widget-setter');
  assert.deepEqual(change.shadowDocsCleared, ['minimax_h3_prompt_reference_doc']);
  assert.equal(node.properties['minimax_h3_prompt_reference_doc'], undefined, 'the shadow is really gone');
  assert.equal(node.widgets[0].value, '镜1：手腕举起座套', 'the archived value the prompt uses is updated');
});

test('a setter that refuses to apply is reported as unverified instead of success', async () => {
  const command = await boot([stubbornNode()]);
  const result = await command('update_nodes', { changes: [{ nodeId: 3, widget: 'text', value: 'new' }] });
  assert.equal(result.changed[0].verified, false);
  assert.equal(result.changed[0].after, 'kept');
  assert.match(result.warning, /状态由前端组件/);
});

test('plain widgets still write through value+callback and verify', async () => {
  const node = plainNode();
  const command = await boot([node]);
  const result = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'steps', value: 30 }] });
  assert.deepEqual({ ...result.changed[0], nodeId: undefined }, { nodeId: undefined, widget: 'steps', before: 20, after: 30, via: 'value+callback', verified: true });
  assert.equal(node.widgets[0].value, 30);
});

test('a localized combo rejects the authoritative value and answers with the display options', async () => {
  const command = await boot([plainNode()]);
  const error = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'mode', value: 'reference' }] }).catch(e => e.bridgeError);
  assert.match(error, /值不在可选项中/);
  assert.match(error, /"T2VA 文生视频"/, 'the reply carries the options the canvas actually accepts');
  const ok = await command('update_nodes', { changes: [{ nodeId: 1, widget: 'mode', value: 'I2VA 图生视频' }] });
  assert.equal(ok.changed[0].verified, true);
});

test('bind_image reports the widget that owns the value and whether it stuck', async () => {
  const node = editorNode();
  node.widgets[0].type = 'combo'; node.widgets[0].hidden = false; node.widgets[0].options = { values: ['old.png'] };
  const command = await boot([node]);
  const bound = await command('bind_image', { nodeId: 2, widget: 'prompt', value: 'refs/new.png' });
  assert.equal(bound.verified, true);
  assert.equal(node.widgets[0].value, 'refs/new.png');
  assert.deepEqual(node.widgets[0].options.values, ['old.png', 'refs/new.png'], 'unknown filenames are still offered');
});
