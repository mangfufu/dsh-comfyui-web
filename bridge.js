(() => {
  'use strict';
  if (window.__DSH_COMFYUI_BRIDGE_ACTIVE__) return;
  window.__DSH_COMFYUI_BRIDGE_ACTIVE__ = true;
  const bridgeProtocol = 6;
  const bridgeVersion = '0.5.12';
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
  let revision = 0; let lastFingerprint; let initialized = false; let syncPath;
  let localAuthority = true, editSequence = 0, acknowledgedEditSequence = 0, applyingRemote = false;
  const synchronization = { loaded: 0, published: 0, deferred: 0, conflicts: 0 };
  let pointerHeld = false;
  const heldKeys = new Set();
  function manualEditing() {
    if (document.visibilityState === 'hidden' || document.hasFocus?.() === false) return false;
    return pointerHeld || heldKeys.size > 0 || !!document.activeElement?.matches?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  }
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
      hasActiveWorkflow: !!activeWorkflowOf(app), workflowTabs: Array.isArray(tabs) ? tabs.length : null,
      synchronization: { ...synchronization } };
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
  function selectSyncWorkflow(app) {
    const owner = activeWorkflowOf(app);
    if (!owner?.path) return null;
    // Reactive wrappers may change while the same workflow stays active.
    // Only a different path starts a new synchronization identity.
    if (owner.path !== syncPath) {
      syncPath = owner.path; revision = 0; initialized = false; lastFingerprint = undefined;
      lastGraphVersion = null; localAuthority = true; editSequence = acknowledgedEditSequence = 0; forceSync = true;
    }
    return owner;
  }
  function localEdit(beforeChange = false) {
    const app = appOf();
    if (applyingRemote || !graphReady(app) || !selectSyncWorkflow(app)) return;
    // Discard passive loader changes before a real gesture, not after it.
    if (!localAuthority && beforeChange) {
      lastFingerprint = fingerprint(snapshot(app)); lastGraphVersion = graphVersionOf(app);
    }
    localAuthority = true; editSequence++; forceSync = true;
  }
  async function syncWorkflow(app, { check = true } = {}) {
    const owner = selectSyncWorkflow(app);
    if (!owner) return;
    const path = owner.path;
    // Detecting a change costs a whole serialize + fingerprint pass. When the graph has
    // not moved we still send the sync — that POST is how this tab pulls other tabs'
    // edits — but with an empty body, so the idle heartbeat carries no payload.
    // A graph counter alone is not proof of an edit: custom nodes also bump it
    // from timers, preview updates and delayed sizing after a remote load.
    const pendingLocalEdit = editSequence > acknowledgedEditSequence;
    const push = forceSync || !initialized || (pendingLocalEdit && check && graphChanged(app));
    const sentVersion = graphVersionOf(app);
    let workflow, current;
    if (push) { workflow = snapshot(app); current = fingerprint(workflow); }
    // Keep a baseline even before the first exchange finishes. A user can edit
    // while the initial pull is waiting or deferred by an active input field.
    if (!initialized && lastFingerprint === undefined) lastFingerprint = current;
    const changed = workflow !== undefined && current !== lastFingerprint;
    const publishing = !!workflow && localAuthority && (!initialized || (changed && pendingLocalEdit));
    const sentEditSequence = editSequence;
    // Consume only the force flag present at request time; an event arriving while
    // awaiting the network must still force the next reconciliation.
    forceSync = false;
    let update;
    // A forced reconciliation is not a local edit. In particular, do not publish
    // browser-specific defaults introduced by a previous graph load on focus/SSE resume.
    try {
      if (publishing) synchronization.published++;
      update = await send('sync', { workflowKey: path, revision, ...(publishing
        ? { workflow, fingerprint: current, seedOnly: !initialized && editSequence === acknowledgedEditSequence } : {}) });
    }
    catch (error) { forceSync = true; throw error; }
    // A manual workflow switch can finish while the network request is pending.
    // Defer the response rather than applying it to the new tab or a loading graph.
    if (!graphReady(app) || activeWorkflowOf(app)?.path !== path) return;
    let loadedRemote = false;
    if (update.workflow) {
      // Text widgets can change before the change tracker advances its counter.
      // Check the actual graph before every destructive remote replacement.
      const liveFingerprint = fingerprint(snapshot(app));
      const editedWhileWaiting = editSequence > acknowledgedEditSequence && liveFingerprint !== (current ?? lastFingerprint);
      // Do not overwrite an edit made after this request's snapshot. Retry with
      // that edit and the original revision so normal conflict recovery sees it.
      if (editedWhileWaiting) { forceSync = true; synchronization.deferred++; return; }
      if (update.conflict && changed && editSequence > acknowledgedEditSequence) {
        try { localStorage.setItem('dsh.comfyui.sync-conflict.' + clientId, JSON.stringify(update.workflow)); } catch {}
        notify({ warning: '另一页也修改了工作流，已保留本页编辑；另一页版本已备份到浏览器，正在重新同步。' });
        // Keep the unsent local edit and retry against the revision just observed.
        // An idle page has no changed content, so it cannot win this retry.
        revision = update.revision; initialized = true; forceSync = true; synchronization.conflicts++;
        return;
      }
      if (fingerprint(update.workflow) !== liveFingerprint) {
        if (manualEditing()) { forceSync = true; synchronization.deferred++; return; }
        // An existing unsaved native draft is not permission to overwrite either
        // page. Preserve it on joining; the next actual edit establishes authorship.
        if (!initialized && !embedded && owner.isModified === true && editSequence === acknowledgedEditSequence) {
          localAuthority = false; lastFingerprint = liveFingerprint; lastGraphVersion = graphVersionOf(app);
          revision = update.revision; initialized = true; return;
        }
        applyingRemote = true;
        try { await replaceCurrentWorkflow(app, update.workflow); loadedRemote = true; synchronization.loaded++; }
        finally { applyingRemote = false; }
      }
      // Keep this page a receiver until a genuine user gesture or an MCP write.
      // A timeout cannot cover custom-node normalization occurring much later.
      localAuthority = false; acknowledgedEditSequence = editSequence;
      lastFingerprint = fingerprint(snapshot(app));
    } else if (workflow) {
      lastFingerprint = current;
      if (publishing) acknowledgedEditSequence = sentEditSequence;
    }
    if (!update.workflow && update.revision === 0 && !publishing) {
      localAuthority = true; forceSync = true; initialized = false; return;
    }
    // A version observed AFTER awaiting a response may include unsent local edits.
    // Loading a remote graph may normalize node data and bump the local counter.
    // That is the new local baseline, not an edit to echo back to the other page.
    lastGraphVersion = loadedRemote ? graphVersionOf(app) : sentVersion;
    revision = update.revision; initialized = true;
  }
  // Keep lightweight cross-tab sync responsive. Only the backup command poll is
  // throttled while SSE is open; idle sync does not serialize an unchanged graph.
  const FAST_POLL_MS = 400, IDLE_POLL_MS = 4000;
  let lastGraphVersion = null, forceSync = true, lastCommandPoll = -Infinity;
  const streamAlive = () => !!commandStream && commandStream.readyState === (EventSource.OPEN ?? 1);
  const graphVersionOf = app => {
    try {
      const graph = rootGraphOf(app);
      if (!graph) return null;
      if (typeof graph.version === 'function') return graph.version();
      // Current front-ends expose the counter as graph._version (a getter backed by
      // their change tracker, bumped from incrementVersion()); reading it is free.
      return Number.isFinite(graph._version) ? graph._version : null;
    } catch { return null; }
  };
  function graphChanged(app) {
    const version = graphVersionOf(app);
    // An unseen version baseline means we have no evidence yet: serialize.
    if (version != null) return lastGraphVersion === null || version !== lastGraphVersion;
    // Builds without a counter still flip isModified from their change tracker; an
    // absent signal (fakes, exotic builds) is treated as "changed" and behaves as before.
    return activeWorkflowOf(app)?.isModified !== false;
  }
  async function poll() {
    if (busy || handlingCommands) { setTimeout(poll, FAST_POLL_MS); return; } busy = true;
    try {
      const ready = graphReady(appOf());
      if (ready) await syncWorkflow(appOf());
      if (!streamAlive() || Date.now() - lastCommandPoll >= IDLE_POLL_MS) {
        const response = await send('poll', {});
        lastCommandPoll = Date.now();
        commandQueue.push(...response.commands || []);
      }
      notify({ ready, allowAI });
    } catch (e) { notify({ ready: false, error: e.message }); }
    finally { busy = false; handleCommands(); setTimeout(poll, FAST_POLL_MS); }
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
  // A widget whose value is not the source of truth: DOM widgets own their own state,
  // hidden widgets are driven by a panel, and a serialize:false widget never reaches the
  // prompt at all. Writing `widget.value` on those looks like success and is not.
  function widgetKind(widget) {
    if (widget.type === 'button') return 'button';
    if (typeof widget.options?.setValue === 'function' || typeof widget.setValue === 'function') return 'dom';
    if (widget.type === 'hidden' || widget.hidden === true || widget.options?.hidden === true) return 'hidden';
    if (widget.serialize === false || widget.options?.serialize === false) return 'shadowed';
    return 'plain';
  }
  const widgetSetter = widget => widget.options?.setValue || widget.setValue || null;
  function widgetReadback(widget) {
    try { return typeof widget.options?.getValue === 'function' ? widget.options.getValue() : widget.value; }
    catch { return widget.value; }
  }
  // Some packs keep a structured document in node.properties and render their editor from
  // it, so a freshly written value is ignored until that shadow is dropped — the same
  // order of operations the packs use for their own "fill this in" buttons.
  const shadowDocs = node => Object.entries(node.properties || {})
    .filter(([, value]) => value && typeof value === 'object' && Array.isArray(value.parts)).map(([key]) => key);
  // A hidden original widget and the DOM widget that replaced it hold the same value;
  // writing through the visible one is what makes the editor and the archive agree.
  function writeTarget(node, widget) {
    if (widgetKind(widget) !== 'hidden' && widgetKind(widget) !== 'shadowed') return { widget, reroutedFrom: null };
    const sibling = (node.widgets || []).find(other => other !== widget && widgetSetter(other)
      && String(widgetReadback(other) ?? '') === String(widget.value ?? ''));
    return sibling ? { widget: sibling, reroutedFrom: widget.name } : { widget, reroutedFrom: null };
  }
  function writeWidget(app, node, widget, value) {
    const setter = widgetSetter(widget), kind = widgetKind(widget);
    const apply = () => {
      if (setter) setter.call(widget, value);
      else { widget.value = value; widget.callback?.(value, app.canvas, node); }
    };
    apply();
    let cleared;
    if (typeof value === 'string' && String(widgetReadback(widget) ?? '') !== value) {
      cleared = shadowDocs(node);
      if (cleared.length) { for (const key of cleared) delete node.properties[key]; apply(); }
      else cleared = null;
    }
    app.graph.setDirtyCanvas(true, true);
    const after = widgetReadback(widget);
    return { kind, via: setter ? 'widget-setter' : kind === 'plain' ? 'value+callback' : kind,
      verified: String(after ?? '') === String(value), after, cleared };
  }
  const optionHint = values => {
    const shown = values.slice(0, 12).map(v => JSON.stringify(v)).join(', ');
    return ' 画布上的可选项是 [' + shown + (values.length > 12 ? ` …共 ${values.length} 项` : '') + ']，用其中之一的原文提交。';
  };
  function nodes(app) {
    return (app.graph._nodes || []).map(n => ({ id: String(n.id), type: n.type, title: n.title, mode: n.mode,
      widgets: (n.widgets || []).filter(w => w.type !== 'button').map(w => ({ name: w.name, type: w.type, value: w.value ?? null,
        ...(widgetKind(w) === 'plain' ? {} : { kind: widgetKind(w) }),
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
        const node = app.graph.getNodeById(args.nodeId), found = node?.widgets?.find(widget => widget.name === args.widget);
        if (!found || found.type === 'button') throw new Error('目标图片参数不存在，请先 list_nodes 获取准确 nodeId/widget');
        if (Array.isArray(found.options?.values) && !found.options.values.includes(args.value)) found.options.values.push(args.value);
        const { widget, reroutedFrom } = writeTarget(node, found);
        const outcome = writeWidget(app, node, widget, args.value);
        return { nodeId: String(node.id), widget: widget.name, value: outcome.after, via: outcome.via, verified: outcome.verified,
          ...(reroutedFrom ? { requestedWidget: reroutedFrom } : {}), ...(outcome.cleared ? { shadowDocsCleared: outcome.cleared } : {}) };
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
          const found = (node.widgets || []).find(w => w.name === change.widget);
          if (!found || found.type === 'button') throw new Error('可编辑参数不存在：' + change.nodeId + '.' + change.widget);
          const { widget, reroutedFrom } = writeTarget(node, found);
          const current = widgetReadback(widget);
          if (typeof current === 'number' && (typeof change.value !== 'number' || !Number.isFinite(change.value))) throw new Error(widget.name + ' 必须是数字');
          if (typeof current === 'string' && typeof change.value !== 'string') throw new Error(widget.name + ' 必须是文本');
          if (typeof current === 'boolean' && typeof change.value !== 'boolean') throw new Error(widget.name + ' 必须是布尔值');
          if (Array.isArray(widget.options?.values) && !widget.options.values.includes(change.value)) throw new Error(widget.name + ' 的值不在可选项中；' + optionHint(widget.options.values));
          if (typeof change.value === 'number' && ((widget.options?.min != null && change.value < widget.options.min) || (widget.options?.max != null && change.value > widget.options.max))) throw new Error(widget.name + ' 超出节点允许的范围');
          return { node, widget, reroutedFrom, value: change.value, before: clone(current) };
        });
        const results = edits.map(edit => ({ edit, outcome: writeWidget(app, edit.node, edit.widget, edit.value) }));
        const unverified = results.filter(entry => !entry.outcome.verified);
        return {
          changed: results.map(({ edit, outcome }) => ({
            nodeId: String(edit.node.id), widget: edit.widget.name,
            ...(edit.reroutedFrom ? { requestedWidget: edit.reroutedFrom } : {}),
            before: edit.before, after: outcome.after, via: outcome.via, verified: outcome.verified,
            ...(outcome.cleared ? { shadowDocsCleared: outcome.cleared } : {})
          })),
          ...(unverified.length ? { warning: unverified.length + ' 项写入后回读与提交值不一致（verified:false）：该控件的状态由前端组件自己持有，写控件不会生效，别把它当成改好了。' } : {})
        };
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
          let previousAuthority, commandEditSequence;
          try {
            if (graphReady(appOf())) await syncWorkflow(appOf());
            const writesCanvas = ['update_nodes', 'bind_image', 'load_workflow', 'undo', 'redo', 'restore_edit', 'edit_graph', 'save_workflow', 'save_as_workflow', 'switch_workflow', 'new_workflow', 'run'].includes(command.action);
            if (writesCanvas && allowAI && graphReady(appOf())) {
              previousAuthority = localAuthority; localEdit(true); commandEditSequence = editSequence;
            }
            reply = { id: command.id, result: await execute(command) };
            // A write must always be published, whatever the counter says about it.
            if (writesCanvas) { forceSync = true; await syncWorkflow(appOf()); }
          }
          catch (e) {
            if (commandEditSequence !== undefined && commandEditSequence === editSequence) localAuthority = previousAuthority;
            reply = { id: command.id, error: e.message || String(e) };
          }
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
  document.addEventListener?.('pointerdown', event => { if (event.isTrusted) { pointerHeld = true; localEdit(true); } }, true);
  document.addEventListener?.('pointermove', event => { if (event.isTrusted && pointerHeld) localEdit(); }, true);
  for (const name of ['pointerup', 'pointercancel']) document.addEventListener?.(name, event => { if (event.isTrusted) { pointerHeld = false; localEdit(); } }, true);
  document.addEventListener?.('keydown', event => { if (event.isTrusted) { heldKeys.add(event.code || event.key); localEdit(true); } }, true);
  document.addEventListener?.('keyup', event => { if (event.isTrusted) { heldKeys.delete(event.code || event.key); localEdit(); } }, true);
  document.addEventListener?.('drop', event => { if (event.isTrusted) localEdit(true); }, true);
  document.addEventListener?.('paste', event => { if (event.isTrusted) localEdit(true); }, true);
  document.addEventListener?.('wheel', event => { if (event.isTrusted) localEdit(true); }, { capture: true, passive: true });
  for (const name of ['input', 'change']) document.addEventListener?.(name, event => { if (event.isTrusted) localEdit(); }, true);
  document.addEventListener?.('focusout', () => { forceSync = true; }, true);
  const clearInteraction = () => { pointerHeld = false; heldKeys.clear(); };
  window.addEventListener('blur', clearInteraction);
  document.addEventListener?.('visibilitychange', () => { if (document.visibilityState === 'hidden') clearInteraction(); forceSync = true; send('state', {}).catch(() => {}); handleCommands(); });
  window.addEventListener('pagehide', () => { commandStream?.close(); clearTimeout(reconnectTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) { forceSync = true; connectCommands(); } });
  connectCommands();
  poll();
})();
