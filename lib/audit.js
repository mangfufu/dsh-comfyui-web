// Judgment family: turn "the canvas looks fine" into a verdict the model can act on.
//
// Everything here is pure: the page supplies facts (bridge.js `audit_graph`), the plugin
// supplies the authoritative node definitions (`/object_info/<type>`), and this module
// answers "can this graph run, and are its values actually valid?" with three states —
// supported / refuted / unresolved — plus the evidence behind each.
//
// The param check exists because of a real failure: some packs replace a combo's
// `options.values` with localized display strings and convert them back at queue time, so
// the value on the canvas is NOT one of the server's authoritative options. That is legal
// until the front-end stops converting — the model needs to be told, not to guess.

const WIDGET_KINDS = new Set(['int', 'float', 'string', 'boolean', 'combo']);
const OUTPUT_HINTS = /saveimage|savevideo|saveanimated|saveaudio|videocombine|save_?file|apisave/i;
const PREVIEW_HINTS = /previewimage|previewaudio|videopreview/i;

/** Normalize an /object_info class definition into { name: {kind, options, min, max, type} }.
 *  Inputs live under `def.input`, not at the top level: reading the wrong layer leaves the
 *  map empty, and an empty map makes every value check pass without looking at anything. */
export function defInputs(def) {
  const inputs = {};
  for (const group of ['required', 'optional']) {
    for (const [name, spec] of Object.entries(def?.input?.[group] || {})) {
      const tuple = Array.isArray(spec) ? spec : [spec];
      const first = tuple[0];
      const rest = (tuple[1] && typeof tuple[1] === 'object' && !Array.isArray(tuple[1])) ? tuple[1] : {};
      // Option lists arrive three ways: as the first element (classic combo), as `options`
      // (io.Combo, and V3 dynamic combos whose entries are { key, inputs }), or as `values`.
      // An empty list still means a widget — the server just fills it at run time — so it
      // must not be read as "no accepted values", which would flag every value on the canvas.
      const lists = [first, rest.options, rest.values].filter(Array.isArray);
      const isCombo = lists.length > 0;
      const entries = lists.flat();
      const options = isCombo && entries.length
        ? entries.map(entry => (entry && typeof entry === 'object' ? entry.key : entry)) : null;
      const label = isCombo ? 'COMBO' : typeof first === 'string' ? first : '';
      inputs[name] = {
        group,
        kind: isCombo ? 'combo'
          : (WIDGET_KINDS.has(String(label).toLowerCase()) ? String(label).toLowerCase() : 'connect'),
        ...(options ? { options } : {}),
        ...(typeof rest.min === 'number' ? { min: rest.min } : {}),
        ...(typeof rest.max === 'number' ? { max: rest.max } : {}),
        ...(rest.multiline !== undefined ? { multiline: rest.multiline } : {}),
        ...(!isCombo && label ? { type: label } : {}),
        hidden: rest.hidden === true
      };
    }
  }
  return inputs;
}

const check = (id, verdict, title, evidence = [], hint) => ({ id, verdict, title, count: evidence.length, evidence: evidence.slice(0, 25), ...(hint ? { hint } : {}) });
const overall = checks => checks.some(c => c.verdict === 'refuted') ? 'refuted'
  : checks.some(c => c.verdict === 'unresolved') ? 'unresolved' : 'supported';
// A node with nothing wired in AND nothing wired out cannot take part in the run at all,
// so a missing definition for it (Markdown notes, labels, isolated leftovers) is
// information rather than an open question. Requiring both sides keeps a saver from an
// unloaded pack — which does have inputs — from being silently excused.
const isolated = node => !(node.outputs || []).some(output => (output.links || []).length)
  && !(node.inputs || []).some(input => input.link != null);

/** Required connectable inputs with nothing wired into them. */
function danglingInputs(nodes, defs) {
  const found = [];
  for (const node of nodes) {
    if (node.mode === 2 || node.mode === 4) continue;                     // muted / bypassed on purpose
    const def = defs[node.type];
    if (!def) continue;
    const inputs = defInputs(def);
    for (const slot of node.inputs || []) {
      const spec = inputs[slot.name];
      if (!spec || spec.group !== 'required' || spec.kind !== 'connect' || slot.link != null) continue;
      found.push({ nodeId: node.id, type: node.type, title: node.title, input: slot.name, needs: spec.type });
    }
  }
  return found;
}

/** Widgets whose current value the server's own definition would reject. */
export function paramViolations(nodes, defs) {
  const bad = [], unknown = [], ignored = new Set();
  for (const node of nodes) {
    const def = defs[node.type];
    if (!def) {
      if (isolated(node)) ignored.add(node.type);
      else unknown.push({ nodeId: node.id, type: node.type, title: node.title, reason: 'object_info 里没有该类型' });
      continue;
    }
    const inputs = defInputs(def);
    for (const widget of node.widgets || []) {
      const spec = inputs[widget.name];
      if (!spec || spec.kind === 'connect') continue;
      const value = widget.value;
      if (value === null || value === undefined) continue;
      if (spec.options && !spec.options.includes(value)) {
        bad.push({ nodeId: node.id, type: node.type, title: node.title, widget: widget.name, value,
          accepted: spec.options.slice(0, 20), widgetKind: widget.kind,
          likely: '画布显示值与服务端权威值不一致（前端本地化枚举在提交时转换）。现在能跑，但任何绕过前端转换的提交都会失败。' });
      } else if (typeof value === 'number' && ((spec.min != null && value < spec.min) || (spec.max != null && value > spec.max))) {
        bad.push({ nodeId: node.id, type: node.type, title: node.title, widget: widget.name, value,
          accepted: [spec.min ?? null, spec.max ?? null], widgetKind: widget.kind, likely: '超出服务端允许范围' });
      }
    }
  }
  return { bad, unknown, ignoredTypes: [...ignored] };
}

