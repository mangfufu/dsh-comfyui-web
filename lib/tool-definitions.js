const text = description => ({ type: 'string', ...(description ? { description } : {}) });
const integer = (description, minimum = 0, maximum) => ({ type: 'integer', minimum, ...(maximum !== undefined ? { maximum } : {}), description });
const target = {
  clientId: text('可选面板 ID，取自 server_info；同一对话有多个面板时指定。'),
  sessionId: text('仅独立 MCP 客户端填写，取自 server_info；dsh 自动提供。')
};
const promptId = text('生成任务 ID，取自 run 的 prompt_id 或 history。');
const nodeId = text('节点 ID，取自 list_nodes；不要把节点名称当作 ID。');
const name = { ...text('工作流文件名，可省略 .json；不含目录或路径分隔符。'), minLength: 1, maxLength: 180 };
const spec = (name, title, description, properties = {}, required = [], options = {}) => ({
  name, title, description,
  inputSchema: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) },
  annotations: { readOnlyHint: !!options.readOnly, destructiveHint: !!options.destructive,
    idempotentHint: !!options.readOnly || !!options.idempotent, openWorldHint: false }
});
const read = { readOnly: true };
const position = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '画布坐标 [x, y]。' };
const projectionMode = (tool, shapes) => ({
  type: 'string', enum: tool === 'get_workflow' ? ['auto', 'full', 'summary'] : ['auto', 'full'],
  description: `${shapes}。默认 auto：内容在预算内原样返回，超过预算只回${tool === 'get_workflow' ? '结构摘要' : '摘要'}并说明如何取全量。`
    + '确需整份内容时显式传 mode="full"，别无脑重复取。'
});
const operation = (op, fields, required) => ({ type: 'object', additionalProperties: false,
  properties: { op: { type: 'string', const: op }, ...fields }, required: ['op', ...required] });

