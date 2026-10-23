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
  spec('doctor', '环境体检', '一次调用判定「现在能不能用」：返回 kind=ok|fail，逐项列出实际判据（MCP 开关、ComfyUI 是否可达、本条对话的桥接页面是否活着、页面心跳是否新鲜、页面里的 bridge.js 与插件版本是否一致、是否允许 AI 操作、画布写租约在谁手里、当前画布能否序列化、能否生成执行用的 prompt、有没有落盘输出节点、当前图是否有保存路径、队列是否空闲）。'
    + '「能序列化」与「能出 prompt」是两次不同的调用：子图代理节点丢了 definitions 时前者成功、后者抛错，run / get_workflow / audit(op=params) 都会跟着失败，所以 prompt-serializable 是独立的一条 check。失败时带 failedChecks 与 firstAction。开工前、报「坏了」之前先跑它，比逐字段读 server_info 便宜。',
    { ...target }, [], read),
  spec('note_workflow', '记录或删除踩过的坑', '把一个「下次别再踩」的事实记到本机（按节点类型或工作流），之后 list_nodes、update_nodes、doctor、audit 的回执会自动带上它——新对话不必重新摸索同一个坑。target 用 "node:<节点类型>"（如 node:AICG3DPromptSegmentSplit）或 "workflow:<list_workflows 的 path>"。note 写一句能直接照做的话（「dom 控件要写 node.properties 里的 shadow 文档」而不是「有坑」）。同一 target 去重、只留最近 5 条，是笔记不是日志。记错了要改：forget:true 带 note 删掉那一句原文，不带 note 清空该 target 的全部笔记（不存在的句子会被拒绝并回显现有笔记，不会静默删错）。',
    { ...target, target: text('记录对象："node:<节点类型>" 或 "workflow:<工作流 path>"；省略时按当前画布的工作流记录。'),
      // minLength 只在 note 真的出现时才有意义，而 forget 允许省略它；空字符串留给 forget 表达
      // 「这条不存在/这句是空的」，由 lib/notes.js 给出带现有笔记的拒绝文案，比 schema 的笼统报错更可照做。
      note: { ...text('一句话事实，能直接照做；删除时传要删的那一整句原文，或省略它表示清空该 target。'), maxLength: 400 },
      forget: { type: 'boolean', description: 'true 删除笔记而不是记录：带 note 删那一句，不带 note 清空这个 target 的全部笔记。' },
      list: { type: 'boolean', description: 'true 只列出已记录的笔记，不写新的。' } },
    // note 不在 required 里：forget 允许省略它。最后一个参数才是 options——一个工具同时承担记录、
    // 列出与永久删除，静态声明只能覆盖最重的那一档：forget 会连根删掉 usage-notes.json 里的条目，
    // MCP 客户端必须能在调用前就把它和「只写一条」区分开。
    [], { destructive: true }),
  spec('list_workflows', '工作流列表', '列出已打开的标签页、已保存工作流及 activePath。后续切换或复制使用返回的 path。', target, [], read),
  spec('switch_workflow', '切换工作流', '切换到指定工作流；未打开的已保存工作流会打开。保留未保存修改，重复调用不会新增副本。',
    { ...target, path: text('list_workflows 返回的完整 path。') }, ['path'], { idempotent: true }),
  spec('new_workflow', '复制工作流', '复制当前或指定工作流到新标签页，保留源工作流。每次调用会新增一个副本；提交超时先查 list_workflows，勿直接重试。',
    { ...target, sourcePath: text('list_workflows 返回的 path；省略则复制当前工作流。'), name }),
  spec('save_workflow', '保存工作流', '保存当前工作流到 ComfyUI。省略 name 使用当前文件名；临时工作流可用 name 命名保存。另存副本用 save_as_workflow。',
    { ...target, name }, [], { destructive: true }),
  spec('save_as_workflow', '另存工作流', '把当前工作流另存并打开，保留源文件及其修改。遇到同名文件会拒绝覆盖，改用其他名称。',
    { ...target, name }, ['name']),
  spec('get_workflow', '读取当前图', '读取当前标签页的图内容（含手动修改）。默认 auto：图较大时只回结构摘要（节点身份、连线骨架、数量），不含参数值和整份 JSON。查参数用 list_nodes（有 filter），改参数用 update_nodes，改连线用 edit_graph；确实需要完整 workflow+prompt 时才传 mode="full"，要原样替换当前图用 load_workflow。两种形态的节点路径不同：摘要/投影里节点在顶层 nodes、连线在顶层 links；mode="full" 的满载回包是 ComfyUI 原生信封 {workflow:{nodes,links}, prompt}，节点在 workflow.nodes，读顶层 nodes 会是 undefined。只要图不要 prompt 时传 includePrompt=false：部分节点包会改写 graphToPrompt（AICG3D 就会），读一次图付一次序列化副作用。',
    { ...target, includePrompt: { type: 'boolean', description: '默认 true，同时返回 API prompt。传 false 跳过 graphToPrompt（回包里 promptSkipped:true），只要 workflow。' }, mode: projectionMode('get_workflow', '摘要模式给节点与连线骨架。注意路径不同：摘要里节点在顶层 nodes，mode="full" 的满载回包里节点在 workflow.nodes（不是顶层 nodes）、连线在 workflow.links。') }, [], read),
  spec('list_nodes', '节点与参数', '列出当前画布节点、具名参数、可选值和输入/输出插槽序号。修改前从此结果取得准确 nodeId、widget 和插槽。kind 标出值不是真相来源的控件（dom=前端组件自持状态、hidden=被面板接管、shadowed=不参与序列化）。「这个控件到底能不能写」不再由这里猜（旧的 writable 字段只能从控件类型推，实测 risky 大多能写、ok 也会因量化落在别的值上，已删）——要那张地图用 audit(op=writes)，成败以每次写入回执的 verified 为准。数值控件另外给 step/round：round 是面板真正会四舍五入到的粒度，写 0.999 到 round=0.01 的控件会存成 1，回执用 quantized 说明。画布较大时默认只回骨架（id、类型、widget 名称、插槽连接），要参数值就带 filter 或传 detail="values"。',
    { ...target, filter: text('按节点类型、标题或节点 id 过滤，忽略大小写（三项都匹配：bridge.js 的 list_nodes 把 type/title/id 拼起来做子串匹配）。取值时务必用它缩小范围。'),
      detail: { type: 'string', enum: ['auto', 'values', 'skeleton'],
        description: 'auto 默认：清单超过阈值只回骨架。values 强制带参数值（配合 filter），skeleton 强制只要骨架。' } }, [], read),
  spec('object_info', '节点类型定义', '查询节点类型及参数定义。指定 nodeType 返回详细定义；省略只列类型名称。新增节点前确认类型存在。',
    { nodeType: text('准确的节点类型名称，来自返回的类型列表或 list_nodes。') }, [], read),
  spec('audit', '图与参数体检', '体检当前画布能不能跑、参数值权不权威、以及这台插件到底能写哪些控件，返回三态 verdict（supported 可继续 / refuted 必须先修 / unresolved 需要人确认）并附证据。op=graph 查必填输入悬空、静音或旁路节点、被前端文档接管的控件、有没有落盘输出、类型是否查无定义；op=params 用服务端权威枚举校验每个控件值（filter 可只看目标节点）；op=writes 是「动手前的可写性普查」——把每个控件归到能写 / 有条件能写 / 写不了三类，逐条给原因码（wired-input 被连线驱动、properties-backed 状态在 node.properties 且没有写入通道、shadowed-no-channel 不参与序列化、dom-no-setter 前端组件自持、subgraph-proxy 会留下陈旧的 definitions 副本、quantized 会按 step 取整、no-panel-mirror 面板不会重绘、value-outside-options 需要 force；「一个控件都没有」的节点分三种：pending-build 服务端声明了 widget 但此刻还没建出来（延迟重建，等几秒或切前台可能就有）、no-controls-by-design 服务端定义里本来就没有 widget 型输入（等多久都不会变）、no-server-definition object_info 里根本没有这个类型（Reroute / 注释这类前端内置节点））。第一次接触一个新工作流时先 op=writes 再改参数，比试错省得多；verdict 在 op=writes 里表示可写性而不是可运行性。改完参数或连线跑 op=graph/op=params，比反复截图看画布便宜得多。',
    { ...target, op: { type: 'string', enum: ['graph', 'params', 'writes'], description: 'graph 查图结构（默认），params 校验参数值域，writes 探测哪些控件能写、哪些不能（动手前先跑一次）。' },
      filter: text('writes 与 params 都支持，graph 不支持（op=graph 会忽略它）：按节点类型或标题过滤，忽略大小写；'
        + 'op=writes 的普查还按节点 id 匹配（如 filter="195"）。逐节点普查（audit(op=writes, filter=<节点 id 或类型>)）是本插件的常规用法。') }, [], read),
  spec('lease', '画布写租约', '查看或转移「谁可以写这张实时画布」。op=who 只读回租约状态；op=take 申请写权；op=release 交还。申请写权的对话必须连着 ComfyUI 面板：没有页面的会话（脚本、失效的 sessionId）不能占用写权，take 会被直接拒绝，先把面板打开或刷新。写类工具会自动续租；到期只看沉默——持有者空闲超时（5 分钟）后自动释放，面板一直开着也不延长。别的对话持有时不要自行 force 接管——画布是用户正在看的实时窗口，先报告冲突等用户指示。',
    { ...target, op: { type: 'string', enum: ['who', 'take', 'release'], description: '默认 who（只读查看）。' },
      force: { type: 'boolean', description: '仅在用户明确要求接管另一条对话的画布时使用。' } }),
  spec('update_nodes', '修改节点参数', '批量修改具名参数，实时显示，可撤销；不会生成。先 list_nodes，按参数的类型、范围和 choices 填值——choices 是画布上显示的原文（部分节点是中文标签），必须原样使用。写前两段式判定（two-phase）：先用 /object_info 的权威定义检查每一项（节点在不在、控件能不能写、类型、可选值、范围），整批有问题就返回 status="needs_input" + blocked[] 且画布一个字都不改——按 blocked[].nextSteps 修好整批重发，不要逐条试。写成功回 status="written"、written=true；每项带 via 与 verified：verified=false 表示该控件的状态由前端组件持有、写控件没生效，别重复硬写，按 unverified[].alternatives 换路（写 shadow 源 / 用该包自带写入入口 / 改磁盘 JSON 再 load_workflow）。例外：控件归属无法确认（多个前端组件同时声明同一个控件名）时**不返回回执**，整条请求在写入前被拒绝，错误与 hint 里写明是哪个控件。',
    { ...target, changes: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', additionalProperties: false,
      properties: { nodeId, widget: text('list_nodes 返回的参数名称。'), value: { type: ['string', 'number', 'boolean', 'null'], description: '参数新值，类型需与节点定义匹配；combo 用 list_nodes 回来的显示值原文。' } },
      required: ['nodeId', 'widget', 'value'] } },
      // R6-7 / R5-H. Both are opt-in and both report what they did, so no caller can mistake them for
      // the default path.
      force: { type: 'boolean', description: '默认 false。true 放宽「值域」判定（画布 options、服务端枚举、声明的 min/max），'
        + '用于磁盘合法但画布不再提供的值（实测 control_after_generate="default" 就是这样，没 force 只能整图回灌才写得回）。'
        + '类型不符仍然拒绝——那是请求写错，不是枚举不友好。命中的项标 changed[].outsideOptions/outOfRange + forceUsed，'
        + '并提醒画布接受不等于队列接受：run 前用 audit(op=params) 复核，要长期保留就改磁盘 JSON 后 load_workflow 整图替换。' },
      saveAfterWrite: { type: 'boolean', description: '默认 false。true 时写完（含 settle）自动 save_workflow，并回答「存的是哪一刻」：'
        + 'saved.path / savedStateHash / canvasHashAtSave / canvasMatchesSaved，稍后再取一次画布指纹给出 driftedAfterSave。'
        + '节点包在保存后又自己重填是常态（AICG3D 段落解析约 0.3 秒重写 prompt/秒数/种子），漂移会如实说漂移，不假称已同步落盘。' } }, ['changes']),
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
  spec('undo', '撤销修改', '撤销当前工作流最近一次 AI 修改，同一浏览器刷新后仍有效。检测到后续修改会拒绝覆盖，此时用 list_edits 选择恢复快照；拒绝的原因不一定是人——节点包也会自己改画布（本机实测 AICG3D 的段落解析在加载后约 0.3 秒重填 prompt/秒数/seed，且无视 auto_fill=false），撤销基准因此失效时如实按错误正文判断。', target),
  spec('redo', '重做修改', '重做当前工作流最近一次 AI 撤销。检测到后续手动修改会拒绝覆盖；新的 AI 修改会清空重做记录。', target),
  spec('list_edits', '修改快照', '列出当前工作流的修改前快照和 checkpointId。同一浏览器刷新后可恢复；最多保留 20 份，受存储空间限制。回包里的 serializable 是当前画布能否序列化（false 时 get_workflow / audit(op=params) / run 都会失败，通常要用 load_workflow 补回带 definitions 的完整图）；encoded=full|delta 说明该点是整图还是增量；legacyPatchesDropped 表示旧版增量编码写下的、无法安全恢复的快照已被剔除。', target, [], read),
  spec('restore_edit', '恢复快照', '把当前工作流恢复到指定修改前快照，此次恢复也可撤销。会替换当前图内容，仅在用户明确要求恢复时使用。',
    { ...target, checkpointId: text('list_edits 返回的 checkpointId。') }, ['checkpointId'], { destructive: true }),
  spec('list_reference_images', '对话参考图', '列出当前 dsh 对话用户上传的图片，最新在前；返回 attachmentId。独立 MCP 客户端用 upload_image 提交图片数据。', target, [], read),
  spec('upload_image', '上传参考图', '上传参考图到 ComfyUI，可指定 nodeId 自动绑定图片参数；不会生成。dsh 用 attachmentId，省略则使用最近图片。返回 widgetValue；绑定失败时用它修正，勿重复上传。',
    { ...target, attachmentId: text('list_reference_images 返回的 attachmentId；dsh 省略则用最新参考图。'),
      dataBase64: text('仅独立 MCP 客户端提供原始图片的 base64，勿带 data: 前缀。'),
      mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], description: '独立 MCP 上传时必填；dsh 从附件读取。' },
      nodeId, widget: text('图片参数名称，取自 list_nodes；默认 image。') }),
  spec('run', '提交生成', '生成当前工作流一次，返回 prompt_id，结果自动显示并通知原对话。主动中断或取消后停止本轮计划，须用户新的明确生成指令才可再次提交。not_found 仅表示该任务结果无法确认，勿自动重提该任务，不影响其他任务。后台通知不算用户指令，勿绕过插件提交。极简预设缺少后台控制器时自动在本会话启用。仅自动加载失败且 completionNotification=false 时不自动唤醒 AI，需要当场等结束可用 wait_for_completion。勿 sleep 或轮询；提交超时先查 list_tasks/queue/history，勿重复 run。', target),
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
  '操作用户可见的实时画布。先 doctor（一次调用判定环境是否可用，含「画布能不能生成执行用的 prompt」——能序列化不等于能出 prompt），第一次接触某个工作流再 audit(op=writes) 拿可写性普查（哪些控件能写、哪些写不了、各自原因码；普查是逐节点的，用 audit(op=writes, filter=<节点 id 或类型>) 缩到某个节点），然后 list_nodes（用 filter 缩小范围）取值，结构看 get_workflow；节点类型查 object_info。参数用 update_nodes，节点连线用 edit_graph。写不了的类别不要硬试：wired-input 去改连线另一端的节点，properties-backed / shadowed-no-channel / dom-no-setter 用该包自带写入口或改磁盘 JSON 后 load_workflow 整图替换。dsh 自动提供对话身份，不需查找 sessionId。',
  '踩过的坑写进 note_workflow（按 node:<类型> 或 workflow:<path>）：之后 list_nodes、update_nodes、audit、doctor 的回执会自动带上它，新对话不必重新摸索同一条路。记错了就用 note_workflow 的 forget:true 删（带 note 删那一句，不带 note 清空该 target）：不要留一条错的笔记在前面挡路，也不要去手改 usage-notes.json。',
  '画布写权用 lease 协调：写类工具自动续租；被别的对话持有时写入会被拒绝，此时报告冲突、等用户指示，不要自行 force 接管用户正在看的实时画布。',
  '改完参数或连线先 audit 再 run：audit(op=graph) 查必填输入是否悬空、有没有被静音/旁路、产物会不会落盘；audit(op=params) 用服务端权威枚举校验值——部分 pack 的画布值是中文显示值，与权威值不同，体检会点出来；它同时回答「这张图能不能转成执行用的 prompt」（prompt-serializable），这条 refuted 时 run 一定发不出去。filter 对 writes 与 params 都有效，graph 不认。verdict=refuted 时先修再提交，别用截图猜。',
  '上下文预算：get_workflow、list_nodes、queue、history 超过阈值时自动只回摘要或骨架并附 projection。定位节点用 list_nodes 的骨架，取参数值时带 filter 或 detail="values"，不要为「先看看整张图」而反复取全量；只有替换当前图等场景才传 mode="full"。',
  '写入是否生效只看回执的 verified：kind 为 dom / hidden / shadowed 的控件由前端组件自持状态，动它们之前先用 audit(op=writes) 拿可写性地图（哪些能写、哪些写不了、为什么）。回读只差一个步长不是失败：quantized 给 requested/applied/step，verified 仍是 true，别为了「原值」重发。hidden/shadowed 写完后 panels 说明用户眼前的面板有没有跟着重绘（refreshed / noVisiblePanel / refreshFailed：noVisiblePanel 只是面板没展开，队列已用新值；refreshFailed 才需要用户重开面板）；propertiesStale 表示节点包里另存了一份同样的值（不是队列来源，我们不代写），别把它当成写入失败；dirtyMarked 说明标签页是否已标「未保存」，false 就 save_workflow，别让用户切标签或关页面。verified=false 的回执带 hint 说明下一步（写 shadow 源 / 用该包自带写入口 / 改用 load_workflow 整图替换），不要连续硬写同一处。回执里 requestedWidget 与 widget 不同或 rerouted=true 时，真正被写的是另一个控件；sameNameWidgets/ambiguousTargets 表示该节点上有多个同名控件（写的是第一个，面板显示的是不是它无法判断）；shadowDocsRemaining 表示节点上还留着归属不明的引用文档，本次没删——用 audit(op=params) 或跑一次确认提交值，别靠改控件名去猜它。控件归属无法确认（多个组件同时声明同一个控件名）时没有回执，整条请求会在写入前被拒绝：错误里的控件名就是要换掉的目标。',
  '工作流 path 来自 list_workflows。switch_workflow 切换，new_workflow 复制，load_workflow 替换当前图（它只换内容、不换标签页指向的文件：回执给 pathUnchanged/contentReplaced，之后普通 save_workflow 会写进那个旧 path 并回 saveReplacedContent——要保住原文件就改用 save_as_workflow）；保存用 save_workflow，另存用 save_as_workflow。保存回执里 saveStatePreserved 说明值是从标签页记得的内容救回来的、uneditableNodes 说明这些值在文件里有但画布上此刻没有控件可改（切标签或页面在后台时常见），deferredFrame:"stalled" 说明页面在后台。写入前读取最新图。撤销遇到手动修改时，先查询 list_edits，由用户选择恢复。注意两个「改过」信号不是一回事：list_workflows 的 modified 会被前端自己注入的字段点亮（rgthree 的 ue_properties / widget_ue_connectable 一族，刚 load 完没动过也会 true），回执里的 dirtyMarked 才是「这次工具写入有没有改动内容」的判据；两边都不代表已落盘，要留档就 save。',
  '参考图先 list_reference_images，再 upload_image；指定 nodeId 可自动绑定。run 每次只提交一次，超时先查任务，勿重试生成。结果自动展示；completionNotification=true 时完成自动通知，false 时不自动唤醒 AI，需当场等待可用 wait_for_completion，勿 sleep/轮询。job_kill 只取消通知；cancel_task 删除等待任务，interrupt 中断实例当前生成。',
  'interrupted/cancelled 表示主动停止，不是节点故障：停止本轮计划，不诊断修复、不重试、不续跑下一段，等待用户新的明确生成指令。not_found 仅表示当前实例没有此任务的队列或历史记录，结果无法确认；不能认定为用户中断或节点故障，不自动重提该任务，也不要因此停止其他任务。后台通知不是用户指令，勿通过脚本/API 绕过。',
  'AI 检查图像用 get_image，历史视频展示用 get_video。勿用 read_image/Markdown 重复展示同一结果，以免绕过模糊设置。模糊只影响用户界面，AI 收到原图。',
  '面板连接不可用时停止本次写入，报告状态并等待恢复，不要另写脚本绕过面板修改或提交另一份工作流。'
].join('\n');

export function nativeToolSchema(tool) {
  const properties = { ...tool.inputSchema.properties };
  delete properties.sessionId;
  if (tool.name === 'upload_image') { delete properties.dataBase64; delete properties.mediaType; }
  return { ...tool.inputSchema, properties };
}
