import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { createMcpHandler } from './mcp.js';
import { WorkflowSync } from './sync.js';
import { GenerationMonitor } from './generation.js';
import { VideoMedia } from './media.js';
import { TaskStore } from './state.js';

export const BRIDGE_PROTOCOL = 5;
const liveClient = client => !!(client.stream && !client.stream.destroyed && !client.stream.writableEnded) || Date.now() - client.seen < 10000;

export function normalizeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请填写 ComfyUI 的 http/https 根地址，例如 http://127.0.0.1:8188');
  }
  return url.origin;
}
export async function readJson(req, max = 12 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('请求超过 12 MB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersOf(headers) { return Object.fromEntries(Object.entries(headers).filter(([k]) => !hop.has(k.toLowerCase()))); }

export class ComfyRuntime {
  constructor(configFile, options = {}) {
    this.configFile = configFile; this.url = options.url || 'http://127.0.0.1:8188';
    this.preferredPort = options.port ?? 18188;
    this.token = randomUUID(); this.clients = new Map(); this.pending = new Map(); this.sockets = new Set();
    this.sync = new WorkflowSync();
    this.generations = new GenerationMonitor(this);
    this.mcpEnabled = true;
    this.taskListeners = new Set();
    this.completionNotificationStates = new Map();
    this.extensionInstallation = null;
    this.mcpHandler = createMcpHandler(this, readJson, json);
  }
  async start() {
    try { const config = JSON.parse(await readFile(this.configFile, 'utf8')); this.url = normalizeUrl(config.url || this.url); this.mcpEnabled = config.mcpEnabled !== false; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.bridgeCode = await readFile(new URL('../bridge.js', import.meta.url), 'utf8');
    this.bridgeVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    this.media = await new VideoMedia(this).start(joinPath(dirname(this.configFile), 'media-key'));
    this.taskStore = await new TaskStore(joinPath(dirname(this.configFile), 'tasks.json')).start();
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => { if (!res.headersSent) json(res, 502, { error: e.message }); else res.destroy(e); }));
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    const listen = port => new Promise((resolve, reject) => {
      const fail = e => { this.server.off('listening', ready); reject(e); };
      const ready = () => { this.server.off('error', fail); resolve(); };
      this.server.once('error', fail).once('listening', ready).listen(port, '127.0.0.1');
    });
    try { await listen(this.preferredPort); } catch(e) { if(e.code !== 'EADDRINUSE') throw e; await listen(0); }
    this.frameOrigin = `http://127.0.0.1:${this.server.address().port}`;
    await mkdir(dirname(this.configFile), { recursive: true });
    await writeFile(joinPath(dirname(this.configFile), 'connection.json'), JSON.stringify({ endpoint: this.frameOrigin + '/mcp', token: this.token }) + '\n', { mode: 0o600 });
    await this.generations.restore(this.taskStore);
    return this;
  }
  async stop() {
    await this.generations.stop();
    for (const p of this.pending.values()) p.reject(new Error('ComfyUI 插件已关闭'));
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
  }
  async setUrl(value) {
    const next = normalizeUrl(value);
    if (new URL(next).origin === this.frameOrigin) throw new Error('不能连接插件自身的代理端口');
    await mkdir(dirname(this.configFile), { recursive: true });
    const previous = JSON.parse(await readFile(this.configFile, 'utf8').catch(() => '{}'));
    await writeFile(this.configFile, JSON.stringify({ ...previous, url: next }, null, 2) + '\n', { mode: 0o600 });
    await this.generations.stop();
    this.url = next;
    this.generations = new GenerationMonitor(this);
    await this.generations.restore(this.taskStore);
    this.sync = new WorkflowSync();
    for (const p of this.pending.values()) p.reject(new Error('ComfyUI 地址已更改，请重新打开面板'));
    this.clients.clear();
  }
  async setMcpEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('MCP 开关必须是布尔值');
    const previous = JSON.parse(await readFile(this.configFile, 'utf8').catch(() => '{}'));
    await writeFile(this.configFile, JSON.stringify({ ...previous, url: this.url, mcpEnabled: enabled }, null, 2) + '\n', { mode: 0o600 });
    this.mcpEnabled = enabled;
    if (!enabled) for (const [id, pending] of [...this.pending]) {
      if (this.clients.get(pending.clientId)?.queue.some(command => command.id === id)) pending.reject(new Error('MCP 已关闭'));
    }
  }
  status(sessionId) {
    const recent = [...this.clients.values()].filter(c => liveClient(c) || Date.now() - c.seen < 60000);
    return { url: this.url, frameOrigin: this.frameOrigin, mcpEnabled: this.mcpEnabled,
      bridgeVersion: this.bridgeVersion, bridgeProtocol: BRIDGE_PROTOCOL,
      extensionInstallation: this.extensionInstallation,
      generationMonitor: this.generations.status(),
      completionNotificationsAvailable: sessionId && this.completionNotificationStates.has(sessionId)
        ? this.completionNotificationStates.get(sessionId) : this.completionNotificationsAvailable === true,
      syncClients: recent.filter(c => !sessionId || c.sessionId === sessionId).map(c => ({
        clientId: c.id, external: c.sessionId === 'comfyui-external', bridgeVersion: c.bridgeVersion || 'legacy',
        refreshRequired: c.bridgeProtocol !== BRIDGE_PROTOCOL, ready: c.ready,
        visible: c.visible, connected: !!liveClient(c), heartbeatAgeMs: Date.now() - c.seen,
        workflowTabs: c.workflowTabs ?? null, hasActiveWorkflow: c.hasActiveWorkflow ?? null
      })), clients: [...this.clients.values()]
      .filter(c => c.sessionId !== 'comfyui-external' && (!sessionId || c.sessionId === sessionId) && (liveClient(c) || Date.now() - c.seen < 60000))
      .map(c => ({ clientId: c.id, sessionId: c.sessionId, ready: c.ready, allowAI: this.mcpEnabled && c.allowAI,
        connected: !!liveClient(c), heartbeatAgeMs: Date.now() - c.seen, visible: c.visible })) };
  }
  tasksChanged() { for (const listener of this.taskListeners) { try { listener(); } catch { /* Isolate a closed event stream. */ } } }
  taskResults(sessionId) {
    return [...this.generations.records.values()].filter(record => record.sessionId === sessionId).map(record => ({
      promptId: record.promptId, status: record.status, created: record.created, progress: record.progress,
      result: record.result, media: record.result?.status === 'completed' ?
        [...record.result.images || [], ...record.result.videos || []].flatMap(file => {
          try { return [this.media.describe(file, record.promptId, sessionId)]; } catch { return []; }
        }) : []
    }));
  }
  async request(path, init = {}, signal) {
    const timeout = AbortSignal.timeout(20000);
    const res = await fetch(this.url + path, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`ComfyUI ${res.status}: ${JSON.stringify(data).slice(0, 1500)}`);
    return data;
  }
  command(sessionId, action, args = {}, signal, clientId) {
    if (!this.mcpEnabled) throw new Error('MCP 已关闭，请在面板的“MCP 设置”中开启。');
    const own = [...this.clients.values()].filter(c => c.sessionId === sessionId);
    const candidates = own.filter(c => c.ready && c.allowAI && liveClient(c));
    const client = clientId ? candidates.find(c => c.id === clientId) : candidates.filter(c => c.visible).at(-1) || (candidates.length === 1 ? candidates[0] : undefined);
    if (!client) {
      if (!own.length) throw new Error('本条对话尚未收到 ComfyUI 桥接扩展连接。请确认面板已打开，并检查扩展安装（MCP 设置中的安装说明）。'
        + (this.extensionInstallation?.message ? ' ' + this.extensionInstallation.message : '')
        + ' 不要改用脚本绕过面板提交生成。');
      if (!own.some(liveClient)) throw new Error('本条对话的 ComfyUI 连接已断开，等待自动重连或刷新面板；这不表示 MCP 开关关闭。请勿绕过面板写入或重复提交。');
      if (own.every(c => !c.allowAI)) throw new Error('本条对话面板尚未允许 AI 操作，请查看 MCP 设置。');
      if (own.every(c => !c.ready)) throw new Error('ComfyUI 工作流正在加载或同步代码需要刷新，请稍后重试读取状态。');
      throw new Error('面板身份未匹配或有多个面板，请从 server_info 选择本条对话的有效 clientId。');
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const id = randomUUID(); let timer;
      const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); client.queue = client.queue.filter(c => c.id !== id); fn(value); };
      const abort = () => finish(reject, signal.reason || new Error('已取消。若指令已送达，请检查面板后再操作。'));
      this.pending.set(id, { clientId: client.id, resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      timer = setTimeout(() => finish(reject, new Error('面板响应超时。请查看当前图和队列，避免重复提交。')), 25000);
      signal?.addEventListener('abort', abort, { once: true });
      client.queue.push({ id, action, args, expiresAt: Date.now() + 25000 }); this.deliverCommands(client);
    });
  }
  deliverCommands(client) {
    if (!this.mcpEnabled || !client.ready || !client.allowAI || !client.stream || client.stream.destroyed) return;
    const commands = client.queue.splice(0);
    if (commands.length) client.stream.write('data: ' + JSON.stringify({ commands }) + '\n\n');
  }
  async handle(req, res) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { json(res, 400, { error: 'Invalid request path' }); return; }
    const path = new URL(req.url, this.frameOrigin).pathname;
    const originalOrigin = new URL(this.url).origin;
    const bridgePath = path.startsWith('/__dsh_comfyui/');
    if (bridgePath && req.headers.origin === originalOrigin) {
      res.setHeader('Access-Control-Allow-Origin', originalOrigin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Dsh-Comfy-Token' }); res.end(); return;
      }
    }
    if (req.headers.origin && req.headers.origin !== this.frameOrigin && !(bridgePath && req.headers.origin === originalOrigin)) { json(res, 403, { error: 'Origin mismatch' }); return; }
    if (path === '/mcp') { await this.mcpHandler(req, res); return; }
    if (path === '/__dsh_comfyui/bootstrap' && req.method === 'GET') {
      json(res, 200, { bridgeBase: this.frameOrigin, token: this.token, originalOrigin,
        bridgeVersion: this.bridgeVersion, bridgeProtocol: BRIDGE_PROTOCOL }); return;
    }
    if (path === '/__dsh_comfyui/bridge.js' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(this.bridgeCode.replace('__DSH_BRIDGE_TOKEN__', JSON.stringify(this.token))); return;
    }
    if (path === '/__dsh_comfyui/commands' && req.method === 'GET') {
      const query = new URL(req.url, this.frameOrigin).searchParams;
      const id = query.get('clientId'), sessionId = query.get('sessionId');
      if (query.get('token') !== this.token || !id || !sessionId || Number(query.get('bridgeProtocol')) !== BRIDGE_PROTOCOL) { json(res, 403, { error: 'Command stream authentication failed' }); return; }
      let client = this.clients.get(id);
      if (client && client.sessionId !== sessionId) { json(res, 403, { error: 'Session mismatch' }); return; }
      if (!client) { client = { id, sessionId, queue: [], seen: Date.now(), ready: false, allowAI: false }; this.clients.set(id, client); }
      client.stream?.end(); client.stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n'); this.deliverCommands(client);
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
      res.on('close', () => { clearInterval(heartbeat); if (client.stream === res) client.stream = null; });
      return;
    }
    if (path === '/__dsh_comfyui/poll' || path === '/__dsh_comfyui/result' || path === '/__dsh_comfyui/sync' || path === '/__dsh_comfyui/state') {
      if (req.method !== 'POST' || req.headers['x-dsh-comfy-token'] !== this.token) { json(res, 403, { error: 'Bridge authentication failed' }); return; }
      const data = await readJson(req);
      if (typeof data.clientId !== 'string' || typeof data.sessionId !== 'string') throw new Error('Invalid client identity');
      if (path.endsWith('/sync') || path.endsWith('/poll') || path.endsWith('/state')) {
        let client = this.clients.get(data.clientId);
        if (client && client.sessionId !== data.sessionId) throw new Error('Session mismatch');
        if (!client) { client = { id: data.clientId, sessionId: data.sessionId, queue: [] }; this.clients.set(client.id, client); }
        Object.assign(client, { ready: data.ready === true && data.bridgeProtocol === BRIDGE_PROTOCOL,
          allowAI: data.allowAI === true, visible: data.visible === true, seen: Date.now(),
          bridgeProtocol: data.bridgeProtocol, bridgeVersion: data.bridgeVersion,
          workflowTabs: Number.isInteger(data.workflowTabs) ? data.workflowTabs : null,
          hasActiveWorkflow: typeof data.hasActiveWorkflow === 'boolean' ? data.hasActiveWorkflow : null });
        // Expired clients cannot capture a later session's graph. Commands are delivered once.
        for (const [id, c] of this.clients) if (!liveClient(c) && Date.now() - c.seen > 60000) this.clients.delete(id);
        // Old pages keep their original JS after a plugin upgrade. Never send them
        // another graph: their loader may create a new ComfyUI workflow tab.
        if (data.bridgeProtocol !== BRIDGE_PROTOCOL) {
          json(res, path.endsWith('/sync') ? 409 : 200, {
            commands: [], refreshRequired: true, bridgeProtocol: BRIDGE_PROTOCOL,
            error: 'ComfyUI 同步代码已更新，请刷新此 ComfyUI 页面后继续。'
          }); return;
        }
        if (path.endsWith('/sync')) { json(res, 200, this.sync.exchange(data)); return; }
        this.deliverCommands(client);
        const commands = client.allowAI && client.ready ? client.queue.splice(0) : [];
        json(res, 200, { commands }); return;
      }
      const pending = this.pending.get(data.id);
      if (pending?.clientId === data.clientId) {
        if (data.error) pending.reject(new Error(String(data.error)));
        else pending.resolve(data.result);
      }
      json(res, 200, { ok: true }); return;
    }
    if (path.startsWith('/__dsh_comfyui/')) { json(res, 404, { error: 'Not found' }); return; }
    const target = new URL(req.url, this.url); const transport = target.protocol === 'https:' ? https : http;
    const headers = headersOf(req.headers); headers.host = target.host;
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer?.startsWith(this.frameOrigin)) headers.referer = headers.referer.replace(this.frameOrigin, target.origin);
    const inject = path === '/' && req.method === 'GET';
    if (inject) { headers['accept-encoding'] = 'identity'; delete headers['if-none-match']; delete headers['if-modified-since']; }
    const upstream = transport.request(target, { method: req.method, headers }, response => {
      const outHeaders = headersOf(response.headers);
      if (inject && response.statusCode === 200 && String(outHeaders['content-type']).includes('text/html')) {
        const parts = []; response.on('data', chunk => parts.push(chunk));
        response.on('end', () => {
          try {
            let buffer = Buffer.concat(parts); const encoding = outHeaders['content-encoding'];
            if (encoding === 'gzip') buffer = gunzipSync(buffer); else if (encoding === 'deflate') buffer = inflateSync(buffer); else if (encoding === 'br') buffer = brotliDecompressSync(buffer);
            const html = buffer.toString().replace(/<\/body>/i, '<script defer src="/__dsh_comfyui/bridge.js"></script></body>');
            delete outHeaders['content-length']; delete outHeaders['content-encoding']; delete outHeaders.etag;
            outHeaders['cache-control'] = 'no-store';
            res.writeHead(200, outHeaders); res.end(html);
          } catch(e) { res.destroy(e); }
        }); response.on('error', e => res.destroy(e));
      } else { res.writeHead(response.statusCode, outHeaders); response.pipe(res); }
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('ComfyUI 连接超时')));
    upstream.on('error', e => { if (!res.headersSent) json(res, 502, { error: '连接不到 ComfyUI：' + e.message }); else res.destroy(e); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { socket.destroy(); return; }
    if (req.headers.origin && req.headers.origin !== this.frameOrigin) { socket.destroy(); return; }
    const target = new URL(req.url, this.url); const transport = target.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: target.host, origin: target.origin };
    const upstream = transport.request(target, { headers });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      this.sockets.add(peer); peer.on('close', () => this.sockets.delete(peer));
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + Object.entries(response.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (upstreamHead.length) socket.write(upstreamHead); if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy());
      peer.pipe(socket); socket.pipe(peer);
    });
    upstream.on('response', () => socket.destroy()); upstream.on('error', () => socket.destroy());
    upstream.setTimeout(15000, () => upstream.destroy()); upstream.end();
  }
}
