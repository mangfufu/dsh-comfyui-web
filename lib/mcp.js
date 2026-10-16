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

const asResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
export async function callComfyTool(runtime, name, args = {}, meta = {}, signal) {
  if (!MCP_TOOLS.some(t => t.name === name)) throw new Error('Unknown MCP tool: ' + name);
  const sessionId = meta.dshSessionId || args.sessionId;
  if (name === 'server_info') {
    let connected = true, stats, error;
    try { stats = await runtime.request('/system_stats', {}, signal); } catch(e) { connected = false; error = e.message; }
    return asResult({ ...runtime.status(sessionId), connected, ...(stats ? { stats } : { error }), protocol: 'MCP', realtimePreview: true, realtimeCompletion: true });
  }
  if (!runtime.mcpEnabled) throw new Error('MCP 已关闭，请在 ComfyUI 面板的“MCP 设置”中开启。');
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
  if (name === 'list_nodes') {
    const detail = resolveDetail(args.detail);
    const result = await runtime.command(sessionId, name, { filter: args.filter }, signal, args.clientId);
    if (detail === 'values') return asResult(result);
    const outcome = maybeProject(detail === 'skeleton' ? 'summary' : 'auto', result, {
      budgetBytes: FULL_NODES_BUDGET_BYTES, shape: '节点骨架', tool: 'list_nodes',
      build: payload => ({ nodeCount: (payload.nodes || []).length, nodes: skeletonNodes(payload.nodes) }),
      reason: '整张画布的节点清单带着全部参数值',
      fullArgs: { detail: 'values', ...(args.filter ? { filter: args.filter } : {}) },
      hint: '骨架足够定位 nodeId、widget 名称和插槽序号；要取值先用 filter 缩到目标节点或类型，再按 fullCall 取 detail="values"，勿整张画布反复取。'
    });
    return asResult(outcome.projection ? { ...outcome.value, projection: outcome.projection } : outcome.value);
  }
  const payload = name === 'update_nodes' ? { changes: args.changes }
    : name === 'load_workflow' ? { workflow: JSON.parse(args.workflowJson) }
    : name === 'switch_workflow' ? { path: args.path }
    : name === 'new_workflow' ? { sourcePath: args.sourcePath, name: args.name }
    : name === 'get_workflow' ? { mode: resolveMode(args.mode, 'get_workflow') }
    : { filter: args.filter };
  if (['save_workflow', 'save_as_workflow', 'edit_graph', 'restore_edit'].includes(name)) {
    return asResult(await runtime.command(sessionId, name, { name: args.name, operations: args.operations, checkpointId: args.checkpointId }, signal, args.clientId));
  }
  const result = await runtime.command(sessionId, name, payload, signal, args.clientId);
  if (name === 'get_workflow') return asResult(backstopWorkflowProjection(args, result));
  return asResult(result);
}

/**
 * Panels still running an older bridge.js ignore `mode` and hand back the whole graph.
 * Project it here so the context budget holds no matter which bridge build is loaded;
 * the page-side projection stays because it also saves the wire bytes.
 */
export function backstopWorkflowProjection(args, result) {
  const mode = resolveMode(args.mode, 'get_workflow');
  if (mode === 'full' || !result || result.projection || !result.workflow) return result;
  const outcome = maybeProject('auto', result, {
    budgetBytes: FULL_GRAPH_BUDGET_BYTES, shape: '结构摘要', tool: 'get_workflow',
    build: payload => summarizeWorkflow(payload.workflow, { promptNodes: Object.keys(payload.prompt || {}).length }),
    reason: '面板返回了完整工作流'
  });
  if (!outcome.projected) return result;
  return { ...outcome.value, projection: outcome.projection,
    fallbackNote: '本页桥接代码较旧，插件侧已代为投影；刷新 ComfyUI 页面可在源头省掉这次传输。' };
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
          catch(e) { result = { isError: true, content: [{ type: 'text', text: e.message }] }; }
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
