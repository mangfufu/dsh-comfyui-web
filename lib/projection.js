// Model-facing projection: keep whole-workflow JSON out of the conversation.
//
// A real H3 workflow on this machine is 96–171 KB. `get_workflow` used to hand the
// model the serialized graph AND the API prompt (~2x that, ~50k–85k tokens) just to
// answer "what is on the canvas", and `queue` / `history` passed ComfyUI's raw
// payloads, which embed a full graph per queued or recorded item.
//
// Small graphs stay byte-for-byte unchanged so nothing that already works has to be
// re-learned; only payloads above these thresholds get projected, and every projected
// reply says so and names the exact call that returns the full body.
export const FULL_GRAPH_BUDGET_BYTES = 24 * 1024;
export const FULL_QUEUE_BUDGET_BYTES = 8 * 1024;
export const FULL_HISTORY_BUDGET_BYTES = 16 * 1024;
export const FULL_NODES_BUDGET_BYTES = 12 * 1024;

const json = value => { try { return JSON.stringify(value); } catch { return ''; } };
export const byteLength = value => (json(value) || '').length;

const MODES = ['auto', 'full', 'summary'];
export function resolveMode(value, tool) {
  const mode = value === undefined || value === null ? 'auto' : String(value).toLowerCase();
  const allowed = tool === 'get_workflow' ? MODES : MODES.filter(m => m !== 'summary');
  if (!allowed.includes(mode)) {
    throw new Error(`${tool} 的 mode 只能是 ${allowed.join(' / ')}（当前：${value}）`);
  }
  return mode;
}

/** Envelope telling the model the reply was projected and how to opt back in. */
export function projectionNote({ tool, shape, bytes, budget, reason, fullArgs, hint }) {
  return {
    projected: true, shape, bytes, budgetBytes: budget,
    reason: `返回体 ${formatKb(bytes)} 超过 ${formatKb(budget)} 阈值，${reason}；已只回${shape}，没有把完整内容送进上下文。`,
    fullCall: { tool, args: fullArgs || { mode: 'full' } },
    hint: hint || '需要逐节点参数用 list_nodes（可用 filter 缩小范围）；确实要整份 JSON 才按 fullCall 再取一次，勿反复取。'
  };
}

export const formatKb = bytes => (bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1) + ' KB';

const DETAIL_MODES = ['auto', 'values', 'skeleton'];
export function resolveDetail(value) {
  const detail = value === undefined || value === null ? 'auto' : String(value).toLowerCase();
  if (!DETAIL_MODES.includes(detail)) throw new Error(`list_nodes 的 detail 只能是 ${DETAIL_MODES.join(' / ')}（当前：${value}）`);
  return detail;
}

/** Node inventory without values: identity, widget names and slot wiring only. */
export function skeletonNodes(nodes) {
  return (nodes || []).map(node => ({
    id: node.id, type: node.type,
    ...(node.title ? { title: node.title } : {}),
    ...(node.mode === undefined || node.mode === null ? {} : { mode: node.mode }),
    widgets: (node.widgets || []).map(widget => ({ name: widget.name, type: widget.type })),
    inputs: (node.inputs || []).map(input => ({ name: input.name, type: input.type, slot: input.slot, connected: input.link != null })),
    outputs: (node.outputs || []).map(output => ({ name: output.name, type: output.type, slot: output.slot, links: (output.links || []).length }))
  }));
}

/**
 * Structural skeleton of a serialized workflow: identity, wiring and widget NAMES.
 * Widget values, combo inventories and prompt text stay on the canvas.
 */
export function summarizeWorkflow(workflow, { promptNodes } = {}) {
  const nodes = (workflow?.nodes || []).map(node => ({
    id: String(node.id), type: node.type,
    ...(node.title ? { title: node.title } : {}),
    ...(node.mode ? { mode: node.mode } : {}),
    ...(node.widgets_values?.length ? { widgetCount: node.widgets_values.length } : {})
  }));
  const links = (workflow?.links || []).map(link => Array.isArray(link)
    ? { id: link[0], from: String(link[1]), fromSlot: link[2], to: String(link[3]), toSlot: link[4], type: link[5] }
    : link);
  return {
    nodeCount: nodes.length, linkCount: links.length,
    groupCount: (workflow?.groups || []).length,
    ...(promptNodes ? { promptNodeCount: promptNodes } : {}),
    nodes, links
  };
}

