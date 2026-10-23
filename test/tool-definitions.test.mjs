import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOLS, nativeToolSchema } from '../lib/tool-definitions.js';

test('native schemas use host identity and attachment references instead of model-supplied sessions or encoded files', () => {
  for (const tool of MCP_TOOLS) {
    const schema = nativeToolSchema(tool);
    assert.equal(schema.properties.sessionId, undefined);
    for (const key of schema.required || []) assert.ok(key in schema.properties);
  }
  const upload = nativeToolSchema(MCP_TOOLS.find(tool => tool.name === 'upload_image'));
  assert.ok(upload.properties.attachmentId); assert.equal(upload.properties.dataBase64, undefined); assert.equal(upload.properties.mediaType, undefined);
  assert.ok(MCP_TOOLS.find(tool => tool.name === 'upload_image').inputSchema.properties.dataBase64);
});

test('graph schemas require fields per action and mutation hints reflect affected data', () => {
  const variants = MCP_TOOLS.find(tool => tool.name === 'edit_graph').inputSchema.properties.operations.items.oneOf;
  assert.deepEqual(variants.find(item => item.properties.op.const === 'connect').required,
    ['op', 'fromNodeId', 'fromSlot', 'toNodeId', 'toSlot']);
  assert.deepEqual(variants.find(item => item.properties.op.const === 'disconnect').required, ['op', 'nodeId', 'toSlot']);
  assert.ok(variants.every(item => item.additionalProperties === false));
  for (const name of ['interrupt', 'cancel_task', 'load_workflow', 'restore_edit', 'save_workflow', 'edit_graph'])
    assert.equal(MCP_TOOLS.find(tool => tool.name === name).annotations.destructiveHint, true);
  assert.equal(MCP_TOOLS.find(tool => tool.name === 'switch_workflow').annotations.idempotentHint, true);
  assert.equal(MCP_TOOLS.find(tool => tool.name === 'new_workflow').annotations.idempotentHint, false);
});

test('list_nodes no longer advertises a writability pre-judgement', () => {
  // R6-8: the removed `writable` field predicted success from the widget kind and was wrong in both
  // directions. The description must not resurrect that promise, and must point at the census instead.
  const listed = MCP_TOOLS.find(tool => tool.name === 'list_nodes');
  assert.doesNotMatch(listed.description, /writable 只说明|writable 是/);
  assert.match(listed.description, /audit\(op=writes\)/);
  assert.match(listed.description, /verified/, 'per-write proof is the only authority');
});
test('note_workflow advertises the delete path it actually serves', () => {
  const note = MCP_TOOLS.find(tool => tool.name === 'note_workflow');
  assert.ok(note.inputSchema.properties.forget, 'a note that cannot be deleted is a note nobody dares to write');
  assert.match(note.inputSchema.properties.forget.description, /删除/);
  assert.match(note.description, /forget:true/, 'the tool description has to mention the escape hatch');
  // note stays optional at the schema level: forget carries no line, and an empty string has to reach
  // lib/notes.js so the refusal can quote the lines that do exist instead of a generic schema error.
  assert.equal(note.inputSchema.required, undefined);
  assert.equal(note.inputSchema.properties.note.minLength, undefined);
});

test('the audit filter is documented for the ops that really consume it', () => {
  // R8-H: the schema said 「仅 params 用」 while lib/mcp.js:92-93 hands `args.filter` to auditWrites as
  // well — every per-node census of round 8 was done with audit(op=writes, filter=<id>), i.e. against
  // the documented contract. Pin the honest wording and the op that genuinely ignores it.
  const audit = MCP_TOOLS.find(tool => tool.name === 'audit');
  const filter = audit.inputSchema.properties.filter.description;
  assert.doesNotMatch(filter, /仅 params 用/, 'the old, wrong wording must not come back');
  assert.match(filter, /writes 与 params 都支持/);
  assert.match(filter, /graph 不支持/);
  assert.match(filter, /audit\(op=writes, filter=/, 'the census filter is a documented call shape');

  // The census reason codes are the tool face of lib/audit.js. All three empty-node codes must be
  // named: pending-build (declared but not built yet), no-controls-by-design (nothing to build) and
  // no-server-definition (front-end-only type). One missing code sends the reader to a fix that
  // cannot work — "wait a few seconds" for a node that will never grow a widget.
  for (const code of ['pending-build', 'no-controls-by-design', 'no-server-definition',
    'wired-input', 'properties-backed', 'shadowed-no-channel', 'dom-no-setter',
    'subgraph-proxy', 'quantized', 'no-panel-mirror', 'value-outside-options']) {
    assert.ok(audit.description.includes(code), 'audit description must document the reason code ' + code);
  }
  // The three empty-node codes are told apart by what the server definition says, so the description
  // has to say so; a flat "控件还没建出来" would read as a reason to wait for all three.
  assert.match(audit.description, /pending-build[^。]*延迟重建/);
  assert.match(audit.description, /no-controls-by-design[^。]*本来就没有/);
  assert.match(audit.description, /no-server-definition[^。]*object_info/);
});
