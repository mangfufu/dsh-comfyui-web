(() => {
  'use strict';
  if (window.__DSH_COMFYUI_BRIDGE_ACTIVE__) return;
  window.__DSH_COMFYUI_BRIDGE_ACTIVE__ = true;
  const bridgeProtocol = 5;
  const bridgeVersion = '0.5.7';
  const bootstrap = window.__DSH_COMFYUI_BOOTSTRAP__ || {};
  let token = bootstrap.token || __DSH_BRIDGE_TOKEN__;
  const bridgeBase = bootstrap.bridgeBase || location.origin;
  const query = new URLSearchParams(location.search);
  const embedded = !!(query.get('dsh_client') && query.get('dsh_session') && window.parent !== window);
  let warnedWeakUUID = false;
  const warnWeakUUID = reason => {
    if (warnedWeakUUID) return;
    warnedWeakUUID = true;
    console.warn('[dsh-comfyui-bridge] Falling back to Math.random UUID generation:', reason);
  };
  const randomHex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  const randomUUID = () => {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
    let bytes;
    try {
      if (typeof globalThis.crypto?.getRandomValues === 'function') {
        bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      }
    } catch (error) { warnWeakUUID(error?.message || 'crypto.getRandomValues failed'); }
    if (!bytes && !warnedWeakUUID) warnWeakUUID('Web Crypto is unavailable');
    const hex = bytes ? [...bytes].map(b => b.toString(16).padStart(2, '0')) : Array.from({ length: 16 }, randomHex);
    hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0');
    hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
    return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
  };
  const clientId = embedded ? query.get('dsh_client') : randomUUID();
  const sessionId = embedded ? query.get('dsh_session') : 'comfyui-external';
  let parentOrigin;
  if (embedded) { try { parentOrigin = new URL(document.referrer).origin; } catch { return; } }
  let allowAI = embedded; let visible = true; let busy = false;
  let revision = 0; let lastFingerprint; let initialized = false; let syncOwner, syncPath;
  const histories = new Map(); const completed = new Map();
  const commandQueue = []; let handlingCommands = false, commandStream, reconnectTimer;
  const appOf = () => window.comfyAPI?.app?.app;
  const apiOf = () => window.comfyAPI?.api?.api;
  const activeWorkflowOf = app => {
    const workflow = app?.extensionManager?.workflow?.activeWorkflow;
    return workflow && typeof workflow === 'object' ? workflow : null;
  };
  const rootGraphOf = app => app?.rootGraph || app?.graph;
  function graphReady(app) {
    return !!(rootGraphOf(app) && app.canvas && !app.configuringGraph &&
      !window.comfyAPI?.changeTracker?.ChangeTracker?.isLoadingGraph &&
      activeWorkflowOf(app));
  }
  function diagnostics() {
    const app = appOf();
    const tabs = app?.extensionManager?.workflow?.openWorkflows;
    return { bridgeProtocol, bridgeVersion, ready: graphReady(app), allowAI,
      visible: visible && document.visibilityState !== 'hidden',
      hasActiveWorkflow: !!activeWorkflowOf(app), workflowTabs: Array.isArray(tabs) ? tabs.length : null };
  }
  const notify = data => { if (embedded) window.parent.postMessage({ source: 'dsh-comfyui', clientId, ...data }, parentOrigin); };
  window.addEventListener('message', event => {
    if (!embedded || event.source !== window.parent || event.origin !== parentOrigin || event.data?.source !== 'dsh-comfyui-parent' || event.data.clientId !== clientId) return;
    const changed = allowAI !== (event.data.allowAI === true) || visible !== (event.data.visible === true);
    allowAI = event.data.allowAI === true; visible = event.data.visible === true;
    if (changed) send('state', {}).catch(() => {});
  });
  const send = async (path, data) => {
    const r = await fetch(bridgeBase + '/__dsh_comfyui/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify({ clientId, sessionId, ...diagnostics(), ...data }) });
    if (r.status === 403) {
      const next = await (await fetch(bridgeBase + '/__dsh_comfyui/bootstrap')).json();
      token = next.token; revision = 0; initialized = false;
      throw new Error('正在重新连接 ComfyUI 桥接');
    }
    if (!r.ok) throw new Error(await r.text()); return r.json();
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function snapshot(app) { return clone(rootGraphOf(app).serialize()); }
  function fingerprint(workflow) {
    const clean = clone(workflow);
    // Each browser owns its workflow identity and local revision. Sharing them
    // makes native loaders normalize the graph differently on every page.
    delete clean.id; delete clean.revision;
    if (clean.extra) delete clean.extra.ds;
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return JSON.stringify(stable(clean));
  }
  async function replaceCurrentWorkflow(app, workflow) {
    if (!graphReady(app)) throw new Error('ComfyUI 当前工作流正在载入，请稍后再试');
    const active = activeWorkflowOf(app);
    // Never use loadGraphData's null/string fallback: it creates temporary tabs.
    if (!active) throw new Error('ComfyUI 当前工作流尚未就绪，请稍后再试');
    const data = clone(workflow);
    const localId = snapshot(app).id;
    if (localId != null) data.id = localId;
    else delete data.id;
    const ds = app.canvas.ds;
    const view = ds ? { scale: ds.scale, offset: Array.from(ds.offset) } : null;
    try {
      const loaded = await app.loadGraphData(data, false, false, active,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      if (loaded === false) throw new Error('ComfyUI 未能载入工作流');
    } finally {
      if (view && app.canvas.ds) { app.canvas.ds.scale = view.scale; app.canvas.ds.offset[0] = view.offset[0]; app.canvas.ds.offset[1] = view.offset[1]; }
      app.graph.setDirtyCanvas(true, true);
    }
  }
  async function syncWorkflow(app, { check = true } = {}) {
    const owner = activeWorkflowOf(app);
    if (!owner?.path) return;
    if (owner !== syncOwner || owner.path !== syncPath) { syncOwner = owner; syncPath = owner.path; revision = 0; initialized = false; lastFingerprint = undefined; forceSync = true; }
    // Detecting a change costs a whole serialize + fingerprint pass. When the graph has
    // not moved we still send the sync — that POST is how this tab pulls other tabs'
    // edits — but with an empty body, so the idle heartbeat carries no payload.
    const push = forceSync || !initialized || (check && graphChanged(app));
    let workflow, current;
    if (push) { workflow = snapshot(app); current = fingerprint(workflow); }
    const changed = workflow !== undefined && initialized && current !== lastFingerprint;
    const update = await send('sync', { workflowKey: owner.path, revision, ...(workflow ? { workflow, fingerprint: current } : {}) });
    // A manual workflow switch can finish while the network request is pending.
    // Defer the response rather than applying it to the new tab or a loading graph.
    if (!graphReady(app) || activeWorkflowOf(app) !== owner) return;
    if (update.workflow) {
      if (update.conflict && changed) {
        try { localStorage.setItem('dsh.comfyui.sync-conflict.' + clientId, JSON.stringify(workflow)); } catch {}
        notify({ warning: '另一页也修改了工作流，已同步最新图；本页冲突副本保存在浏览器中。' });
      }
      if (fingerprint(update.workflow) !== current) await replaceCurrentWorkflow(app, update.workflow);
      lastFingerprint = fingerprint(snapshot(app));
    } else if (workflow) lastFingerprint = current;
    forceSync = false;
    noteGraphVersion(app);
    revision = update.revision; initialized = true;
  }
  // Idle cadence exists to drain commands if the SSE stream silently dies and to pull
  // other tabs' edits; both are second-scale concerns. While the stream is open the
  // page reports state through /state, so 750 ms buys nothing but POSTs.
  const FAST_POLL_MS = 750, IDLE_POLL_MS = 4000;
  let lastGraphVersion = null, forceSync = true;
  const streamAlive = () => !!commandStream && commandStream.readyState === (EventSource.OPEN ?? 1);
  const pollDelay = () => streamAlive() ? IDLE_POLL_MS : FAST_POLL_MS;
  const graphVersionOf = app => {
    try {
      const graph = app?.graph;
      if (!graph) return null;
      if (typeof graph.version === 'function') return graph.version();
      // Current front-ends expose the counter as graph._version (a getter backed by
      // their change tracker, bumped from incrementVersion()); reading it is free.
      return Number.isFinite(graph._version) ? graph._version : null;
    } catch { return null; }
  };
  const noteGraphVersion = app => { lastGraphVersion = graphVersionOf(app); };
  function graphChanged(app) {
    const version = graphVersionOf(app);
    // An unseen version baseline means we have no evidence yet: serialize.
    if (version != null) return lastGraphVersion === null || version !== lastGraphVersion;
    // Builds without a counter still flip isModified from their change tracker; an
    // absent signal (fakes, exotic builds) is treated as "changed" and behaves as before.
    return activeWorkflowOf(app)?.isModified !== false;
  }
  async function poll() {
    if (busy || handlingCommands) { setTimeout(poll, pollDelay()); return; } busy = true;
    try {
      const ready = graphReady(appOf());
      if (ready) await syncWorkflow(appOf());
      const response = await send('poll', {});
      notify({ ready, allowAI });
      commandQueue.push(...response.commands || []);
    } catch (e) { notify({ ready: false, error: e.message }); }
    finally { busy = false; handleCommands(); setTimeout(poll, pollDelay()); }
  }
  const historyKey = app => 'dsh.comfyui.history.' + encodeURIComponent(location.origin + ':' + sessionId + ':' + activeWorkflowOf(app).path);
  function historyOf(app) {
    const key = historyKey(app);
    if (!histories.has(key)) {
      let saved;
      try { saved = JSON.parse(globalThis.localStorage?.getItem?.(key) || 'null'); } catch {}
      histories.set(key, saved?.version === 1 && Array.isArray(saved.undo) && Array.isArray(saved.redo) ? saved : { version: 1, undo: [], redo: [] });
    }
    return histories.get(key);
  }
  function saveHistory(app, history) {
    const key = historyKey(app);
    for (;;) {
      try { globalThis.localStorage?.setItem?.(key, JSON.stringify(history)); break; }
      catch {
        if (history.undo.length > 1) history.undo.shift();
        else if (history.redo.length > 1) history.redo.shift();
        else throw new Error('工作流快照保存失败，浏览器存储空间不足；本次修改未提交，请清理空间后重试');
      }
    }
    histories.set(key, history);
  }
  function graphHash(app) {
    const text = fingerprint(snapshot(app)); let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return String(hash >>> 0);
  }
  const checkpoint = (app, label) => ({ id: randomUUID(), time: Date.now(), label, workflow: snapshot(app) });
  function workflowStore(app) {
    const store = app.extensionManager?.workflow;
    if (!store?.getWorkflowByPath || !store?.createNewTemporary) throw new Error('此 ComfyUI 前端未提供工作流标签页接口，请更新前端');
    return store;
  }
  function describeWorkflow(store, workflow) {
    return { path: workflow.path, name: workflow.filename || workflow.path,
      active: workflow === store.activeWorkflow, open: store.openWorkflows?.some(w => w.path === workflow.path) === true,
      saved: workflow.isPersisted === true, modified: workflow.isModified === true };
  }
  async function workflowData(app, workflow) {
    if (workflow === activeWorkflowOf(app)) return snapshot(app);
    const loaded = workflow.isLoaded ? workflow : await workflow.load();
    if (!loaded?.activeState) throw new Error('无法读取该工作流');
    return clone(loaded.activeState);
  }
  async function openWorkflow(app, workflow, data) {
    const retained = activeWorkflowOf(app), previous = snapshot(app);
    try {
      const loaded = await app.loadGraphData(data, true, true, workflow,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      if (loaded === false || activeWorkflowOf(app)?.path !== workflow.path) throw new Error('ComfyUI 未能打开工作流');
    } catch (error) {
      if (retained) await app.loadGraphData(previous, true, true, retained,
        { checkForRerouteMigration: false, silentAssetErrors: true });
      throw error;
    }
  }
  function nodes(app) {
    return (app.graph._nodes || []).map(n => ({ id: String(n.id), type: n.type, title: n.title, mode: n.mode,
      widgets: (n.widgets || []).filter(w => w.type !== 'button').map(w => ({ name: w.name, type: w.type, value: w.value ?? null,
        ...(Array.isArray(w.options?.values) ? { choices: w.options.values } : {}),
        ...(typeof w.options?.min === 'number' ? { min: w.options.min, max: w.options.max ?? null } : {}) })),
      inputs: (n.inputs || []).map((i, slot) => ({ name: i.name, type: i.type, slot, link: i.link ?? null })),
      outputs: (n.outputs || []).map((o, slot) => ({ name: o.name, type: o.type, slot, links: o.links || [] })) }));
  }
  async function executeAction(command) {
    const app = appOf(); const args = command.args || {};
    if (!allowAI) throw new Error('此面板已关闭 AI 操作');
    if (!graphReady(app)) throw new Error('ComfyUI 工作流尚未就绪');
    switch (command.action) {
      case 'save_workflow':
      case 'save_as_workflow': {
        const store = workflowStore(app), active = activeWorkflowOf(app);
        if (!store.saveWorkflow || !store.saveAs) throw new Error('当前 ComfyUI 前端没有工作流保存接口');
        const name = args.name;
        if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.+$/.test(name))) throw new Error('请提供有效的工作流文件名称');
        active.changeTracker?.prepareForSave();
        const targetPath = name ? (active.directory || active.path.slice(0, active.path.lastIndexOf('/'))) + '/' + name.replace(/\.json$/i, '') + '.json' : active.path;
        if (targetPath === active.path) {
          if (command.action === 'save_as_workflow') throw new Error('另存时请使用一个新的文件名称');
          await store.saveWorkflow(active);
        } else {
          await store.syncWorkflows?.();
          if (store.getWorkflowByPath(targetPath)) throw new Error('同名工作流已存在，请使用其他名称；不会覆盖已有文件');
          if (command.action === 'save_workflow' && !active.isPersisted) {
            const history = historyOf(app);
            if (!store.renameWorkflow) throw new Error('当前 ComfyUI 不支持工作流重命名保存');
            await store.renameWorkflow(active, targetPath); saveHistory(app, history);
            await store.saveWorkflow(active);
          } else {
            const target = store.saveAs(active, targetPath);
            try { await openWorkflow(app, target, await workflowData(app, target)); target.changeTracker?.prepareForSave(); await store.saveWorkflow(target); }
            catch (error) {
              if (activeWorkflowOf(app) !== active) await openWorkflow(app, active, await workflowData(app, active));
              if (!target.isPersisted) await store.closeWorkflow?.(target); throw error;
            }
          }
        }
        return { saved: true, workflow: describeWorkflow(store, store.activeWorkflow) };
      }
      case 'edit_graph': {
        if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 100) throw new Error('operations 必须包含 1–100 项');
        const graph = app.graph, aliases = new Map(), changed = [];
        const nodeOf = id => { const node = aliases.get(String(id)) || graph.getNodeById(id); if (!node || node.graph !== graph) throw new Error('节点不存在：' + id); return node; };
        const position = value => { if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)) throw new Error('position 必须是两个有限数字'); return value; };
        for (const operation of args.operations) {
          if (operation.op === 'create_node') {
            const node = window.LiteGraph?.createNode(operation.nodeType);
            if (!node) throw new Error('节点类型不存在：' + operation.nodeType);
            if (operation.ref && (aliases.has(operation.ref) || graph.getNodeById(operation.ref))) throw new Error('新节点 ref 重复：' + operation.ref);
            if (operation.position) node.pos = position(operation.position);
            if (operation.title) node.title = operation.title;
            graph.add(node); if (operation.ref) aliases.set(operation.ref, node);
            changed.push({ op: operation.op, ref: operation.ref || null, nodeId: String(node.id) });
          } else if (operation.op === 'delete_node') {
            const node = nodeOf(operation.nodeId); graph.remove(node); changed.push({ op: operation.op, nodeId: String(node.id) });
          } else if (operation.op === 'move_node') {
            const node = nodeOf(operation.nodeId); node.pos = position(operation.position); changed.push({ op: operation.op, nodeId: String(node.id) });
          } else if (operation.op === 'connect') {
            const from = nodeOf(operation.fromNodeId), to = nodeOf(operation.toNodeId);
            if (!Number.isInteger(operation.fromSlot) || !from.outputs?.[operation.fromSlot] || !Number.isInteger(operation.toSlot) || !to.inputs?.[operation.toSlot]) throw new Error('连接插槽不存在，请先 list_nodes');
            const link = from.connect(operation.fromSlot, to, operation.toSlot);
            if (!link) throw new Error('连接失败，插槽类型不兼容');
            changed.push({ op: operation.op, linkId: link.id });
          } else if (operation.op === 'disconnect') {
            const node = nodeOf(operation.nodeId);
            if (!Number.isInteger(operation.toSlot) || !node.inputs?.[operation.toSlot]) throw new Error('输入插槽不存在');
            node.disconnectInput(operation.toSlot); changed.push({ op: operation.op, nodeId: String(node.id) });
          } else throw new Error('未知节点操作：' + operation.op);
        }
        app.graph.setDirtyCanvas(true, true); return { changed, nodes: nodes(app) };
      }
      case 'bind_image': {
        const node = app.graph.getNodeById(args.nodeId), widget = node?.widgets?.find(widget => widget.name === args.widget);
        if (!widget || widget.type === 'button') throw new Error('目标图片参数不存在，请先 list_nodes 获取准确 nodeId/widget');
        if (Array.isArray(widget.options?.values) && !widget.options.values.includes(args.value)) widget.options.values.push(args.value);
        widget.value = args.value; widget.callback?.(args.value, app.canvas, node);
        app.graph.setDirtyCanvas(true, true); return { nodeId: String(node.id), widget: widget.name, value: widget.value };
      }
      case 'list_edits': {
        const history = historyOf(app);
        return { workflowPath: activeWorkflowOf(app).path, checkpoints: [...history.undo].reverse().map(item => ({
          checkpointId: item.id, time: item.time, label: item.label, nodes: item.workflow.nodes.length
        })), canRedo: history.redo.length > 0 };
      }
      case 'restore_edit': {
        const saved = historyOf(app).undo.find(item => item.id === args.checkpointId);
        if (!saved) throw new Error('当前工作流没有该快照，请先 list_edits');
        await replaceCurrentWorkflow(app, saved.workflow); return { restored: true, checkpointId: saved.id, nodes: nodes(app) };
      }
      case 'list_workflows': {
        const store = workflowStore(app);
        await store.syncWorkflows?.();
        return { activePath: store.activeWorkflow?.path,
          open: (store.openWorkflows || []).map(w => describeWorkflow(store, w)),
          saved: (store.persistedWorkflows || []).map(w => describeWorkflow(store, w)) };
      }
      case 'switch_workflow': {
        const store = workflowStore(app);
        const workflow = store.getWorkflowByPath(args.path);
        if (!workflow) throw new Error('工作流不存在，请先 list_workflows 获取准确 path');
        if (workflow !== activeWorkflowOf(app)) await openWorkflow(app, workflow, await workflowData(app, workflow));
        return { switched: true, workflow: describeWorkflow(store, store.activeWorkflow) };
      }
      case 'new_workflow': {
        const store = workflowStore(app);
        const source = args.sourcePath ? store.getWorkflowByPath(args.sourcePath) : activeWorkflowOf(app);
        if (!source) throw new Error('源工作流不存在，请先 list_workflows');
        const data = await workflowData(app, source);
        data.id = randomUUID(); delete data.revision;
        const name = args.name || (source.filename || 'Workflow').replace(/\.json$/i, '') + ' (Copy)';
        if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /^\.+$/.test(name)) throw new Error('请使用不含路径分隔符的工作流名称');
        const workflow = store.createNewTemporary(name.replace(/\.json$/i, '') + '.json', data);
        try { await openWorkflow(app, workflow, data); }
        catch (error) { await store.closeWorkflow?.(workflow); throw error; }
        return { created: true, sourcePath: source.path, workflow: describeWorkflow(store, store.activeWorkflow) };
      }
      case 'list_nodes': return { nodes: nodes(app).filter(n => !args.filter || (n.type + ' ' + n.title).toLowerCase().includes(args.filter.toLowerCase())) };
      case 'get_workflow': return { workflow: snapshot(app), prompt: (await app.graphToPrompt()).output };
      case 'update_nodes': {
        const changes = args.changes;
        if (!Array.isArray(changes) || !changes.length || changes.length > 500) throw new Error('changes 必须是包含 1–500 项的数组');
        const edits = changes.map(change => {
          const node = app.graph.getNodeById(change.nodeId);
          if (!node) throw new Error('节点不存在：' + change.nodeId);
          const widget = (node.widgets || []).find(w => w.name === change.widget);
          if (!widget || widget.type === 'button') throw new Error('可编辑参数不存在：' + change.nodeId + '.' + change.widget);
          if (typeof widget.value === 'number' && (typeof change.value !== 'number' || !Number.isFinite(change.value))) throw new Error(widget.name + ' 必须是数字');
          if (typeof widget.value === 'string' && typeof change.value !== 'string') throw new Error(widget.name + ' 必须是文本');
          if (typeof widget.value === 'boolean' && typeof change.value !== 'boolean') throw new Error(widget.name + ' 必须是布尔值');
          if (Array.isArray(widget.options?.values) && !widget.options.values.includes(change.value)) throw new Error(widget.name + ' 的值不在可选项中');
          if (typeof change.value === 'number' && ((widget.options?.min != null && change.value < widget.options.min) || (widget.options?.max != null && change.value > widget.options.max))) throw new Error(widget.name + ' 超出节点允许的范围');
          return { node, widget, value: change.value, before: clone(widget.value) };
        });
        for (const edit of edits) edit.widget.value = edit.value;
        for (const edit of edits) edit.widget.callback?.(edit.value, app.canvas, edit.node);
        app.graph.setDirtyCanvas(true, true);
        return { changed: edits.map(e => ({ nodeId: String(e.node.id), widget: e.widget.name, before: e.before, after: e.widget.value })) };
      }
      case 'load_workflow': {
        if (!args.workflow || !Array.isArray(args.workflow.nodes) || !Array.isArray(args.workflow.links)) throw new Error('请提供普通 ComfyUI 工作流 JSON（包含 nodes、links），不是 API prompt');
        await replaceCurrentWorkflow(app, args.workflow);
        return { loaded: true, nodes: nodes(app) };
      }
      case 'undo':
      case 'redo': {
        const history = clone(historyOf(app));
        const source = command.action === 'undo' ? history.undo : history.redo;
        if (!source.length) throw new Error('当前工作流已切换或没有可' + (command.action === 'undo' ? '撤销' : '重做') + '的 AI 修改');
        if (history.expectedHash && history.expectedHash !== graphHash(app)) throw new Error('工作流又被手动或其他页面修改了，请先 list_edits，再明确使用 restore_edit 恢复所需快照');
        const before = snapshot(app), reverse = checkpoint(app, command.action);
        try {
          await replaceCurrentWorkflow(app, source.pop().workflow);
          (command.action === 'undo' ? history.redo : history.undo).push(reverse);
          history.expectedHash = graphHash(app); saveHistory(app, history);
        } catch (error) { await replaceCurrentWorkflow(app, before); throw error; }
        return { restored: true, nodes: nodes(app) };
      }
      case 'run': {
        const api = apiOf();
        if (!api?.queuePrompt) throw new Error('当前 ComfyUI 前端没有 queuePrompt 接口');
        const prompt = await app.graphToPrompt();
        const result = await api.queuePrompt(0, prompt);
        return { submitted: true, ...result };
      }
      default: throw new Error('未知面板操作：' + command.action);
    }
  }
  async function execute(command) {
    if (command.expiresAt && Date.now() > command.expiresAt) throw new Error('此指令已经过期，未执行；请恢复连接后读取当前状态再操作');
    const writes = ['update_nodes', 'bind_image', 'load_workflow', 'edit_graph', 'restore_edit'];
    if (!writes.includes(command.action)) return executeAction(command);
    const app = appOf();
    if (!allowAI || !graphReady(app)) return executeAction(command);
    const before = snapshot(app), history = clone(historyOf(app)), pending = clone(history);
    pending.undo.push(checkpoint(app, command.action)); pending.undo = pending.undo.slice(-20); pending.redo = [];
    saveHistory(app, pending);
    try {
      const result = await executeAction(command);
      pending.expectedHash = graphHash(app); saveHistory(app, pending); return result;
    } catch (error) {
      if (fingerprint(snapshot(app)) !== fingerprint(before)) await replaceCurrentWorkflow(app, before);
      saveHistory(app, history); throw error;
    }
  }
  async function handleCommands() {
    if (busy || handlingCommands) return;
    handlingCommands = true;
    try {
      while (commandQueue.length) {
        const command = commandQueue.shift();
        let reply = completed.get(command.id);
        if (!reply) {
          try {
            if (graphReady(appOf())) await syncWorkflow(appOf());
            reply = { id: command.id, result: await execute(command) };
            // A write must always be published, whatever the counter says about it.
            if (['update_nodes', 'bind_image', 'load_workflow', 'undo', 'redo', 'restore_edit', 'edit_graph', 'save_workflow', 'save_as_workflow', 'switch_workflow', 'new_workflow'].includes(command.action)) { forceSync = true; await syncWorkflow(appOf()); }
          }
          catch (e) { reply = { id: command.id, error: e.message || String(e) }; }
          completed.set(command.id, reply);
          if (completed.size > 200) completed.delete(completed.keys().next().value);
        }
        await send('result', reply);
      }
    } catch (e) { notify({ ready: false, error: e.message }); }
    finally { handlingCommands = false; }
  }
  async function connectCommands() {
    if (typeof EventSource !== 'function') return;
    clearTimeout(reconnectTimer); commandStream?.close();
    try {
      const response = await fetch(bridgeBase + '/__dsh_comfyui/bootstrap');
      const data = await response.json();
      if (!response.ok || data.bridgeProtocol !== bridgeProtocol) throw new Error('同步代码已更新，请刷新 ComfyUI 页面');
      if (token !== data.token) { token = data.token; initialized = false; revision = 0; }
      const stream = commandStream = new EventSource(bridgeBase + '/__dsh_comfyui/commands?' + new URLSearchParams({ token, clientId, sessionId, bridgeProtocol }));
      stream.onopen = () => { forceSync = true; send('state', {}).catch(() => {}); };
      stream.onmessage = event => { try { commandQueue.push(...JSON.parse(event.data).commands || []); handleCommands(); } catch {} };
      stream.onerror = () => { stream.close(); reconnectTimer = setTimeout(connectCommands, 2000); };
    } catch (error) { notify({ ready: false, error: error.message }); reconnectTimer = setTimeout(connectCommands, 2000); }
  }
  document.addEventListener?.('visibilitychange', () => { forceSync = true; send('state', {}).catch(() => {}); handleCommands(); });
  window.addEventListener('pagehide', () => { commandStream?.close(); clearTimeout(reconnectTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { forceSync = true; connectCommands(); } });
  connectCommands();
  poll();
})();
