import { randomUUID } from 'node:crypto';
import { outputImages, outputVideos } from './media.js';
import { uploadImage } from './reference.js';
import { stopPolicy } from './manual-stop.js';

import { MCP_TOOLS, MCP_INSTRUCTIONS } from './tool-definitions.js';
export { MCP_TOOLS, MCP_INSTRUCTIONS } from './tool-definitions.js';
import {
  FULL_GRAPH_BUDGET_BYTES, FULL_QUEUE_BUDGET_BYTES, FULL_HISTORY_BUDGET_BYTES, FULL_NODES_BUDGET_BYTES,
  resolveMode, resolveDetail, summarizeWorkflow, skeletonNodes, digestQueue, digestHistory, maybeProject
} from './projection.js';
import { auditGraph, auditParams, auditWrites } from './audit.js';
import { doctorReport } from './doctor.js';
import { planWrites, writeEnvelope } from './write-plan.js';

// Canvas writes are serialized by ComfyRuntime's write lease, taken inside runtime.command() at
// the dispatch — not here. See WRITE_ACTIONS in runtime.js for which page actions count as writes.
const asResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

// The bridge action name is not always the tool name (audit_graph is a bridge action,
// the tool is audit). A plain "Unknown MCP tool" leaves the caller guessing, so name the
// closest tools and the whole legal list.
export function unknownToolMessage(name) {
  const wanted = String(name ?? '');
  const names = MCP_TOOLS.map(t => t.name);
  const bare = wanted.replace(/^(mcp__[^_]*__|comfy_|comfyui_)/, '');
  const distance = (a, b) => {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return rows[a.length][b.length];
  };
  const scored = names.map(candidate => ({ candidate, score: Math.min(
    distance(bare.toLowerCase(), candidate.toLowerCase()),
    candidate.toLowerCase().includes(bare.toLowerCase()) && bare ? 0 : 99) }))
    .sort((left, right) => left.score - right.score);
  const suggestions = scored.filter(item => item.score <= Math.max(2, Math.ceil(bare.length / 3))).slice(0, 3).map(item => item.candidate);
  return 'Unknown MCP tool: ' + wanted
    + (suggestions.length ? '。did_you_mean: ' + suggestions.join(' / ') + '（bridge 里的动作名不一定等于工具名，例如画布体检的桥接动作叫 audit_graph，工具名是 audit）' : '')
    + '。可用的工具是 [' + names.join(', ') + ']；先 server_info 确认面板状态，再按 tools/list 的 schema 传参。';
}
/** Join runtime.status().clients (identity) with .syncClients (handshake) on clientId. */
export function clientsWithHandshake(status) {
  const handshake = new Map((status?.syncClients || []).map(client => [client.clientId, client]));
  return (status?.clients || []).map(client => ({ ...(handshake.get(client.clientId) || {}), ...client }));
}
export async function callComfyTool(runtime, name, args = {}, meta = {}, signal) {
  if (!MCP_TOOLS.some(t => t.name === name)) throw new Error(unknownToolMessage(name));
  const sessionId = meta.dshSessionId || args.sessionId;
  if (name === 'server_info') {
    let connected = true, stats, error;
    try { stats = await runtime.request('/system_stats', {}, signal); } catch(e) { connected = false; error = e.message; }
    return asResult({ ...runtime.status(sessionId), connected, ...(stats ? { stats } : { error }), protocol: 'MCP', realtimePreview: true, realtimeCompletion: true });
  }
  if (!runtime.mcpEnabled) throw new Error('MCP 已关闭，请在 ComfyUI 面板的“MCP 设置”中开启。');
  if (name === 'lease') {
    const op = args.op || 'who';
    if (op === 'who') return asResult(runtime.leaseState());
    if (!sessionId) throw new Error('需要当前对话身份。dsh 自动提供；独立 MCP 客户端先 server_info 取得 sessionId。');
    if (op === 'take') return asResult({ action: 'take', ...runtime.acquireLease(sessionId, args.force === true) });
    if (op === 'release') return asResult({ action: 'release', ...runtime.releaseLease(sessionId, args.force === true) });
    throw new Error('lease 的 op 只能是 who / take / release');
  }
  // The write lease is taken inside ComfyRuntime.command(), at the point a page command is
  // actually dispatched — not here. Taking it at the tool boundary meant a call that died on
  // nodeId/widget/MIME validation still reserved the canvas for its conversation for a full TTL
  // (second-round report N2).
  // audit reads the canvas and needs no lease.
  if (name === 'audit') {
    if (!sessionId) throw new Error('需要当前对话身份：体检要读当前画布，dsh 自动提供，独立 MCP 客户端先 server_info 取 sessionId 和 clientId。');
    const op = args.op || 'graph';
    if (op !== 'graph' && op !== 'params' && op !== 'writes') throw new Error('audit 的 op 只能是 graph / params / writes');
    // op=params needs the serialized prompt as evidence; op=graph does not, and serializing a
    // large workflow for a structural check is pure cost. op=writes asks the page for a flags-only
    // census (no values, no graph) so a 177-control workflow costs a few KB.
    let page;
    try {
      page = await runtime.command(sessionId, op === 'writes' ? 'audit_writes' : 'audit_graph', { op }, signal, args.clientId);
    } catch (error) {
      // A page loaded before this bridge build has no census action. Saying "unknown operation" would
      // read as a broken plugin; the truth is that the tab is one refresh away from answering.
      if (op === 'writes' && /未知面板操作/.test(String(error?.message))) {
        throw new Error('这个 ComfyUI 页面还没有可写性普查能力（页面里的 bridge.js 早于插件版本）：'
          + '刷新该页面（F5）后再用 audit(op=writes)，其它工具不受影响。');
      }
      throw error;
    }
    const { defs, unresolvedTypes } = await authoritativeDefs(runtime, page, signal);
    const body = op === 'graph' ? auditGraph({ page, defs })
      : op === 'writes' ? auditWrites({ page, defs, filter: args.filter })
        : auditParams({ page, defs, filter: args.filter });
    // Notes ride along with the verdict: the check that just failed is often the one a previous
    // session already wrote down how to fix.
    const notes = notesFor(runtime, page, page?.workflowPath ?? body?.workflowPath ?? null);
    return asResult({ op, ...body, ...(notes.length ? { usageNotes: notes } : {}), ...(unresolvedTypes.length ? { unresolvedTypes: unresolvedTypes.slice(0, 10) } : {}) });
  }
  if (name === 'doctor') {
    if (!sessionId) throw new Error('需要当前对话身份：体检要读本条对话的桥接状态，dsh 自动提供，独立 MCP 客户端先 server_info 取 sessionId。');
    const status = runtime.status(sessionId);
    const facts = {
      mcpEnabled: runtime.mcpEnabled === true, pluginBridgeVersion: runtime.bridgeVersion,
      pluginBridgeProtocol: status.bridgeProtocol ?? runtime.bridgeProtocol,
      // clients carries identity (sessionId/allowAI/ready) while syncClients carries the handshake
      // facts (bridgeVersion/bridgeProtocol/refreshRequired). Neither alone answers "is this page
      // current?", so join them on clientId before judging.
      clients: clientsWithHandshake(status), sessionId,
      lease: status.writeLease,
      // R8-B: `prompt` is the audit's own prompt-serializable check, filled in below from the same page
      // reply that feeds `graph` — set here so a dead page leaves it explicitly unmeasured.
      comfy: {}, graph: null, prompt: null, promptQueued: null
    };
    try {
      const stats = await runtime.request('/system_stats', {}, signal);
      facts.comfy = { reachable: true, version: stats?.system?.comfyui_version ?? stats?.system?.python_version ?? 'reachable' };
    } catch (error) { facts.comfy = { reachable: false, error: error.message }; }
    if (facts.comfy.reachable) {
      try {
        const queue = await runtime.request('/queue', {}, signal);
        facts.promptQueued = { running: (queue.queue_running || []).length, pending: (queue.queue_pending || []).length };
      } catch { facts.promptQueued = null; }
    }
    // The canvas checks reuse the same audit the audit tool runs, so the doctor cannot
    // drift from the tool it vouches for. A dead page skips them instead of failing twice.
    let notes = [];
    if ((status.clients || []).some(client => client.sessionId === sessionId && client.ready && client.allowAI)) {
      try {
        // R8-B: ask for the param audit's page facts, not the bare structural ones. That one reply
        // carries graphToPrompt()'s outcome beside the node table (audit_graph serializes the prompt
        // when it is asked for `params`), so the submission check costs no second round trip — and it
        // is the very check `audit` reports rather than a re-derivation that could disagree with it.
        const page = await runtime.command(sessionId, 'audit_graph', { op: 'params' }, signal, args.clientId);
        const { defs } = await authoritativeDefs(runtime, page, signal);
        facts.graph = auditGraph({ page, defs });
        // serialize() succeeding says nothing about graphToPrompt(): a canvas holding subgraph proxies
        // without their definitions passes the first and throws in the second, and run / get_workflow /
        // audit(op=params) die with it. Before this, doctor answered kind:'ok' with 13 green lines over
        // exactly such a tab.
        facts.prompt = (auditParams({ page, defs }).checks || []).find(item => item.id === 'prompt-serializable') ?? null;
        // The same reply that audits the graph also measures the front-end draft store: one round
        // trip, so doctor can predict the "保存草稿失败" banner a write would produce.
        facts.draftStorage = page?.draftStorage ?? null;
        notes = notesFor(runtime, page, page?.workflowPath ?? facts.graph.workflowPath);
      } catch (error) { facts.graph = { verdict: 'unresolved', workflowPath: null,
        checks: [{ id: 'audit-unavailable', verdict: 'unresolved', title: '画布体检未能执行', count: 1, evidence: [{ error: error.message }] }] };
        // The page never answered, so the submission question is open — not passed.
        facts.prompt = { verdict: 'unresolved', evidence: [{ note: '画布体检未能执行：' + error.message }] }; }
    }
    return asResult({ tool: 'doctor', ...doctorReport(facts), ...(notes.length ? { usageNotes: notes } : {}) });
  }
  if (name === 'queue') {
    const raw = await runtime.request('/queue', {}, signal);
    const outcome = maybeProject(resolveMode(args.mode, 'queue'), raw, {
      budgetBytes: FULL_QUEUE_BUDGET_BYTES, shape: '队列摘要', tool: 'queue', build: digestQueue,
      reason: '队列里每条任务都内嵌完整图结构'
    });
    return asResult(outcome.projection ? { ...outcome.value, projection: outcome.projection } : outcome.value);
  }
  if (name === 'history') {
    const raw = await runtime.request('/history' + (args.promptId ? '/' + encodeURIComponent(args.promptId) : '?max_items=5'), {}, signal);
    const outcome = maybeProject(resolveMode(args.mode, 'history'), raw, {
      budgetBytes: FULL_HISTORY_BUDGET_BYTES, shape: '历史摘要', tool: 'history', build: digestHistory,
      reason: '每条历史记录都内嵌完整图结构'
    });
    return asResult(outcome.projection ? { ...outcome.value, projection: outcome.projection } : outcome.value);
  }
  if (name === 'object_info') {
    const data = await runtime.request('/object_info' + (args.nodeType ? '/' + encodeURIComponent(args.nodeType) : ''), {}, signal);
    return asResult(args.nodeType ? data : { nodeTypes: Object.keys(data) });
  }
  if (name === 'get_image') {
    const history = await runtime.request('/history/' + encodeURIComponent(args.promptId), {}, signal);
    const images = outputImages(history[args.promptId], args.nodeId);
    const selected = images[args.index ?? 0]; if (!selected) throw new Error('该任务尚无可读取的图片');
    const image = { ...selected, promptId: args.promptId };
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
    const res = await fetch(runtime.url + '/view?' + query, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('读取图片失败：' + res.status);
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png';
    if (!mimeType.startsWith('image/')) throw new Error('返回值不是图片');
    const bytes = Buffer.from(await res.arrayBuffer()); if (bytes.length > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请使用 ComfyUI 保存较小预览');
    return { content: [{ type: 'text', text: JSON.stringify(image) }, { type: 'image', data: bytes.toString('base64'), mimeType }], structuredContent: { image } };
  }
  if (!sessionId) throw new Error('需要当前对话身份。dsh 自动提供；独立 MCP 客户端先 server_info 获取面板的 sessionId 和 clientId。');
  if (name === 'list_reference_images') throw new Error('参考图列表需要在 dsh 对话中使用；独立 MCP 请提供 upload_image 的 dataBase64/mediaType');
  if (name === 'upload_image') return asResult(await uploadImage(runtime, { ...args, sessionId }, signal));
  if (name === 'list_tasks') return asResult({ tasks: runtime.taskResults(sessionId) });
  if (name === 'cancel_task') {
    const record = runtime.generations.owned(args.promptId, sessionId);
    if (record.result) return asResult({ cancelled: false, status: record.status, message: '任务已结束' });
    const queue = await runtime.request('/queue', {}, signal);
    if ((queue.queue_running || []).some(item => item[1] === args.promptId)) return asResult({ cancelled: false, status: 'running', message: '任务已开始；停止生成请显式使用 interrupt，会影响整个实例当前生成。' });
    if (!(queue.queue_pending || []).some(item => item[1] === args.promptId)) {
      const history = await runtime.request('/history/' + encodeURIComponent(args.promptId), {}, signal);
      if (history[args.promptId]) runtime.generations.fromHistory(record, history[args.promptId]);
      else runtime.generations.schedule?.();
      return asResult({ cancelled: false, status: record.status, message: '任务不在等待队列，已重新核对状态；没有中断生成。' });
    }
    await runtime.request('/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [args.promptId] }) }, signal);
    const after = await runtime.request('/queue', {}, signal);
    if ([...after.queue_running || [], ...after.queue_pending || []].some(item => item[1] === args.promptId)) return asResult({ cancelled: false, message: '任务可能已经开始，未中断生成，请查看 list_tasks。' });
    const history = await runtime.request('/history/' + encodeURIComponent(args.promptId), {}, signal);
    if (history[args.promptId]) { runtime.generations.fromHistory(record, history[args.promptId]); return asResult({ cancelled: false, status: record.status }); }
    runtime.generations.settle(record, { status: 'cancelled', finished: true, message: '已从等待队列删除' });
    await runtime.generations.flush(); return asResult({ cancelled: true, promptId: args.promptId, ...stopPolicy('cancelled') });
  }
  if (name === 'get_video') {
    const history = await runtime.request('/history/' + encodeURIComponent(args.promptId), {}, signal);
    const videos = outputVideos(history[args.promptId]?.outputs).filter(file => !args.nodeId || file.nodeId === args.nodeId);
    const video = videos[args.index ?? 0];
    if (!video) throw new Error('该任务尚无可播放的视频');
    return asResult(runtime.media.describe(video, args.promptId, sessionId));
  }
  if (name === 'wait_for_completion') return asResult(await runtime.generations.wait(args.promptId, sessionId, signal, args.timeoutMs ?? 60000));
  if (name === 'run') {
    runtime.manualStopGuard?.check(sessionId);
    await runtime.generations.connect(signal);
    const result = await runtime.command(sessionId, 'run', {}, signal, args.clientId);
    runtime.generations.track(result.prompt_id, sessionId);
    let persistenceWarning;
    try { await runtime.generations.flush(); } catch (error) { persistenceWarning = '任务已经提交，但恢复记录保存失败：' + error.message + '。请勿重复 run。'; }
    return asResult({ ...result, completionEvents: true, completionNotification: false, waitTool: 'wait_for_completion', ...(persistenceWarning ? { persistenceWarning } : {}) });
  }
  if (name === 'interrupt') {
    await runtime.command(sessionId, 'list_nodes', {}, signal, args.clientId);
    await runtime.request('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, signal);
    return asResult({ interrupted: true, ...stopPolicy('interrupted') });
  }
  if (name === 'note_workflow') {
    // A note is only worth recording if it comes back without being asked for, so every write
    // here lists what is already known for the target: the caller sees the dedup in the reply
    // instead of discovering it on the next call.
    if (args.list === true) {
      // list is the only read here and forget is the only delete: a call that asks for both is
      // refused instead of resolved by branch order, so nobody believes a delete happened.
      if (args.forget === true) throw new Error('list:true 与 forget:true 不能同时用：前者只读列表，后者是删除。');
      return asResult({ notes: (runtime.noteStore?.all?.() || []), ...(runtime.noteStore ? {} : { note: '笔记存储未就绪：重启 DSH 后生效。' }) });
    }
    // A note that cannot be deleted is a note nobody dares to write: the wrong line would sit in
    // front of every future conversation and the only way out used to be hand-editing
    // usage-notes.json. forget is the same entry point so the caller never has to learn a second one.
    if (args.forget === true) {
      if (!runtime.noteStore) throw new Error('笔记存储未就绪（插件未完成启动）：重启 DSH 后再改。');
      const removedFrom = args.target || await activeWorkflowTarget(runtime, sessionId, signal, args.clientId);
      if (!removedFrom) throw new Error('note_workflow 需要 target：用 "node:<节点类型>"（如 node:KSampler）或 "workflow:<工作流 path>"。当前画布没有已保存的工作流路径，所以也无法自动推断。');
      const dropped = await runtime.noteStore.forget(removedFrom, args.note);
      return asResult({ forgotten: true, ...dropped });
    }
    if (args.note === undefined || args.note === null) throw new Error('note 不能为空：写一句下一次能直接照做的话，例如「dom 控件要写它的 shadow 源 node.properties」；删除已有笔记用 forget:true。');
    const target = args.target || await activeWorkflowTarget(runtime, sessionId, signal, args.clientId);
    if (!target) throw new Error('note_workflow 需要 target：用 "node:<节点类型>"（如 node:KSampler）或 "workflow:<工作流 path>"。当前画布没有已保存的工作流路径，所以也无法自动推断。');
    if (!runtime.noteStore) throw new Error('笔记存储未就绪（插件未完成启动）：重启 DSH 后再记。');
    const saved = await runtime.noteStore.add(target, args.note);
    return asResult({ recorded: true, ...saved });
  }
  if (name === 'list_nodes') {
    const detail = resolveDetail(args.detail);
    const result = await runtime.command(sessionId, name, { filter: args.filter }, signal, args.clientId);
    // Older pages do not send workflowPath; notes then key on node type alone rather than
    // costing an extra round trip just to look up where the graph came from.
    const notes = notesFor(runtime, result, result?.workflowPath ?? null);
    // Notes are attached to the node they are about as well as to the envelope: a caller reading
    // nodes[i] should not have to remember that a sibling field exists. Nothing is added when
    // there are no notes — a canvas with no history must come back byte-identical, not carrying
    // an empty field that the caller has to learn to ignore.
    const withNotes = payload => {
      if (!notes.length) return payload;
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : null;
      const perNode = nodes ? nodes.map(node => {
        const mine = notes.filter(group => group.target === 'node:' + node.type || group.target === 'workflow:' + (payload.workflowPath ?? ''));
        return mine.length ? { ...node, usageNotes: mine.flatMap(group => group.notes) } : node;
      }) : nodes;
      return { ...payload, ...(perNode ? { nodes: perNode } : {}), usageNotes: notes };
    };
    if (detail === 'values') return asResult(withNotes(result));
    const outcome = maybeProject(detail === 'skeleton' ? 'summary' : 'auto', result, {
      budgetBytes: FULL_NODES_BUDGET_BYTES, shape: '节点骨架', tool: 'list_nodes',
      build: payload => ({ nodeCount: (payload.nodes || []).length, nodes: skeletonNodes(payload.nodes) }),
      reason: '整张画布的节点清单带着全部参数值',
      fullArgs: { detail: 'values', ...(args.filter ? { filter: args.filter } : {}) },
      hint: '骨架足够定位 nodeId、widget 名称和插槽序号；要取值先用 filter 缩到目标节点或类型，再按 fullCall 取 detail="values"，勿整张画布反复取。'
    });
    const payloadOut = outcome.projection ? { ...outcome.value, projection: outcome.projection } : outcome.value;
    return asResult(withNotes(payloadOut));
  }
  if (name === 'update_nodes') {
    // A caller that guesses the field name ("edits", "changesOrSo") otherwise gets a plan that
    // reads "changes 为空" — which blames the value, not the key. Name the key that arrived, and
    // when the caller plainly meant "one change" spell the whole payload out so the next call is
    // a copy-paste rather than another guess.
    const stray = Object.keys(args).filter(key => !['changes', 'clientId', 'sessionId'].includes(key));
    if (!Array.isArray(args.changes) && stray.length) {
      const loose = ['nodeId', 'widget', 'value'].filter(key => args[key] !== undefined);
      // A caller who sent {nodeId, widget, value} at the top level meant exactly one change.
      const example = loose.length === 3
        ? { changes: [{ nodeId: args.nodeId, widget: args.widget, value: args.value }] }
        : { changes: [{ nodeId: '195', widget: 'mode', value: '每行一段' }] };
      const error = new Error('update_nodes 的参数名是 changes（收到的是 ' + stray.join(' / ') + '）。'
        + (loose.length === 3
          ? '你传的 nodeId / widget / value 在顶层，要把这三项包进 changes 的一项里。'
          : '每项结构 {nodeId, widget, value}；nodeId 与控件名先用 list_nodes 取。')
        + ' 画布尚未改动，把下面这个原样改好后整批重发：changes=' + JSON.stringify(example.changes));
      error.hint = '整包参数就是这个对象：' + JSON.stringify(example) + '（update_nodes 只认 changes，其它键都是多余的）。';
      // structuredContent 也要能直接取用，不必从错误文案里抠 JSON。
      error.example = example;
      error.receivedKeys = stray;
      throw error;
    }
    // Two-phase: judge the batch against the live canvas and the server's own node definitions
    // before anything is written. A batch that cannot land comes back as needs_input with one
    // actionable line per blocked change, and the canvas is left untouched.
    const { page, ...plan } = await planCanvasWrites(runtime, sessionId, args, signal);
    // The notes for the node types in this batch, not for the whole canvas: a write to node 195
    // does not need to be told about a saver three nodes away.
    const types = (args.changes || [])
      .map(change => (page?.nodes || []).find(node => String(node.id) === String(change?.nodeId))?.type).filter(Boolean);
    const notes = runtime.noteStore?.relevant?.({ workflowPath: page?.workflowPath ?? null, types: [...new Set(types)] }) || [];
    if (plan.status === 'needs_input') return asResult({ ...plan, tool: 'update_nodes', written: false, ...(notes.length ? { usageNotes: notes } : {}) });
    const result = await runtime.command(sessionId, name,
      { changes: args.changes, ...(args.force === true ? { force: true } : {}) }, signal, args.clientId);
    const envelope = writeEnvelope(result, args.changes);
    // Every write marks the canvas modified, and the front-end answers that with a localStorage
    // draft ~512ms later. When the store is full the user gets a red toast that has nothing to do
    // with the write itself; measure the store so the reply can say so instead of leaving the
    // caller to guess why a successful write produced an error banner.
    const draftAutosave = await readDraftStorage(runtime, sessionId, signal, args.clientId);
    // Only speak when the store was actually measured: "unavailable" from a page that never
    // reported it is noise, not a finding.
    if (draftAutosave?.usedChars !== undefined || draftAutosave?.available === false) envelope.draftAutosave = draftEnvelope(draftAutosave);
    // R5-H — 「写完顺带保存」 has to answer which moment was saved. A pack can move the canvas right
    // after (AICG3D refills segments ~300 ms after a load), so `{saved:true}` is not proof that the file
    // matches what the canvas now holds. Save, then compare the canvas hash the page reported at save
    // time against a fresh one and report the difference instead of implying a guarantee.
    if (args.saveAfterWrite === true) {
      try {
        const saved = await runtime.command(sessionId, 'save_workflow', {}, signal, args.clientId);
        const record = { path: saved?.workflow?.path ?? null, savedStateHash: saved?.savedStateHash ?? null,
          canvasHashAtSave: saved?.canvasHash ?? null, canvasMatchesSaved: saved?.canvasMatchesSaved ?? null };
        if (envelope.status !== 'written') record.partialNote = '本批有未 verified 的项，保存的是当前画布状态（不是「这次写入成功」的凭证）。';
        await new Promise(resolve => setTimeout(resolve, 700));
        const after = await runtime.command(sessionId, 'graph_fingerprint', {}, signal, args.clientId);
        if (after?.ok && record.savedStateHash) {
          record.canvasHashNow = after.canvasHash ?? null;
          record.driftedAfterSave = after.canvasHash !== record.savedStateHash;
          if (record.driftedAfterSave) record.driftNote = '落盘的是保存那一刻的图；现在画布又变了（多为节点包在加载/序列化后自动重填，'
            + '如 AICG3D 段落解析）。要连新状态一起留档，再调一次 save_workflow。';
        } else if (after?.ok === false) {
          record.driftedAfterSave = null;
          record.driftNote = '保存后无法读取画布指纹（' + (after.error || 'unknown') + '），无法判断这一刻之后有没有再变。';
        }
        envelope.saved = record;
      } catch (error) {
        envelope.saveError = '画布写入已成功，但顺带保存失败：' + (error?.message || error)
          + '；内容还在画布上，要留档单独再调 save_workflow。';
      }
    }
    return asResult({ tool: 'update_nodes', ...envelope, ...(plan.status === 'ready' ? { planned: plan.planned } : {}), ...(plan.note ? { planNote: plan.note } : {}), ...(notes.length ? { usageNotes: notes } : {}) });
  }
  const payload = name === 'load_workflow' ? { workflow: parseWorkflowJson(args.workflowJson) }
    : name === 'switch_workflow' ? { path: args.path }
    : name === 'new_workflow' ? { sourcePath: args.sourcePath, name: args.name }
    : name === 'get_workflow' ? { mode: resolveMode(args.mode, 'get_workflow'),
        // Only forwarded when actually asked for: an absent key keeps the documented default
        // (prompt included) for panels running an older bridge that knows nothing about it.
        ...(args.includePrompt === false ? { includePrompt: false } : {}) }
    : { filter: args.filter };
  if (['save_workflow', 'save_as_workflow', 'edit_graph', 'restore_edit'].includes(name)) {
    return asResult(await runtime.command(sessionId, name, { name: args.name, operations: args.operations, checkpointId: args.checkpointId }, signal, args.clientId));
  }
  const result = await runtime.command(sessionId, name, payload, signal, args.clientId);
  if (name === 'get_workflow') {
    const view = backstopWorkflowProjection(args, result);
    // One tool, two shapes: a projection promotes the node list to the top level, while the raw
    // envelope keeps ComfyUI's {workflow, prompt}. The raw reply is a documented contract and is
    // passed through untouched; the projection is ours to annotate, so it names where the nodes
    // went — that is the shape switch that invites a "data.nodes is undefined" read.
    if (view?.projection) return asResult({ ...view, nodePath: 'nodes',
      shapeNote: '摘要：节点在顶层 nodes，连线在顶层 links；整份图用 mode="full"，届时节点回到 workflow.nodes。' });
    // The full reply is passed through untouched on purpose: its {workflow, prompt} shape is the
    // documented contract (test/projection.test.mjs asserts it), so the "nodes live at
    // workflow.nodes" fact is stated in the tool description instead of injected into the payload.
    return asResult(view);
  }
  return asResult(result);
}

/**
 * Panels still running an older bridge.js ignore `mode` and hand back the whole graph.
 * Project it here so the context budget holds no matter which bridge build is loaded;
 * the page-side projection stays because it also saves the wire bytes.
 */
// workflowJson is a JSON string on purpose: the SDK adapter forwards MCP arguments
// as-is, and an object used to die in JSON.parse with "\"undefined\" is not valid JSON",
// which told the caller nothing about the fix.
export function parseWorkflowJson(value) {
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error('workflowJson 是空字符串。请传入普通 ComfyUI 工作流 JSON 的字符串形式（必须含 nodes 与 links，不是 API prompt）。');
    try { return JSON.parse(value); }
    catch (error) {
      throw new Error('workflowJson 不是合法 JSON（' + error.message + '）。请传普通 ComfyUI 工作流 JSON 的字符串形式：{nodes:[...],links:[...]}，不是 API prompt。'
        + ' 手里已经有对象时先 JSON.stringify 再传；改磁盘工作流更稳的路线是「改文件 → load_workflow(字符串) → save_workflow」。');
    }
  }
  if (value === undefined || value === null) throw new Error('缺少 workflowJson。必须传普通 ComfyUI 工作流 JSON 的字符串形式（含 nodes、links）；不能用对象，当前值是 ' + (value === null ? 'null' : 'undefined') + '。');
  if (typeof value === 'object') throw new Error('workflowJson 必须是 JSON 字符串，不是 ' + (Array.isArray(value) ? 'array' : 'object') + '。这个工具按字符串接收后自己 JSON.parse，请先 JSON.stringify(你的工作流对象) 再传；'
    + ' 或者改磁盘上的工作流文件再 load_workflow + save_workflow 整图替换。');
  throw new Error('workflowJson 必须是 JSON 字符串，收到的是 ' + typeof value + '。');
}

export function backstopWorkflowProjection(args, result) {
  const mode = resolveMode(args.mode, 'get_workflow');
  if (mode === 'full' || !result || result.projection || !result.workflow) return result;
  // Honour the requested mode here too: an explicit mode="summary" must summarize even when the
  // graph is small, and only "auto" is allowed to decide by size.
  const outcome = maybeProject(mode, result, {
    budgetBytes: FULL_GRAPH_BUDGET_BYTES, shape: '结构摘要', tool: 'get_workflow',
    build: payload => summarizeWorkflow(payload.workflow, { promptNodes: Object.keys(payload.prompt || {}).length }),
    reason: '面板返回了完整工作流'
  });
  if (!outcome.projected) return result;
  return { ...outcome.value, projection: outcome.projection,
    // Round 7 (R7-3): this note used to assert "this page runs an old bridge" on every fallback, which
    // sent readers to refresh a page that was never the problem — the trigger here is the size budget.
    // State the measured reason, and keep the upgrade remark as what it is: one possible cause.
    fallbackNote: '本次由插件侧投影（原因：' + (outcome.projection?.reason || '面板返回了完整工作流')
      + '）。这是上下文预算保护，不是页面故障：刷新页面不保证省掉这次传输，只有本页桥接确实早于页面侧投影才刷；'
      + '需要整份内容时显式传 mode="full"，需要参数值用 list_nodes（带 filter）。' };
}

// /object_info answers change only when a pack is installed or reloaded, so a class definition
// stays valid for the life of the process. Caching per runtime keeps the write plan from adding
// a burst of requests to every update_nodes, and keeps two calls in a row from disagreeing about
// the same node type because a request flaked in between.
const defsCache = new WeakMap();

/** Authoritative per-type definitions straight from the server, not the page. */
export async function authoritativeDefs(runtime, page, signal) {
  const cache = typeof runtime === 'object' && runtime ? (defsCache.get(runtime) || defsCache.set(runtime, new Map()).get(runtime)) : new Map();
  const defs = {}, unresolvedTypes = [];
  for (const type of [...new Set((page?.nodes || []).map(node => node.type))]) {
    if (cache.has(type)) { defs[type] = cache.get(type); continue; }
    try {
      const info = await runtime.request('/object_info/' + encodeURIComponent(type), {}, signal);
      if (info?.[type]) { defs[type] = info[type]; cache.set(type, info[type]); } else unresolvedTypes.push(type);
    } catch { unresolvedTypes.push(type); }
  }
  return { defs, unresolvedTypes };
}

const notesFor = (runtime, page, workflowPath) =>
  runtime.noteStore?.relevant?.({ workflowPath, types: (page?.nodes || []).map(node => node.type) }) || [];

/** The active workflow's saved path, when the canvas has one. Notes keyed by workflow only
 *  make sense for a graph that has somewhere to be saved; an unsaved scratch graph is keyed by
 *  node type instead, which is why this returns null rather than a made-up name. */
async function pageWorkflowPath(runtime, sessionId, signal, clientId) {
  try {
    const page = await runtime.command(sessionId, 'audit_graph', {}, signal, clientId);
    return page?.workflowPath ?? null;
  } catch { return null; }
}

async function activeWorkflowTarget(runtime, sessionId, signal, clientId) {
  const path = await pageWorkflowPath(runtime, sessionId, signal, clientId);
  return path ? 'workflow:' + path : null;
}

/** localStorage drafts are the front-end's own autosave, not ours: a write cannot avoid them,
 *  but a full store is what turns "written" into a red banner on the user's screen. */
async function readDraftStorage(runtime, sessionId, signal, clientId) {
  try {
    const page = await runtime.command(sessionId, 'audit_graph', {}, signal, clientId);
    return page?.draftStorage ?? null;
  } catch { return null; }
}

/** One line a caller can act on, plus the numbers behind it. */
export function draftEnvelope(storage) {
  if (!storage || storage.available === false) return { ranAfterWrite: true, store: 'localStorage', unavailable: storage?.blocking ?? 'unknown' };
  const used = Number(storage.usedChars ?? 0);
  // The bridge's own undo snapshots live in the same quota, so "how full is the store" is the sum.
  const own = Number(storage.ownChars ?? 0);
  const total = Number(storage.totalChars ?? (used + own));
  const full = total >= 3_500_000;
  const ownNote = own > 0 ? '其中桥接自己的撤销快照 / 冲突备份占 ' + own + ' 字符；写入时若配额告急会自动回收别的会话留下的历史键，那条回执里带 historyStore。' : null;
  return {
    ranAfterWrite: true, store: 'localStorage', usedChars: used, ownChars: own, totalChars: total,
    keys: Array.isArray(storage.keys) ? storage.keys.map(item => item.key) : [],
    ...(full ? { advice: '本次写入已触发前端草稿自动保存；存储已占 ' + total + ' 字符（接近浏览器 ~5M 配额），再写有弹「保存工作流草稿失败」的风险。' + (ownNote ? ownNote + ' ' : '') + '清理：刷新页面，或在设置里关掉 Comfy.Workflow.Persist。' }
      : { advice: '本次写入已触发前端草稿自动保存（约 512ms 后写 localStorage）：这是 ComfyUI 前端的正常行为，工具侧无法关闭，其失败只影响页面草稿、不影响画布里的值。' + (ownNote ? ownNote : '') })
  };
}

/** Gather the facts the planner needs, then plan. Fails open: if the canvas cannot be read
 *  (dead page, old bridge) the batch still goes to the page, which judges it as before —
 *  a planner that cannot see must not become a planner that refuses. */
async function planCanvasWrites(runtime, sessionId, args, signal) {
  try {
    const page = await runtime.command(sessionId, 'list_nodes', {}, signal, args.clientId);
    const { defs } = await authoritativeDefs(runtime, page, signal);
    return { page, ...planWrites({ changes: args.changes, nodes: page?.nodes, defs, force: args.force === true }) };
  } catch (error) {
    return { page: null, status: 'unknown', planned: [], blocked: [], note: '写前判定未能执行（' + error.message + '），本批改动交给页面侧校验。' };
  }
}

export function createMcpHandler(runtime, readJson, json) {
  const pending = new Map();
  return async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + runtime.token) { json(res, 401, { error: 'MCP authentication required' }); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
    let message;
    try { message = await readJson(req, 32 * 1024 * 1024); }
    catch { json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const id = message.id;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') { json(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid request' } }); return; }
    if (id === undefined) {
      if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort(new Error('MCP 调用已取消'));
      res.writeHead(202); res.end(); return;
    }
    const controller = new AbortController(); pending.set(id, controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('MCP connection closed')); });
    try {
      let result;
      switch (message.method) {
        case 'initialize': result = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-comfyui-web', version: runtime.bridgeVersion }, instructions: MCP_INSTRUCTIONS }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: MCP_TOOLS }; break;
        case 'tools/call': {
          try { result = await callComfyTool(runtime, message.params?.name, message.params?.arguments, message.params?._meta, controller.signal); }
          catch(e) {
            // A tool failure has to stay machine-readable: callers need the stage, the
            // node/widget that failed and the suggested next step, not one flat sentence.
            const detail = { error: e.message };
            for (const key of ['action', 'nodeId', 'widget', 'widgetKind', 'stage', 'hint', 'writeLeaseConflict', 'lease', 'example', 'receivedKeys']) {
              if (e[key] !== undefined) detail[key] = e[key];
            }
            if (e.pageSide && e.stack) detail.stack = String(e.stack).slice(0, 4000);
            result = { isError: true, content: [{ type: 'text', text: e.message + (detail.hint ? '\n下一步：' + detail.hint : '') }], structuredContent: detail };
          }
          break;
        }
        default: json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return;
      }
      json(res, 200, { jsonrpc: '2.0', id, result });
    } finally { pending.delete(id); }
  };
}

export async function connectMcp(endpoint, token) {
  let initialized = false;
  const rpc = async (method, params, signal) => {
    const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      signal, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) });
    const response = await res.json();
    if (!res.ok || response.error) throw new Error(response.error?.message || 'MCP HTTP ' + res.status);
    return response.result;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-comfyui-web-adapter', version: '0.5.1' } });
  await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  initialized = true;
  return { rpc, initialized, tools: (await rpc('tools/list')).tools };
}
