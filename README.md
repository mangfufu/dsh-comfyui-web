# dsh-comfyui-web

在 dsh 里直接使用 ComfyUI，让 AI 通过 MCP 操作当前工作流。改提示词、调参数、运行生图，节点变化和生成预览都在同一个页面里看得见。

## 安装

需要已安装的 [dsh](https://github.com/deepseek-ai/deepseek-harness)、pnpm 和本机 ComfyUI。当前适配 dsh `0.2.0-rc.2`，Node.js 22 及以上。

```sh
dsh plugin --profile web add github:mangfufu/dsh-comfyui-web
```

<a id="comfyui-extension-install"></a>

<details>
<summary>首次安装时，填写 ComfyUI 前端目录</summary>

创建或编辑 `~/.dsh/comfyui/config.json`，将示例中的前端目录替换为本机实际路径。Windows 的 `~` 是用户目录；Linux 同样填写实际路径。

```json
{
  "url": "http://127.0.0.1:8188",
  "frontendExtensionsDir": "D:/ComfyUI/python/Lib/site-packages/comfyui_frontend_package/static/extensions"
}
```

首次安装或更新后，先保存工作流，再刷新已打开的 ComfyUI 原网页和 dsh 内的面板。
目录未配置或写入失败时，面板的 **MCP 设置**和 dsh 启动日志会提示原因。能看到 ComfyUI 网页，还需等到 **MCP · 共享画布已连接** 才能让 AI 操作。

</details>

<details>
<summary>Docker / WSL 中的 ComfyUI</summary>

推荐使用已经持久化挂载的 `custom_nodes` 目录。编辑运行 dsh 的系统中的 `~/.dsh/comfyui/config.json`：

```json
{
  "url": "http://127.0.0.1:8188",
  "customNodesDir": "/mnt/data/ai/comfyui/storage-nodes/custom_nodes"
}
```

上面是 Linux 路径示例。**dsh 在 Windows 运行时，应填写 Windows 能写入的路径**，例如 `D:/ComfyUI/custom_nodes`，或实际 WSL 发行版的共享目录 `//wsl.localhost/Ubuntu/mnt/data/ai/comfyui/storage-nodes/custom_nodes`。

确认对应宿主目录已挂载到容器的 `custom_nodes`，例如：

```yaml
volumes:
  - /mnt/data/ai/comfyui/storage-nodes/custom_nodes:/root/ComfyUI/custom_nodes
```

启动 dsh 后会生成 `dsh-comfyui-bridge` 扩展。先保存工作流，再重启 ComfyUI、刷新 dsh 面板。扩展保存在挂载目录中，容器重建后仍保留。

`customNodesDir` 与 `frontendExtensionsDir` 二选一。如果沿用前端目录方式，目录同样必须是 **dsh 可写、容器可见** 的持久化挂载路径，不能直接填写容器内的 `/usr/local/...` 路径。

如果 Windows 无法直接访问挂载目录，也可在该目录手动创建 `dsh-comfyui-bridge/__init__.py`：

```python
WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
```

再将插件中的 `comfy-extension.js` 复制为 `dsh-comfyui-bridge/web/loader.js`，重启 ComfyUI。从 dsh 面板打开时会自动取得桥接地址，无需编辑脚本。手动安装完成并连接后，可忽略宿主的“尚未配置”日志提示。

</details>

## 使用

### 1. 启动并打开

1. 先启动 ComfyUI。
2. 启动 `dsh web`，打开 `http://127.0.0.1:3080`。
3. 进入对话，点击右上角 **ComfyUI**。

![ComfyUI 嵌入 dsh 右侧面板](docs/images/comfyui-panel.png)

左边聊需求，右边改节点、看预览。手动编辑和 AI 操作都落在当前工作流上。

### 2. 确认连接地址

默认连接 `http://127.0.0.1:8188`。如果更换了端口，打开 **MCP 设置**，修改地址后点击 **保存并连接**。

![连接地址与 MCP 开关](docs/images/comfyui-settings.png)

MCP 默认开启，dsh 已自动接入。这里也能关闭 MCP，或复制配置给其他本机 AI 客户端使用。

### 3. 让 AI 操作工作流

直接在当前对话里告诉 AI：

> 读取当前工作流，优化正向提示词，保留现有模型和节点连接，生成一张图并查看效果。

![AI 修改提示词并生成图片](docs/images/comfyui-ai-preview.png)

提示词直接写入当前节点，右侧查看生成预览，左侧查看出图结果。AI 做了哪些修改，画布上实时可见。

通过插件提交生成后，图片和视频会自动显示在发起任务的回复正文下方，不需要 AI 额外调用显示工具；收起工具过程后仍可查看。
多张图片同样按原比例显示，空间不够时自动换行，不会缩成小方块。
同一路图片同时接标准保存和 Preview 节点时，对话只展示保存版；不同分支的图片和只有 Preview 的结果仍正常展示。
已有历史结果也可以让 AI「用插件显示这个图片或视频」。

也可以直接说「列出工作流标签页，切换到 XXX」，或「复制当前工作流，另开一个叫测试的标签页」。已保存的工作流也能打开或复制，源工作流和未保存修改会保留。

更多操作直接在对话里说：

- 「用我刚上传的参考图做图生图，填入图片节点。」
- 「加一个放大节点，接到输出前面。」
- 「保存当前工作流」，或「另存为视频测试」。另存遇到同名文件会提示换名称。
- 「列出修改快照，恢复到这次修改之前。」撤销、重做和快照在同一浏览器刷新后仍可使用；最多保留 20 份，实际数量受浏览器存储空间限制。
- 「查看我的生成任务，取消还没开始的那一个。」排队任务可按任务取消；中断正在生成的任务会影响整个实例当前生成。

生成完成会自动通知原对话，正在进行的回复不会被强行中断。
极简预设也支持完成通知：缺少后台任务控制器时，插件会在当前会话内自动启用，无需手改配置。
插件重启会恢复原任务跟踪和结果；原对话的 AI 恢复运行后，会重新接上尚未送达的完成通知，不会重复提交生成。

想撤销就说「撤销刚才的修改」。界面大小用顶部 `− / +` 调整，点击 **刷新** 可重新加载 ComfyUI。

顶部 **图片对话中模糊** 开关默认关闭，同时适用于视频。开启后，点击模糊图先显示清晰图片，再点可查看大图；视频先解除模糊，再用播放按钮播放。鼠标悬停时，左上角的灰色小眼睛可切换模糊/清晰。关闭开关后，不出现模糊提示和小眼睛。只影响本插件返回到对话中的图片和视频，开关会记住。

## 友情链接

[LINUX DO](https://linux.do/) · [插件介绍帖](https://linux.do/t/topic/3009797)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mangfufu/dsh-comfyui-web&type=Date)](https://www.star-history.com/?repos=mangfufu%2Fdsh-comfyui-web&type=date)