export const MCP_TOOLS = [
  spec('server_info', '连接状态', '检查 ComfyUI 服务、MCP 和当前对话面板。操作画布前确认面板 ready、allowAI；dsh 自动识别当前对话。', target, [], read),
  spec('list_workflows', '工作流列表', '列出已打开的标签页、已保存工作流及 activePath。后续切换或复制使用返回的 path。', target, [], read),
  spec('switch_workflow', '切换工作流', '切换到指定工作流；未打开的已保存工作流会打开。保留未保存修改，重复调用不会新增副本。',
    { ...target, path: text('list_workflows 返回的完整 path。') }, ['path'], { idempotent: true }),
  spec('new_workflow', '复制工作流', '复制当前或指定工作流到新标签页，保留源工作流。每次调用会新增一个副本；提交超时先查 list_workflows，勿直接重试。',
    { ...target, sourcePath: text('list_workflows 返回的 path；省略则复制当前工作流。'), name }),
  spec('save_workflow', '保存工作流', '保存当前工作流到 ComfyUI。省略 name 使用当前文件名；临时工作流可用 name 命名保存。另存副本用 save_as_workflow。',
    { ...target, name }, [], { destructive: true }),
  spec('save_as_workflow', '另存工作流', '把当前工作流另存并打开，保留源文件及其修改。遇到同名文件会拒绝覆盖，改用其他名称。',
    { ...target, name }, ['name']),
  spec('get_workflow', '读取当前图', '读取当前标签页的图内容（含手动修改）。默认 auto：图较大时只回结构摘要（节点身份、连线骨架、数量），不含参数值和整份 JSON。查参数用 list_nodes（有 filter），改参数用 update_nodes，改连线用 edit_graph；确实需要完整 workflow+prompt 时才传 mode="full"，要原样替换当前图用 load_workflow。',
    { ...target, mode: projectionMode('get_workflow', '摘要模式给节点与连线骨架。') }, [], read),
  spec('list_nodes', '节点与参数', '列出当前画布节点、具名参数、可选值和输入/输出插槽序号。修改前从此结果取得准确 nodeId、widget 和插槽。画布较大时默认只回骨架（id、类型、widget 名称、插槽连接），要参数值就带 filter 或传 detail="values"。',
    { ...target, filter: text('按节点类型或标题过滤，忽略大小写。取值时务必用它缩小范围。'),
      detail: { type: 'string', enum: ['auto', 'values', 'skeleton'],
        description: 'auto 默认：清单超过阈值只回骨架。values 强制带参数值（配合 filter），skeleton 强制只要骨架。' } }, [], read),
  spec('object_info', '节点类型定义', '查询节点类型及参数定义。指定 nodeType 返回详细定义；省略只列类型名称。新增节点前确认类型存在。',
    { nodeType: text('准确的节点类型名称，来自返回的类型列表或 list_nodes。') }, [], read),
  spec('update_nodes', '修改节点参数', '批量修改具名参数，实时显示，可撤销；不会生成。先 list_nodes，按参数的类型、范围和 choices 填值。',
    { ...target, changes: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', additionalProperties: false,
      properties: { nodeId, widget: text('list_nodes 返回的参数名称。'), value: { type: ['string', 'number', 'boolean', 'null'], description: '参数新值，类型需与节点定义匹配。' } },
      required: ['nodeId', 'widget', 'value'] } } }, ['changes']),
  spec('edit_graph', '编辑节点和连线', '按顺序增删节点、连接/断开输入或移动节点；整批失败恢复原图，可撤销，不会生成。create_node 的 ref 仅在本批后续操作中引用新节点。',
    { ...target, operations: { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: [
      operation('create_node', { nodeType: text('object_info 中的准确类型名称。'), ref: text('本批内唯一的新节点别名。'), title: text('可选显示标题。'), position }, ['nodeType']),
      operation('delete_node', { nodeId }, ['nodeId']),
      operation('move_node', { nodeId, position }, ['nodeId', 'position']),
      operation('connect', { fromNodeId: text('输出节点 ID 或本批创建的 ref。'), fromSlot: integer('输出插槽序号，取自 list_nodes。'),
        toNodeId: text('输入节点 ID 或本批创建的 ref。'), toSlot: integer('输入插槽序号，取自 list_nodes。') }, ['fromNodeId', 'fromSlot', 'toNodeId', 'toSlot']),
      operation('disconnect', { nodeId, toSlot: integer('要断开的输入插槽序号。') }, ['nodeId', 'toSlot'])
    ] } } }, ['operations'], { destructive: true }),
  spec('load_workflow', '替换当前图', '用完整普通工作流 JSON 替换当前标签页内容，可撤销。必须含 nodes/links，不能传 API prompt；要另开副本用 new_workflow。',
    { ...target, workflowJson: text('JSON 字符串，包含完整 nodes 和 links。修改前先 get_workflow(mode="full") 取整份图。') }, ['workflowJson'], { destructive: true }),
  spec('undo', '撤销修改', '撤销当前工作流最近一次 AI 修改，同一浏览器刷新后仍有效。检测到后续手动修改会拒绝覆盖，此时用 list_edits 选择恢复快照。', target),
  spec('redo', '重做修改', '重做当前工作流最近一次 AI 撤销。检测到后续手动修改会拒绝覆盖；新的 AI 修改会清空重做记录。', target),
  spec('list_edits', '修改快照', '列出当前工作流的修改前快照和 checkpointId。同一浏览器刷新后可恢复；最多保留 20 份，受存储空间限制。', target, [], read),
  spec('restore_edit', '恢复快照', '把当前工作流恢复到指定修改前快照，此次恢复也可撤销。会替换当前图内容，仅在用户明确要求恢复时使用。',
    { ...target, checkpointId: text('list_edits 返回的 checkpointId。') }, ['checkpointId'], { destructive: true }),
  spec('list_reference_images', '对话参考图', '列出当前 dsh 对话用户上传的图片，最新在前；返回 attachmentId。独立 MCP 客户端用 upload_image 提交图片数据。', target, [], read),
  spec('upload_image', '上传参考图', '上传参考图到 ComfyUI，可指定 nodeId 自动绑定图片参数；不会生成。dsh 用 attachmentId，省略则使用最近图片。返回 widgetValue；绑定失败时用它修正，勿重复上传。',
    { ...target, attachmentId: text('list_reference_images 返回的 attachmentId；dsh 省略则用最新参考图。'),
      dataBase64: text('仅独立 MCP 客户端提供原始图片的 base64，勿带 data: 前缀。'),
      mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], description: '独立 MCP 上传时必填；dsh 从附件读取。' },
      nodeId, widget: text('图片参数名称，取自 list_nodes；默认 image。') }),
  spec('run', '提交生成', '生成当前工作流一次，返回 prompt_id，结果自动显示并通知原对话。主动中断、取消或任务消失后停止本轮计划，须用户新的明确生成指令才可再次提交；后台通知不算用户指令，勿绕过插件提交。极简预设缺少后台控制器时自动在本会话启用。仅自动加载失败且 completionNotification=false 时不自动唤醒 AI，需要当场等结束可用 wait_for_completion。勿 sleep 或轮询；提交超时先查 list_tasks/queue/history，勿重复 run。', target),
  spec('list_tasks', '本对话任务', '列出本对话提交的任务、状态、进度和结果；插件重启后恢复跟踪。结果自动显示；需要 AI 看图时用 get_image。', target, [], read),
  spec('cancel_task', '取消排队任务', '只删除本对话尚未开始的指定任务。已经运行或完成则报告状态，不会中断生成；停止当前生成用 interrupt。',
    { ...target, promptId }, ['promptId'], { destructive: true }),
  spec('wait_for_completion', '等待生成结束', '通过实时事件等待本对话任务结束。等待超时或取消等待都不取消生成，也不能重复提交。dsh 有后台通知时通常无需调用。',
    { ...target, promptId, timeoutMs: integer('等待上限，默认 60000 毫秒；超时后可继续等待同一任务。', 1, 120000) }, ['promptId'], read),
  spec('queue', '实例队列', '读取整个 ComfyUI 实例的运行与等待队列，包含其他来源任务；默认只回每条任务的 promptId、节点数和输出节点，不回图结构。查看本对话任务优先用 list_tasks。',
    { mode: projectionMode('queue', '队列与历史默认只回摘要（状态、输出文件名、错误尾部）。') }, [], read),
  spec('history', '生成历史', '读取指定任务的生成记录和输出文件；省略 promptId 返回最近 5 项，可能包含其他来源任务。默认摘要含 nodeId，取图片用 get_image。',
    { promptId, mode: projectionMode('history', '队列与历史默认只回摘要（状态、输出文件名、错误尾部）。') }, [], read),
  spec('interrupt', '中断当前生成', '中断整个 ComfyUI 实例当前正在生成的任务，可能来自其他对话。仅在用户明确要求停止当前生成时使用；取消排队用 cancel_task。', target, [], { destructive: true }),
  spec('get_image', '查看生成图片', '读取生成图片供 AI 检查，并显示插件图片卡。新任务结果已自动显示，单纯展示无需重复调用。不要改用 read_image 或 Markdown 图片绕过模糊设置。',
    { promptId, nodeId: text('输出节点 ID，取自 history；省略则在去重后的图片输出中选择。同源的标准 PreviewImage 优先读取 SaveImage 保存版。'), index: integer('图片序号，从 0 开始，默认 0。') }, ['promptId'], read),
  spec('get_video', '播放历史视频', '显示已生成视频的插件播放卡，支持模糊和 VideoHelperSuite 输出；不把视频作为图片送给模型。新任务自动显示；历史视频用此工具，勿改用 Markdown 链接。',
    { ...target, promptId, nodeId: text('输出节点 ID，取自 history；省略则在全部视频输出中选择。'), index: integer('视频序号，从 0 开始，默认 0。') }, ['promptId'], read)
];

