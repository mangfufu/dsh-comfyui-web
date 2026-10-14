window.__ModuleLoader__.load({ id: 'dsh-comfyui-web', factory: require => {
  const React = require('react');
  const { ImageLightbox } = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const { useState, useEffect, useRef, useSyncExternalStore } = React;
  const ID = 'dsh-comfyui-web';
  const PRIVACY_KEY = 'dsh.comfyui.blurOutputImages';
  const privacyListeners = new Set();
  let blurOutputImages = false;
  try { blurOutputImages = localStorage.getItem(PRIVACY_KEY) === 'true'; } catch {}
  function setImagePrivacy(enabled, persist = true) {
    if (persist) { try { localStorage.setItem(PRIVACY_KEY, String(enabled)); } catch {} }
    if (blurOutputImages === enabled) return;
    blurOutputImages = enabled;
    for (const listener of privacyListeners) listener();
  }
  const subscribePrivacy = listener => { privacyListeners.add(listener); return () => privacyListeners.delete(listener); };
  const privacySnapshot = () => blurOutputImages;
  const useImagePrivacy = () => useSyncExternalStore(subscribePrivacy, privacySnapshot, () => false);
  const taskSources = new Map();
  const EMPTY_TASKS = [];
  function taskSource(sessionId) {
    if (!taskSources.has(sessionId)) {
      const listeners = new Set(); let tasks = EMPTY_TASKS, stream, timer, cancelled = false, epoch = 0;
      const publish = value => { tasks = value; for (const listener of listeners) listener(); };
      const connect = async (lease = epoch) => {
        try {
          const settings = await api();
          if (cancelled || lease !== epoch) return;
          stream = new EventSource('/dsh-comfyui/events?' + new URLSearchParams({ sessionId, token: settings.token }));
          stream.onmessage = event => { try { publish(JSON.parse(event.data).tasks || []); } catch {} };
          const active = stream;
          stream.onerror = () => { active.close(); if (!cancelled && lease === epoch) timer = setTimeout(() => connect(lease), 3000); };
        } catch { if (!cancelled && lease === epoch) timer = setTimeout(() => connect(lease), 3000); }
      };
      taskSources.set(sessionId, { getSnapshot: () => tasks, subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) { cancelled = false; epoch++; connect(); }
        return () => { listeners.delete(listener); if (!listeners.size) { cancelled = true; epoch++; stream?.close(); clearTimeout(timer); } };
      } });
    }
    return taskSources.get(sessionId);
  }
  const CSS = `
    .dsh-comfy { display:flex; flex:1 1 auto; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; box-sizing:border-box; background:var(--dsr-bg,#181a1d); color:inherit; }
    .dsh-comfy-bar { display:flex; flex:none; align-items:center; flex-wrap:wrap; gap:10px; padding:8px 12px; border-bottom:1px solid #80808030; font-size:12px; }
    .dsh-comfy-state { display:flex; align-items:center; gap:6px; margin-right:auto; }
    .dsh-comfy-dot { width:6px; height:6px; border-radius:50%; background:#d28b35; }
    .dsh-comfy-dot.ready { background:#48b08a; }
    .dsh-comfy-dot.off { background:#888; }
    .dsh-comfy-bar label { display:flex; align-items:center; gap:5px; white-space:nowrap; cursor:pointer; }
    .dsh-comfy button,.dsh-comfy-entry { background:transparent; color:inherit; border:1px solid #80808040; border-radius:6px; padding:5px 9px; font:inherit; cursor:pointer; }
    .dsh-comfy button:hover,.dsh-comfy-entry:hover { background:#80808018; }
    .dsh-comfy button:focus-visible,.dsh-comfy-entry:focus-visible { outline:2px solid #48b08a; outline-offset:2px; }
    .dsh-comfy .dsh-comfy-privacy { display:flex; align-items:center; gap:7px; }
    .dsh-comfy .dsh-comfy-privacy[aria-checked=true] { background:#80808024; border-color:#a0a0a080; }
    .dsh-comfy .dsh-comfy-privacy:focus-visible { outline-color:#aaa; }
    .dsh-comfy-privacy-track { position:relative; display:inline-block; width:28px; height:16px; border-radius:20px; background:#80808070; }
    .dsh-comfy-privacy-track::before { content:''; position:absolute; width:12px; height:12px; left:2px; top:2px; border-radius:50%; background:#fff; transition:transform .15s ease; }
    .dsh-comfy-privacy[aria-checked=true] .dsh-comfy-privacy-track { background:#90949b; }
    .dsh-comfy-privacy[aria-checked=true] .dsh-comfy-privacy-track::before { transform:translateX(12px); }
    .dsh-comfy-privacy-state { font-size:11px; opacity:.8; }
    @media (prefers-reduced-motion:reduce) { .dsh-comfy-privacy-track::before { transition:none; } }
    .dsh-comfy-entry { font-size:12px; display:flex; align-items:center; gap:6px; }
    .dsh-comfy-settings { flex:none; padding:12px; border-bottom:1px solid #80808030; display:grid; gap:12px; font-size:12px; max-height:45%; overflow:auto; }
    .dsh-comfy-settings-head,.dsh-comfy-settings form { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .dsh-comfy-settings-head strong { margin-right:auto; }
    .dsh-comfy-switch { display:flex; align-items:center; gap:6px; cursor:pointer; }
    .dsh-comfy-settings input[type=url] { flex:1; min-width:150px; }
    .dsh-comfy-settings input[type=url],.dsh-comfy-settings textarea { box-sizing:border-box; background:transparent; color:inherit; border:1px solid #80808060; border-radius:6px; padding:7px; font:12px Consolas,monospace; }
    .dsh-comfy-settings textarea { display:block; width:100%; resize:vertical; margin:8px 0; }
    .dsh-comfy-settings p { margin:0; opacity:.75; line-height:1.6; overflow-wrap:anywhere; }
    .dsh-comfy-settings summary { cursor:pointer; }
    .dsh-comfy-settings code { overflow-wrap:anywhere; user-select:text; }
    .dsh-comfy-viewport { flex:1 1 0; min-width:0; min-height:0; overflow:hidden; position:relative; background:#202020; }
    .dsh-comfy-frame { display:block; position:absolute; top:0; left:0; border:0; max-width:none; max-height:none; margin:0; padding:0; background:#202020; transform-origin:top left; }
    .dsh-comfy-zoom { display:flex; align-items:center; gap:4px; font-variant-numeric:tabular-nums; }
    .dsh-comfy-zoom button { padding:3px 7px; min-width:26px; }
    .dsh-comfy-note { padding:8px 12px; font-size:12px; background:#d28b3514; border-bottom:1px solid #d28b3540; overflow-wrap:anywhere; }
    .dsh-comfy-empty { padding:24px; line-height:1.7; font-size:13px; }
    .dsh-comfy-images { display:flex; flex-wrap:wrap; align-items:flex-start; gap:16px; max-width:100%; min-width:0; }
    .dsh-comfy-images[data-align=end] { justify-content:flex-end; }
    .dsh-comfy-image-card { position:relative; flex:none; max-width:100%; min-width:0; }
    .dsh-comfy-image { display:block; position:relative; box-sizing:border-box; width:100%; min-width:0; min-height:0; padding:0; overflow:hidden; border:1px solid #80808040; border-radius:16px; background:var(--dsw-alias-interactive-bg-hover,#80808018); color:inherit; cursor:zoom-in; }
    .dsh-comfy-image img { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:contain; }
    .dsh-comfy-image video { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:contain; }
    .dsh-comfy-image[data-blurred=true] img { filter:blur(28px) brightness(.65); transform:scale(1.15); }
    .dsh-comfy-image[data-blurred=true] video { filter:blur(28px) brightness(.65); transform:scale(1.15); }
    .dsh-comfy-video { cursor:default; }
    .dsh-comfy-video-reveal { position:absolute; inset:0; width:100%; height:100%; border:0; padding:0; background:transparent; color:inherit; cursor:pointer; }
    .dsh-comfy-image-mask { display:flex; position:absolute; inset:0; align-items:center; justify-content:center; flex-direction:column; gap:8px; background:#1b202a26; color:#fff; font-size:12px; text-shadow:0 1px 4px #0009; pointer-events:none; }
    .dsh-comfy-image:focus-visible { outline:2px solid #aaa; outline-offset:3px; }
    .dsh-comfy-image-eye { display:grid; place-items:center; position:absolute; top:6px; left:6px; z-index:1; width:28px; height:28px; padding:0; border:1px solid #ffffff35; border-radius:8px; background:#35383dcc; color:#eee; cursor:pointer; backdrop-filter:blur(8px); opacity:0; pointer-events:none; }
    .dsh-comfy-image-card:hover .dsh-comfy-image-eye,.dsh-comfy-image-card:has(:focus-visible) .dsh-comfy-image-eye { opacity:1; pointer-events:auto; }
    .dsh-comfy-image-eye:hover { background:#555960e6; }
    .dsh-comfy-image-eye:focus-visible { outline:2px solid #aaa; outline-offset:2px; }
    @media (hover:none) { .dsh-comfy-image-eye { opacity:1; pointer-events:auto; } }
    .dsh-comfy-image-info { max-width:100%; padding:6px 0 0; font-size:11px; opacity:.65; overflow-wrap:anywhere; }
    .dsh-comfy-output { display:grid; gap:8px; padding:8px 0; }
    .dsh-comfy-output-head { display:flex; align-items:center; gap:8px; font-size:12px; }
    .dsh-comfy-output-head strong { font-weight:500; margin-right:auto; }
    .dsh-comfy-output-head button { padding:3px 7px; font:inherit; color:inherit; border:1px solid #80808040; background:transparent; border-radius:5px; cursor:pointer; }
    .dsh-comfy-output-text { margin:0; max-height:180px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
    .dsh-comfy-image-loading,.dsh-comfy-image-error { padding:8px; font-size:12px; line-height:1.5; opacity:.75; }
  `;
  function Eye({ hidden = false, size = 18 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': true },
      h('path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z' }),
      h('circle', { cx: 12, cy: 12, r: 3 }), hidden ? h('path', { d: 'M3 3l18 18', strokeWidth: 2 }) : null);
  }
  function OutputImage({ image, loadImage, protectedImage }) {
    const attachment = image.attachment;
    const preview = image.preview;
    const imageKey = attachment ? attachment.attachmentId : preview?.url;
    const [loaded, setLoaded] = useState(() => ({ key: imageKey, src: attachment ? loadImage.peek?.(attachment) ?? null : null }));
    const [attempt, setAttempt] = useState(0);
    const [open, setOpen] = useState(false);
    const [override, setOverride] = useState(null);
    const [naturalSize, setNaturalSize] = useState(null);
    const src = preview?.url ?? (loaded.key === imageKey ? loaded.src : null);
    const error = loaded.key === imageKey && loaded.error;
    const label = image.label ?? preview?.name ?? attachment?.name ?? '图片';
    const recordedSize = attachment ?? preview;
    const dimensions = recordedSize?.width > 0 && recordedSize?.height > 0 ? recordedSize
      : naturalSize?.key === imageKey ? naturalSize : { width: 360, height: 360 };
    const scale = Math.min(1, 360 / dimensions.width, 540 / dimensions.height);
    const cardWidth = dimensions.width * scale;
    useEffect(() => {
      let live = true;
      setOpen(false);
      if (attachment) {
        setLoaded({ key: imageKey, src: loadImage.peek?.(attachment) ?? null });
        Promise.resolve().then(() => loadImage(attachment)).then(url => {
          if (live) setLoaded({ key: imageKey, src: url });
        }).catch(() => { if (live) setLoaded({ key: imageKey, src: null, error: true }); });
      }
      return () => { live = false; };
    }, [imageKey, attachment, loadImage, attempt]);
    useEffect(() => { setOverride(null); }, [imageKey, protectedImage]);
    const close = React.useCallback(() => setOpen(false), []);
    const blurred = protectedImage && (override?.key === imageKey && override.baseline === protectedImage ? override.value : true);
    const mask = blurred && src !== null && !error;
    return h(React.Fragment, null,
      h('div', { className: 'dsh-comfy-image-card', style: { width: cardWidth } },
      h('button', { type: 'button', className: 'dsh-comfy-image', 'data-blurred': mask ? 'true' : 'false',
        style: { aspectRatio: dimensions.width + ' / ' + dimensions.height },
        title: error ? '加载失败，点击重试' : mask ? '图片已遮挡，点击显示图片' : '点击查看原图',
        'aria-label': error ? '重新加载图片' : (mask ? '显示已遮挡图片：' : '查看原图：') + label,
        'aria-busy': !error && src === null,
        onClick: () => {
          if (error) { setAttempt(value => value + 1); return; }
          if (src === null) return;
          if (mask) setOverride({ key: imageKey, baseline: protectedImage, value: false });
          else setOpen(true);
        } },
        error ? h('span', { className: 'dsh-comfy-image-error' }, '加载失败，点击重试') : src === null
          ? h('span', { className: 'dsh-comfy-image-loading' }, '加载图片…')
          : h('img', { src, alt: label, onLoad: event => {
            const img = event.currentTarget;
            if (!(recordedSize?.width > 0 && recordedSize?.height > 0) && img.naturalWidth > 0 && img.naturalHeight > 0)
              setNaturalSize({ key: imageKey, width: img.naturalWidth, height: img.naturalHeight });
          } }),
        mask ? h('span', { className: 'dsh-comfy-image-mask', 'aria-hidden': true },
          h(Eye, { hidden: true, size: 22 }),
          h('span', null, '点击显示图片')) : null),
      protectedImage && src !== null && !error ? h('button', { type: 'button', className: 'dsh-comfy-image-eye', 'aria-pressed': mask,
        'aria-label': (mask ? '显示图片：' : '模糊图片：') + label, title: mask ? '显示这张图片' : '模糊这张图片',
        onClick: () => setOverride({ key: imageKey, baseline: protectedImage, value: !mask }) }, h(Eye, { hidden: mask })) : null,
      h('div', { className: 'dsh-comfy-image-info' }, label,
        dimensions?.width && dimensions?.height ? ' · ' + dimensions.width + ' × ' + dimensions.height : '')),
      open && src !== null ? h(ImageLightbox, { src, alt: label, labels: { dialog: '原图预览', close: '关闭原图预览' }, onClose: close }) : null);
  }
  function OutputVideo({ image, protectedImage }) {
    const [override, setOverride] = useState(null);
    const [size, setSize] = useState(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const videoRef = useRef(null);
    const blurred = protectedImage && (override?.key === image.url && override.baseline === protectedImage ? override.value : true);
    useEffect(() => { setOverride(null); setError(false); }, [image.url, protectedImage]);
    useEffect(() => { if (blurred) videoRef.current?.pause(); }, [blurred]);
    const dimensions = size?.key === image.url ? size : { width: 360, height: 240 };
    const scale = Math.min(1, 360 / dimensions.width, 540 / dimensions.height);
    const reveal = () => setOverride({ key: image.url, baseline: protectedImage, value: false });
    return h('div', { className: 'dsh-comfy-image-card', style: { width: dimensions.width * scale } },
      h('div', { className: 'dsh-comfy-image dsh-comfy-video', 'data-blurred': blurred ? 'true' : 'false',
        style: { aspectRatio: dimensions.width + ' / ' + dimensions.height } },
        h('video', { key: image.url + ':' + attempt, ref: videoRef, src: image.url, controls: !blurred,
          preload: 'metadata', playsInline: true, 'aria-label': image.filename, onError: () => setError(true),
          onLoadedMetadata: event => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0)
              setSize({ key: image.url, width: video.videoWidth, height: video.videoHeight });
          } }),
        error ? h('button', { type: 'button', className: 'dsh-comfy-video-reveal', onClick: () => { setError(false); setAttempt(v => v + 1); } }, '视频加载失败，点击重试')
          : blurred ? h('button', { type: 'button', className: 'dsh-comfy-video-reveal', onClick: reveal, 'aria-label': '显示已遮挡视频：' + image.filename },
            h('span', { className: 'dsh-comfy-image-mask', 'aria-hidden': true }, h(Eye, { hidden: true, size: 22 }), h('span', null, '点击显示视频'))) : null),
      protectedImage && !error ? h('button', { type: 'button', className: 'dsh-comfy-image-eye', 'aria-pressed': blurred,
        'aria-label': (blurred ? '显示视频：' : '模糊视频：') + image.filename, title: blurred ? '显示这个视频' : '模糊这个视频',
        onClick: () => setOverride({ key: image.url, baseline: protectedImage, value: !blurred }) }, h(Eye, { hidden: blurred })) : null,
      h('div', { className: 'dsh-comfy-image-info' }, image.filename,
        size?.key === image.url ? ' · ' + size.width + ' × ' + size.height : ''));
  }
  function MessageImages({ images, loadImage, align }) {
    const enabled = useImagePrivacy();
    if (!images.length) return null;
    return h(React.Fragment, null, h('style', null, CSS), h('div', { className: 'dsh-comfy-images', 'data-align': align },
      images.map((image, index) => h(image.kind === 'dsh-comfyui-web.video' ? OutputVideo : OutputImage, { key: (image.url ?? image.attachment?.attachmentId ?? image.preview?.url) + ':' + index,
        image, loadImage, protectedImage: enabled }))));
  }
  function resultImages(block) {
    if (block.kind !== 'tool-result' || block.isError || !Array.isArray(block.content)) return [];
    const content = block.content;
    let file;
    for (const part of content) {
      if (part.type !== 'text') continue;
      try { const value = JSON.parse(part.text); if (typeof value.filename === 'string') { file = value; break; } } catch {}
    }
    return content.filter(part => part.type === 'image' && part.attachment)
      .map(part => ({ attachment: part.attachment, ...(file ? { label: file.filename, file } : {}) }));
  }
  function mediaKey(file) {
    if (!file?.filename || !file.promptId) return null;
    return JSON.stringify([file.promptId, file.type || 'output', file.subfolder || '', file.filename]);
  }
  function ComfyImageResult({ toolName, block, inspect }) {
    if (!['mcp__comfyui__get_image', 'mcp__comfyui__get_video'].includes(toolName)) return null;
    const video = toolName === 'mcp__comfyui__get_video';
    const settled = block.kind === 'tool-result';
    const content = settled && Array.isArray(block.content) ? block.content : [];
    const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const images = video ? resultVideos(block) : resultImages(block);
    return h('section', { className: 'dsh-comfy-output', 'aria-label': video ? 'ComfyUI 视频结果' : 'ComfyUI 图片结果' }, h('style', null, CSS),
      h('div', { className: 'dsh-comfy-output-head' }, h('strong', null, video ? 'ComfyUI 视频' : 'ComfyUI 图片'),
        h('span', { role: 'status' }, !settled ? '读取中…' : block.isError ? '读取失败' : images.length ? '已读取' : '已完成'),
        inspect ? h('button', { type: 'button', onClick: inspect }, '查看调用') : null),
      images.length ? h('span', { className: 'dsh-comfy-image-info' }, (video ? '视频' : '图片') + '将在本次回复正文的结果区显示。') : null,
      !images.length && text ? h('pre', { className: 'dsh-comfy-output-text', role: block.isError ? 'alert' : undefined }, text) : null);
  }
  function resultVideos(block) {
    if (block.kind !== 'tool-result' || block.isError) return [];
    for (const part of block.content ?? []) {
      if (part.type !== 'text') continue;
      try {
        const value = JSON.parse(part.text);
        if (value.kind === 'dsh-comfyui-web.video' && typeof value.filename === 'string'
          && typeof value.url === 'string' && /^\/dsh-comfyui\/media\?ticket=[A-Za-z0-9_.-]+$/.test(value.url)) return [value];
      } catch {}
    }
    return [];
  }
  function ComfyTurnResults({ turn, resultSource, loadImage, generationSource }) {
    const subscribe = React.useCallback(listener => resultSource.subscribe(listener), [resultSource]);
    const read = React.useCallback(() => resultSource.getSnapshot(), [resultSource]);
    const snapshot = useSyncExternalStore(subscribe, read, read);
    const subscribeTasks = React.useCallback(listener => generationSource?.subscribe(listener) || (() => {}), [generationSource]);
    const readTasks = React.useCallback(() => generationSource?.getSnapshot() || EMPTY_TASKS, [generationSource]);
    const tasks = useSyncExternalStore(subscribeTasks, readTasks, readTasks);
    const images = [], runIds = new Set(), seenCalls = new Set(), seenImages = new Set(), seenMedia = new Set();
    const visit = block => {
      if (!block || seenCalls.has(block.callId)) return;
      seenCalls.add(block.callId);
      if (block.call?.name === 'mcp__comfyui__get_image') {
        for (const image of resultImages(block)) {
          const key = mediaKey(image.file) || image.attachment.attachmentId + ':' + (image.label ?? '');
          if (!seenImages.has(key)) { seenImages.add(key); images.push(image); }
          if (mediaKey(image.file)) seenMedia.add(mediaKey(image.file));
        }
      }
      if (block.call?.name === 'mcp__comfyui__get_video') {
        for (const video of resultVideos(block)) {
          if (!seenImages.has(video.url)) { seenImages.add(video.url); images.push(video); }
          if (mediaKey(video)) seenMedia.add(mediaKey(video));
        }
      }
      if (block.call?.name === 'mcp__comfyui__run' && block.kind === 'tool-result' && !block.isError) {
        for (const part of block.content || []) if (part.type === 'text') {
          try { const value = JSON.parse(part.text); if (typeof value.prompt_id === 'string') runIds.add(value.prompt_id); } catch {}
        }
      }
      for (const child of block.subCalls ?? []) visit(child);
    };
    // Chat history retains the tool records even when presentation hides the process.
    for (const key of snapshot?.locations.getTurn(turn.turn) ?? []) {
      const node = snapshot.nodes.get(key);
      if (node?.kind === 'tool-call') visit(node.data.root);
    }
    const ownedTasks = tasks.filter(task => runIds.has(task.promptId));
    for (const task of ownedTasks) for (const media of task.media || []) {
      const key = mediaKey(media);
      if ((key && seenMedia.has(key)) || seenImages.has(media.url)) continue;
      if (key) seenMedia.add(key);
      seenImages.add(media.url);
      if (media.kind === 'dsh-comfyui-web.video') images.push(media);
      else if (media.kind === 'dsh-comfyui-web.image') images.push({ label: media.filename, preview: { url: media.url, name: media.filename } });
    }
    if (!images.length && !ownedTasks.length) return null;
    const labels = { queued: '排队中', running: '生成中', completed: '已完成', failed: '生成失败', cancelled: '已取消', interrupted: '已中断', not_found: '未找到任务', monitor_stopped: '等待重新连接' };
    return h('section', { className: 'dsh-comfy-output', 'aria-label': 'ComfyUI 生成结果' },
      h('style', null, CSS),
      h('div', { className: 'dsh-comfy-output-head' }, h('strong', null, 'ComfyUI 生成结果')),
      ownedTasks.map(task => h('div', { key: task.promptId, className: 'dsh-comfy-image-info', role: 'status' },
        labels[task.status] || task.status, task.progress?.max > 0 ? ' · ' + Math.round(task.progress.value / task.progress.max * 100) + '%' : '',
        task.result?.error?.message ? ' · ' + task.result.error.message : task.result?.message ? ' · ' + task.result.message : '')),
      h(MessageImages, { images, loadImage, align: 'start' }));
  }
  async function api(body, token, signal) {
    const response = await fetch('/dsh-comfyui/api', body ? { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Dsh-Comfy-Token': token }, body: JSON.stringify(body) } : { signal, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || '连接失败');
    return result;
  }
  function Body({ sessionId, useTabInfo }) {
    const { tab } = useTabInfo();
    const frame = useRef(null);
    const clientId = useRef(crypto.randomUUID());
    const [connection, setConnection] = useState(null);
    const [url, setUrl] = useState('http://127.0.0.1:8188');
    const [ready, setReady] = useState(false);
    const [bridgeSeen, setBridgeSeen] = useState(false);
    const [bridgeWaitExpired, setBridgeWaitExpired] = useState(false);
    const [error, setError] = useState('');
    const [settings, setSettings] = useState(false);
    const [epoch, setEpoch] = useState(0);
    const [saving, setSaving] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [copied, setCopied] = useState(false);
    const imagePrivacy = useImagePrivacy();
    const [zoom, setZoom] = useState(() => {
      try { const saved = Number(localStorage.getItem('dsh.comfyui.zoom')); return saved >= 0.5 && saved <= 1.25 ? saved : 0.85; }
      catch { return 0.85; }
    });
    const mcpEnabled = connection?.mcp?.enabled !== false;
    const state = useRef({ allowAI: mcpEnabled, visible: tab.visible });
    state.current = { allowAI: mcpEnabled, visible: tab.visible };
    const sendState = () => {
      if (!connection || !frame.current?.contentWindow) return;
      frame.current.contentWindow.postMessage({ source: 'dsh-comfyui-parent', clientId: clientId.current, ...state.current }, new URL(connection.url).origin);
    };
    useEffect(() => {
      const controller = new AbortController();
      api(null, null, controller.signal).then(data => { setConnection(data); setUrl(data.url); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
      const refresh = setInterval(() => api(null, null, controller.signal).then(data => {
        setConnection(previous => previous && previous.url === data.url && previous.frameOrigin === data.frameOrigin && previous.token === data.token && previous.mcp?.enabled === data.mcp?.enabled ? previous : data);
      }).catch(() => {}), 3000);
      return () => { controller.abort(); clearInterval(refresh); };
    }, []);
    useEffect(() => {
      if (!connection) return;
      const receive = event => {
        if (event.origin !== new URL(connection.url).origin || event.source !== frame.current?.contentWindow || event.data?.source !== 'dsh-comfyui' || event.data.clientId !== clientId.current) return;
        setBridgeSeen(true);
        setReady(event.data.ready === true);
        if (event.data.warning) setError(event.data.warning); else if (event.data.ready) setError(''); else if (event.data.error) setError(event.data.error);
        sendState();
      };
      window.addEventListener('message', receive);
      const heartbeat = setInterval(sendState, 1000);
      return () => { window.removeEventListener('message', receive); clearInterval(heartbeat); };
    }, [connection]);
    useEffect(() => {
      setReady(false); setBridgeSeen(false); setBridgeWaitExpired(false);
      if (!connection) return;
      const timer = setTimeout(() => setBridgeWaitExpired(true), 12000);
      return () => clearTimeout(timer);
    }, [connection?.url, connection?.frameOrigin, connection?.token, epoch]);
    useEffect(() => {
      sendState();
    }, [mcpEnabled, tab.visible, connection]);
    useEffect(() => { try { localStorage.setItem('dsh.comfyui.zoom', String(zoom)); } catch {} }, [zoom]);
    const changeZoom = delta => setZoom(value => Math.min(1.25, Math.max(0.5, Math.round((value + delta) * 100) / 100)));
    async function connect(event) {
      event.preventDefault(); setSaving(true); setError('');
      try {
        const data = await api({ op: 'connect', url }, connection.token);
        setConnection({ ...data, token: connection.token }); setReady(false); setEpoch(value => value + 1);
        await api({ op: 'check' }, connection.token);
      } catch(e) { setError(e.message); } finally { setSaving(false); }
    }
    async function toggleMcp(enabled) {
      setSwitching(true); setError('');
      try { setConnection(await api({ op: 'setMcpEnabled', enabled }, connection.token)); }
      catch(e) { setError(e.message); } finally { setSwitching(false); }
    }
    async function copyConfig() {
      try { await navigator.clipboard.writeText(JSON.stringify(connection.mcp.clientConfig, null, 2)); setCopied(true); }
      catch { setError('复制失败，请选中下方配置手动复制。'); }
    }
    const src = connection ? connection.url + '/?dsh_client=' + encodeURIComponent(clientId.current) + '&dsh_session=' + encodeURIComponent(sessionId) + '&dsh_bridge=' + encodeURIComponent(connection.frameOrigin) : null;
    const bridgeMissing = connection && mcpEnabled && !bridgeSeen && bridgeWaitExpired;
    const installation = connection?.extensionInstallation;
    const installationHelp = installation?.status === 'failed' || installation?.status === 'unconfigured'
      ? installation.message : '尚未收到 AI 桥接扩展连接。请确认 ComfyUI 可访问、已安装扩展；首次安装后重启 ComfyUI 并刷新面板。Docker 用户需确认扩展所在目录已持久化挂载。';
    const setupLink = () => h('a', { href: 'https://github.com/mangfufu/dsh-comfyui-web#comfyui-extension-install', target: '_blank', rel: 'noopener noreferrer' }, '扩展安装说明');
    return h('section', { className: 'dsh-comfy', 'aria-label': 'ComfyUI 工作台' },
      h('style', null, CSS),
      h('div', { className: 'dsh-comfy-bar' },
        h('span', { className: 'dsh-comfy-state', role: 'status' }, h('i', { className: 'dsh-comfy-dot' + (!mcpEnabled ? ' off' : ready ? ' ready' : '') }), !mcpEnabled ? 'MCP 已关闭' : ready ? 'MCP · 共享画布已连接' : bridgeMissing ? 'AI 桥接扩展未连接' : '等待 ComfyUI'),
        h('div', { className: 'dsh-comfy-zoom', role: 'group', 'aria-label': 'ComfyUI 界面缩放' },
          h('button', { type: 'button', onClick: () => changeZoom(-0.05), disabled: zoom <= 0.5, 'aria-label': '缩小 ComfyUI 界面' }, '−'),
          h('button', { type: 'button', onClick: () => setZoom(1), title: '恢复 100% 大小', 'aria-label': '当前缩放 ' + Math.round(zoom * 100) + '%，点击恢复 100%' }, Math.round(zoom * 100) + '%'),
          h('button', { type: 'button', onClick: () => changeZoom(0.05), disabled: zoom >= 1.25, 'aria-label': '放大 ComfyUI 界面' }, '+')),
        h('button', { type: 'button', className: 'dsh-comfy-privacy', role: 'switch', 'aria-checked': imagePrivacy, 'aria-label': '图片对话中模糊',
          onClick: () => setImagePrivacy(!imagePrivacy), title: '只影响本插件在对话中返回的图片和视频；左上角的小眼睛可单独切换。' },
          h('span', null, '图片对话中模糊'), h('span', { className: 'dsh-comfy-privacy-track', 'aria-hidden': true }),
          h('span', { className: 'dsh-comfy-privacy-state', 'aria-hidden': true }, imagePrivacy ? '开' : '关')),
        h('button', { type: 'button', onClick: () => { setReady(false); setEpoch(v => v + 1); }, title: '刷新 ComfyUI 页面' }, '刷新'),
        h('button', { type: 'button', onClick: () => { setSettings(v => !v); setCopied(false); }, 'aria-expanded': settings }, 'MCP 设置')),
      settings ? h('div', { className: 'dsh-comfy-settings', 'aria-label': 'MCP 设置' },
        h('div', { className: 'dsh-comfy-settings-head' }, h('strong', null, 'ComfyUI MCP'),
          h('label', { className: 'dsh-comfy-switch' }, h('input', { type: 'checkbox', role: 'switch', checked: mcpEnabled, disabled: !connection || switching,
            onChange: e => toggleMcp(e.target.checked) }), switching ? '保存中…' : '开启 MCP')),
        h('p', null, mcpEnabled ? bridgeSeen ? 'MCP 已开启，当前对话的 AI 可直接读取、修改和运行画布。' : 'MCP 已开启，等待桥接扩展连接后可操作画布。' : 'MCP 已关闭，仍可手动编辑和生成。'),
        h('p', null, !bridgeSeen && installation?.status !== 'installed' ? installationHelp + ' ' : '', setupLink()),
        h('form', { onSubmit: connect },
          h('label', { htmlFor: 'comfy-url-' + clientId.current }, 'ComfyUI 地址'),
          h('input', { id: 'comfy-url-' + clientId.current, type: 'url', required: true, value: url, onChange: e => setUrl(e.target.value) }),
          h('button', { type: 'submit', disabled: saving || !connection }, saving ? '连接中…' : '保存并连接')),
        connection?.mcp ? h(React.Fragment, null,
          h('p', null, 'MCP 地址：', h('code', null, connection.mcp.endpoint)),
          h('details', null, h('summary', null, '其他 AI 客户端的 MCP 配置'),
            h('textarea', { readOnly: true, rows: 7, value: JSON.stringify(connection.mcp.clientConfig, null, 2), 'aria-label': 'MCP 客户端配置' }),
            h('button', { type: 'button', onClick: copyConfig }, copied ? '已复制' : '复制配置'),
            h('p', null, 'dsh 已自动接入；这份配置可用于本机其他支持 MCP 的客户端。'))) : null) : null,
      error ? h('div', { className: 'dsh-comfy-note', role: 'alert' }, error) : null,
      bridgeMissing ? h('div', { className: 'dsh-comfy-note', role: 'alert' }, installationHelp, ' ', setupLink()) : null,
      src ? h('div', { className: 'dsh-comfy-viewport' }, h('iframe', { key: epoch, ref: frame, className: 'dsh-comfy-frame', src,
        style: { width: (100 / zoom) + '%', height: (100 / zoom) + '%', transform: 'scale(' + zoom + ')' },
        title: 'ComfyUI 节点编辑与实时生成预览', allow: 'clipboard-read; clipboard-write; fullscreen', allowFullScreen: true,
        onLoad: sendState, referrerPolicy: 'origin' })) : h('div', { className: 'dsh-comfy-empty' }, '正在连接本机 ComfyUI…'));
  }
  function Entry({ open }) {
    return h(React.Fragment, null, h('style', null, CSS), h('button', { type: 'button', className: 'dsh-comfy-entry', onClick: open, title: '在右侧打开 ComfyUI，可改节点、预览并让 AI 操作' },
      h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', 'aria-hidden': true }, h('rect', { x: 2, y: 3, width: 5, height: 5, rx: 1 }), h('rect', { x: 13, y: 12, width: 5, height: 5, rx: 1 }), h('path', { d: 'M7 5.5h4v9h2' })), 'ComfyUI'));
  }
  function apply(ctx) {
    ctx.effect(() => {
      const onStorage = event => { if (event.key === PRIVACY_KEY || event.key === null) setImagePrivacy(event.newValue === 'true', false); };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    });
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'mcp__comfyui__get_image'
    }, ComfyImageResult)));
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'mcp__comfyui__get_video'
    }, ComfyImageResult)));
    ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail', id: ID + '.images', order: 35,
      inject: sessionId => {
        const loadImage = attachment => ctx.uiConversation.imageUrl(sessionId, attachment);
        loadImage.peek = attachment => ctx.uiConversation.peekImageUrl(sessionId, attachment);
        return { resultSource: ctx.uiConversation.binding(sessionId).target('chat'), loadImage, generationSource: taskSource(sessionId) };
      }
    }, ComfyTurnResults)));
    ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: ID, keepMounted: true, title: () => 'ComfyUI',
      guide: [{ id: 'comfyui', order: 35, title: () => 'ComfyUI', description: () => '节点编辑 · 实时预览 · AI 操作' }] }));
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ID }, Body)));
    ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: ID, order: 35,
      inject: () => ({ open: () => ctx.sidebarRight.openTab(ID) }) }, Entry)));
  }
  return { name: ID, inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'uiConversation'], apply };
} });