/** ComfyUI /queue: entry = [number, prompt_id, prompt graph, output nodes, extra].
 *  entry[2] is the whole graph — never send that to the model. */
export function digestQueue(queue) {
  const item = (entry, state) => ({
    ...(Number.isInteger(entry?.[0]) ? { number: entry[0] } : {}),
    promptId: entry?.[1], state,
    nodeCount: entry?.[2] && typeof entry[2] === 'object' ? Object.keys(entry[2]).length : 0,
    ...(Array.isArray(entry?.[3]) && entry[3].length ? { outputNodes: entry[3] } : {})
  });
  const running = (queue?.queue_running || []).map(entry => item(entry, 'running'));
  const pending = (queue?.queue_pending || []).map(entry => item(entry, 'pending'));
  return {
    counts: { running: running.length, pending: pending.length },
    running, pending,
    scope: '整个 ComfyUI 实例，包含其他来源的任务；本对话任务请用 list_tasks。'
  };
}

/** ComfyUI /history: one entry embeds the entire graph plus every output file. */
export function digestHistory(history) {
  const entries = Object.entries(history || {});
  return {
    count: entries.length,
    items: entries.map(([promptId, record]) => {
      const status = record?.status || {};
      const messages = Array.isArray(status.messages) ? status.messages : [];
      const errors = messages.filter(message => message?.[0] === 'execution_error').map(message => message[1]);
      const outputs = Object.entries(record?.outputs || {}).map(([nodeId, output]) => ({
        nodeId,
        ...(output?.images?.length ? { images: output.images.map(file => ({
          filename: file?.filename, subfolder: file?.subfolder || '', type: file?.type || 'output' })) } : {}),
        ...(output?.videos?.length ? { videos: output.videos.map(file => ({
          filename: file?.filename, subfolder: file?.subfolder || '', type: file?.type || 'output' })) } : {}),
        ...(Object.keys(output || {}).some(key => !['images', 'videos'].includes(key)) ? { otherKeys: Object.keys(output).filter(key => !['images', 'videos'].includes(key)) } : {})
      }));
      return {
        promptId,
        status: status.status_str ?? (record ? 'unknown' : 'unknown'),
        ...(status.completed != null ? { completed: status.completed } : {}),
        ...(Number.isFinite(status.timestamp) ? { timestamp: status.timestamp } : {}),
        nodeCount: Object.keys(record?.prompt?.[2] || {}).length,
        ...(record?.prompt?.[3]?.extra_pnginfo?.workflow?.extra?.ds?.workflow_id
          ? { workflowId: record.prompt[3].extra_pnginfo.workflow.extra.ds.workflow_id } : {}),
        outputs,
        ...(errors.length ? { errors: errors.slice(-2).map(error => ({
          nodeId: error?.node_id, nodeType: error?.node_type,
          message: String(error?.exception_message || '').slice(0, 400) })) } : {}),
        ...(messages.some(message => message?.[0] === 'execution_interrupted') ? { interrupted: true } : {})
      };
    })
  };
}

/** Keep a raw payload when it is already cheap; project only what would hurt. */
export function maybeProject(mode, payload, { budgetBytes, shape, build, tool, reason, fullArgs, hint }) {
  const bytes = byteLength(payload);
  if (mode === 'full' || (mode === 'auto' && bytes <= budgetBytes)) {
    return { projected: false, bytes, value: payload };
  }
  return { projected: true, bytes, value: build(payload),
    projection: projectionNote({ tool, shape, bytes, budget: budgetBytes, reason, fullArgs, hint }) };
}
