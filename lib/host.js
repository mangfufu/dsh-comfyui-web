import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client';
import { ComfyRuntime, readJson, json } from './runtime.js';
import { connectMcp } from './mcp.js';
import { runWithCompletionJob, resumeCompletionJob } from './completion-job.js';
import { createJobControllerLoader } from './job-controller.js';
import { installComfyExtension } from './extension-install.js';
import { referenceImages, uploadImage } from './reference.js';
import { nativeToolSchema } from './tool-definitions.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-comfyui-web';
export const inject = ['tools', 'webServer'];
export async function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const runtime = await new ComfyRuntime(join(home, 'comfyui', 'config.json')).start();
  const ensureController = createJobControllerLoader(ctx);
  runtime.completionNotificationsAvailable = !!ctx.get?.('jobs');
  const settings = () => ({ ...runtime.status(), token: runtime.token, protocol: 'MCP',
    mcp: { enabled: runtime.mcpEnabled, endpoint: runtime.frameOrigin + '/mcp',
      clientConfig: { mcpServers: { comfyui: { command: 'node', args: [fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url))],
        env: { DSH_HOME: home } } } } } });
  ctx.effect(() => () => runtime.stop());
  const config = JSON.parse(await readFile(runtime.configFile, 'utf8').catch(() => '{}'));
  const resume = agent => {
    const sessionId = agent.session.id, jobs = agent.ctx?.get?.('jobs') || ctx.get?.('jobs');
    if (!jobs) return;
    for (const record of runtime.generations.records.values()) {
      if (record.sessionId !== sessionId || record.notificationAttached || record.notificationDelivered || record.notificationDisabled) continue;
      try {
        const resumed = resumeCompletionJob(jobs, record, runtime.generations, () => ensureController(agent));
        resumed?.catch(() => { /* Retry a transient startup failure on the next call. */ });
      } catch { /* Agent's job controller may not yet be attached; retry on its next tool call. */ }
    }
  };
  if (ctx.on) ctx.on('agent/created', ({ agent }) => { resume(agent); });
  runtime.extensionInstallation = await installComfyExtension(config, runtime.frameOrigin);
  if (runtime.extensionInstallation.status !== 'installed') ctx.logger?.warn?.(runtime.extensionInstallation.message);
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-comfyui/api', handler: async (req, res) => {
      try {
        const origin = req.headers.origin;
        if (origin && origin !== 'http://' + req.headers.host) { json(res, 403, { error: 'Origin mismatch' }); return; }
        if (req.method === 'GET') { json(res, 200, settings()); return; }
        if (req.method !== 'POST' || origin !== 'http://' + req.headers.host || req.headers['x-dsh-comfy-token'] !== runtime.token) { json(res, 403, { error: 'Authentication failed' }); return; }
        const body = await readJson(req);
        if (body.op === 'connect') { await runtime.setUrl(body.url); json(res, 200, settings()); }
        else if (body.op === 'setMcpEnabled') { await runtime.setMcpEnabled(body.enabled); json(res, 200, settings()); }
        else if (body.op === 'check') { const stats = await runtime.request('/system_stats'); json(res, 200, { connected: true, system: stats.system }); }
        else if (body.op === 'command') { json(res, 200, await runtime.command(body.sessionId, body.action, body.args, undefined, body.clientId)); }
        else throw new Error('Unknown operation');
      } catch(e) { json(res, 400, { error: e.message }); }
    }
  }));
  const client = await connectMcp(runtime.frameOrigin + '/mcp', runtime.token);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-comfyui/events', handler: (req, res) => {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const sessionId = query.get('sessionId');
    if (req.method !== 'GET' || !sessionId || query.get('token') !== runtime.token || req.headers['sec-fetch-site'] === 'cross-site'
      || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) { json(res, 403, { error: 'Authentication failed' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const publish = () => { if (!res.destroyed) res.write('data: ' + JSON.stringify({ tasks: runtime.taskResults(sessionId) }) + '\n\n'); };
    runtime.taskListeners.add(publish); publish();
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20000);
    const close = () => { clearInterval(heartbeat); runtime.taskListeners.delete(publish); };
    res.on('close', close); ctx.effect(() => () => { close(); res.end(); });
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/dsh-comfyui/media',
    handler: (req, res) => runtime.media.handle(req, res).catch(error => {
      if (!res.headersSent) json(res, 502, { error: error.message }); else res.destroy(error);
    }) }));
  for (const tool of client.tools) {
    ctx.effect(() => ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'mcp__comfyui__' + tool.name, rawName: tool.name,
      description: tool.description + (!tool.annotations.readOnlyHint ? ' 面板连接不可用时停止操作，勿另写脚本绕过面板修改或提交。' : ''), inputSchema: nativeToolSchema(tool),
      async call(args, exec) {
        const sessionId = exec?.agent?.session?.id;
        if (!sessionId) throw new Error('ComfyUI MCP 未获得 dsh 当前对话身份，请重新加载插件；不要通过扫描硬盘寻找 sessionId。');
        resume(exec.agent);
        if (['list_reference_images', 'upload_image'].includes(tool.name) && !args.dataBase64) {
          if (!runtime.mcpEnabled) throw new Error('MCP 已关闭');
          const images = referenceImages(exec.agent.session);
          if (tool.name === 'list_reference_images') {
            const data = { images }; return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
          }
          const image = args.attachmentId ? images.find(image => image.attachmentId === args.attachmentId) : images[0];
          if (!image) throw new Error('当前对话没有该参考图，请先上传图片并用 list_reference_images 查看');
          const attachments = exec.agent.ctx?.get?.('attachments') || ctx.get?.('attachments');
          if (!attachments) throw new Error('dsh 未提供图片附件存储');
          const stored = await attachments.readImage(image, exec.signal);
          const data = await uploadImage(runtime, { ...args, sessionId, bytes: stored.data, mediaType: image.mediaType }, exec.signal);
          return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        }
        const invoke = signal => client.rpc('tools/call', { name: tool.name, arguments: args, _meta: { dshSessionId: sessionId } }, signal);
        if (tool.name === 'run') {
          const jobs = exec.agent.ctx?.get?.('jobs') || ctx.get?.('jobs');
          const result = await runWithCompletionJob(jobs, sessionId, invoke, runtime.generations, exec.signal,
            () => ensureController(exec.agent));
          if (!result.isError) runtime.completionNotificationStates.set(sessionId, result.structuredContent.completionNotification === true);
          return result;
        }
        return invoke(exec.signal);
      }
    })));
  }
  for (const agent of ctx.get?.('agents')?.list?.() || []) resume(agent);
}