export const MCP_INSTRUCTIONS = [
  '操作用户可见的实时画布。先 server_info，节点参数查 list_nodes（用 filter 缩小范围），结构看 get_workflow；节点类型查 object_info。参数用 update_nodes，节点连线用 edit_graph。dsh 自动提供对话身份，不需查找 sessionId。',
  '上下文预算：get_workflow、list_nodes、queue、history 超过阈值时自动只回摘要或骨架并附 projection。定位节点用 list_nodes 的骨架，取参数值时带 filter 或 detail="values"，不要为「先看看整张图」而反复取全量；只有替换当前图等场景才传 mode="full"。',
  '工作流 path 来自 list_workflows。switch_workflow 切换，new_workflow 复制，load_workflow 替换当前图；保存用 save_workflow，另存用 save_as_workflow。写入前读取最新图。撤销遇到手动修改时，先查询 list_edits，由用户选择恢复。',
  '参考图先 list_reference_images，再 upload_image；指定 nodeId 可自动绑定。run 每次只提交一次，超时先查任务，勿重试生成。结果自动展示；completionNotification=true 时完成自动通知，false 时不自动唤醒 AI，需当场等待可用 wait_for_completion，勿 sleep/轮询。job_kill 只取消通知；cancel_task 删除等待任务，interrupt 中断实例当前生成。',
  'interrupted/cancelled 表示主动停止，不是节点故障；not_found 表示任务消失且原因未确认。遇到这些状态停止本轮生成计划，不诊断修复、不自动重试、不续跑下一段。后台完成通知不是新的用户指令；只有用户明确重新要求生成时才能 run，勿通过脚本/API 绕过。',
  'AI 检查图像用 get_image，历史视频展示用 get_video。勿用 read_image/Markdown 重复展示同一结果，以免绕过模糊设置。模糊只影响用户界面，AI 收到原图。',
  '面板连接不可用时停止本次写入，报告状态并等待恢复，不要另写脚本绕过面板修改或提交另一份工作流。'
].join('\n');

export function nativeToolSchema(tool) {
  const properties = { ...tool.inputSchema.properties };
  delete properties.sessionId;
  if (tool.name === 'upload_image') { delete properties.dataBase64; delete properties.mediaType; }
  return { ...tool.inputSchema, properties };
}
