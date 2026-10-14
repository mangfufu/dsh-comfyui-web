import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse } from 'node:path';

const setupHint = '请在 ~/.dsh/comfyui/config.json 中设置 customNodesDir 或 frontendExtensionsDir。路径必须能被运行 dsh 的系统写入，并能被 ComfyUI 读取；Docker 建议使用已持久化挂载的 custom_nodes 目录。';

export async function installComfyExtension(config, bridgeOrigin) {
  const custom = config.customNodesDir, frontend = config.frontendExtensionsDir;
  if (!custom && !frontend) return { status: 'unconfigured', message: '尚未配置 ComfyUI 桥接扩展。' + setupHint };
  const mode = custom ? 'custom_nodes' : 'frontend';
  const target = custom || frontend;
  try {
    if (custom && frontend) throw new Error('customNodesDir 与 frontendExtensionsDir 请只设置一个，避免安装两份桥接扩展');
    if (typeof target !== 'string' || !isAbsolute(target)
      || (process.platform === 'win32' && parse(target).root.length <= 1)) {
      throw new Error('请填写运行 dsh 的系统可访问的绝对路径；Windows 不能直接使用容器内的 /usr/... 路径');
    }
    const directory = join(target, custom ? 'dsh-comfyui-bridge' : 'dsh-comfyui');
    const web = custom ? join(directory, 'web') : directory;
    const source = await readFile(new URL('../comfy-extension.js', import.meta.url), 'utf8');
    await mkdir(web, { recursive: true });
    await writeFile(join(web, 'loader.js'), source.replaceAll('__DSH_DEFAULT_BRIDGE__', JSON.stringify(bridgeOrigin)), 'utf8');
    if (custom) await writeFile(join(directory, '__init__.py'),
      'WEB_DIRECTORY = "./web"\nNODE_CLASS_MAPPINGS = {}\n__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS"]\n', 'utf8');
    return { status: 'installed', mode, directory,
      message: '桥接扩展已写入。首次安装请重启 ComfyUI，再刷新 dsh 面板；Docker 需确认此目录已挂载到容器的 custom_nodes。' };
  } catch (error) {
    return { status: 'failed', mode, message: 'ComfyUI 桥接扩展安装失败：' + error.message + '。' + setupHint };
  }
}