export function auditGraph({ page, defs }) {
  const nodes = page?.nodes || [];
  const dangling = danglingInputs(nodes, defs);
  const bypassed = nodes.filter(node => node.mode === 2 || node.mode === 4)
    .map(node => ({ nodeId: node.id, type: node.type, title: node.title, mode: node.mode, meaning: node.mode === 2 ? 'muted' : 'bypass' }));
  const shadowed = nodes.filter(node => (node.shadowDocs || []).length)
    .map(node => ({ nodeId: node.id, type: node.type, title: node.title, shadowDocs: node.shadowDocs,
      hiddenPrompt: (node.widgets || []).some(widget => widget.kind === 'hidden' || widget.kind === 'shadowed') }));
  const hasSaver = nodes.some(node => OUTPUT_HINTS.test(node.type) && node.mode !== 2);
  const hasPreview = nodes.some(node => PREVIEW_HINTS.test(node.type) && node.mode !== 2);
  const missingDefs = [...new Set(nodes.filter(node => !defs[node.type] && !isolated(node)).map(node => node.type))];
  const ignoredIsolated = [...new Set(nodes.filter(node => !defs[node.type] && isolated(node)).map(node => node.type))];

  const checks = [
    check('dangling-required-input', dangling.length ? 'refuted' : 'supported', '必填输入是否全部接上', dangling,
      dangling.length ? '这些输入是连接型且必填，当前没有连线；提交会被 ComfyUI 直接拒绝。用 edit_graph 的 connect 接上。' : undefined),
    check('bypassed-nodes', bypassed.length ? 'unresolved' : 'supported', '是否有被静音/旁路的节点', bypassed,
      bypassed.length ? '静音/旁路可能是故意的；确认这些节点不参与本次生成再提交。' : undefined),
    check('shadowed-widgets', shadowed.length ? 'unresolved' : 'supported', '是否有控件的值被前端文档接管', shadowed,
      shadowed.length ? '这些节点上存在带 parts 的引用文档：直接写 prompt 控件可能不生效，写入后请看回执的 verified 字段。' : undefined),
    check('saver-present', hasSaver ? 'supported' : (hasPreview ? 'unresolved' : 'refuted'), '产物是否会落盘',
      hasSaver ? [] : [{ note: hasPreview ? '只有预览节点，结果不落盘' : '既没有保存节点也没有预览节点' }],
      hasSaver ? undefined : '要留档就接一个 SaveImage/SaveVideo；只有预览时 get_image 拿不到文件。'),
    check('definitions-known', missingDefs.length ? 'unresolved' : 'supported', '节点类型是否都能查到权威定义',
      missingDefs.map(type => ({ type })),
      missingDefs.length ? '这些类型在 /object_info 里查不到：要么 pack 没加载或被禁用，要么是纯前端定义的节点'
        + '（注释类、Use Everywhere 的 SetNode/GetNode），后者的参数本来就不由服务端校验，写入仍可按控件名进行。' : undefined)
  ];
  return { verdict: overall(checks), nodeCount: nodes.length, linkCount: page?.linkCount ?? null,
    ...(ignoredIsolated.length ? { ignoredIsolatedTypes: { types: ignoredIsolated,
      note: '这些类型没有服务端定义，但输入输出都没接线（注释、标签类），不参与本次运行，故不计入未决项。' } } : {}),
    checks };
}

export function auditParams({ page, defs, filter }) {
  let nodes = page?.nodes || [];
  if (filter) {
    const needle = String(filter).toLowerCase();
    nodes = nodes.filter(node => (node.type + ' ' + (node.title || '')).toLowerCase().includes(needle));
  }
  const { bad, unknown, ignoredTypes } = paramViolations(nodes, defs);
  const checks = [
    check('param-values', bad.length ? 'refuted' : 'supported', '控件值是否都在服务端权威域内', bad,
      bad.length ? '逐条给出 nodeId/widget/当前值/权威可选项。要改成权威值前先确认该 pack 是否依赖前端转换。' : undefined),
    check('uncheckable', unknown.length ? 'unresolved' : 'supported', '无法校验的节点', unknown)
  ];
  return { verdict: overall(checks), checkedNodes: nodes.length,
    ...(ignoredTypes.length ? { ignoredUncheckable: { types: ignoredTypes, note: '这些类型没有服务端定义，但输出未被任何节点使用（注释/标签类），不影响本次运行。' } } : {}),
    checks };
}

/** Compact model-facing envelope: verdict first, evidence after, never the whole graph. */
export function auditReply(body) {
  const text = JSON.stringify(body);
  return { content: [{ type: 'text', text }], structuredContent: body };
}
