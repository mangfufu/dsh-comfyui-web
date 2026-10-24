# dsh-comfyui-web

[简体中文](README.md) | [English](README.en.md)

Use ComfyUI inside dsh and let AI operate your current workflow through MCP. Edit prompts, adjust parameters and generate images without switching tabs. Watch node changes and generation previews in the same page.

## Installation

Requires [dsh](https://github.com/deepseek-ai/deepseek-harness), pnpm, a local ComfyUI installation, and Node.js 22 or later.

| Plugin version | Supported dsh versions |
| --- | --- |
| `0.5.13`–`0.5.18` | `0.2.0-rc.2`, `0.2.1-rc.2` |
| `0.5.12` | `0.2.0-rc.2` |

Both `engines.dsh` and the DSH peer dependencies declare the verified host versions, supporting compatibility checks in both host releases. Other DSH versions need separate validation. If a host upgrade reports an incompatibility, update the plugin first.

```sh
dsh plugin --profile web add github:mangfufu/dsh-comfyui-web
```

### Launch local ComfyUI from DSH (Windows)

When only DSH is running, the ComfyUI panel shows local launch controls. Use **Auto-detect**, **Choose folder / Choose launch file** to open the Windows file picker, or enter an absolute path. Supported entries include any named `.exe` launcher, `.bat` / `.cmd` / `.ps1` script, `.lnk` shortcut, and a ComfyUI directory / `main.py`. No launcher brand or adjacent ComfyUI source tree is required.

- **Start ComfyUI directly** uses the installation's own Python (AKi, Windows portable bundles, or a local `.venv` / `venv`), with the panel's loopback address and port. The panel connects when the server is ready.
- **Use a launcher or script** uses your own launcher, script or shortcut. If it opens a launcher window, click Start there. Shortcuts retain their target arguments and working directory. Match the server address and port to the panel settings; DSH connects when ComfyUI is ready.

Auto-detection checks configured paths, common installation locations and likely launch filenames. Manually selected files can have any name; selecting a folder lists its launch files. Detection never runs programs. Starting saves the entry and configures the bridge only when a ComfyUI installation is identified; standalone launchers preserve existing bridge settings. An already running or starting service is not started again. Logs go to `~/.dsh/comfyui/launch.log`; shortcut targets manage their own logs. PowerShell scripts follow the machine's execution policy; check the log if they fail. Direct launch does not read third-party launcher arguments. Remote and Docker services must be started in their own environment.

<a id="comfyui-extension-install"></a>

<details>
<summary>First installation: configure the ComfyUI frontend directory</summary>

Create or edit `~/.dsh/comfyui/config.json`. Replace the example frontend directory with the actual path on your computer. On Windows, `~` is your user directory; on Linux, use the actual installation path as well.

```json
{
  "url": "http://127.0.0.1:8188",
  "frontendExtensionsDir": "D:/ComfyUI/python/Lib/site-packages/comfyui_frontend_package/static/extensions"
}
```

After installation or an update, save your workflows, then refresh both the original ComfyUI page and the panel inside dsh.

If the directory is missing or not writable, **Connection settings** and the dsh startup log explain the problem. Seeing the ComfyUI page is not enough: wait for **AI connected** before asking AI to operate it.

</details>

<details>
<summary>ComfyUI in Docker / WSL</summary>

Use a persistent mounted `custom_nodes` directory. Edit `~/.dsh/comfyui/config.json` on the system running dsh:

```json
{
  "url": "http://127.0.0.1:8188",
  "customNodesDir": "/mnt/data/ai/comfyui/storage-nodes/custom_nodes"
}
```

This is a Linux path example. **If dsh runs on Windows, enter a path Windows can write to**, such as `D:/ComfyUI/custom_nodes`, or the shared directory of your actual WSL distribution, such as `//wsl.localhost/Ubuntu/mnt/data/ai/comfyui/storage-nodes/custom_nodes`.

Make sure the host directory is mounted into the container's `custom_nodes`, for example:

```yaml
volumes:
  - /mnt/data/ai/comfyui/storage-nodes/custom_nodes:/root/ComfyUI/custom_nodes
```

Starting dsh creates the `dsh-comfyui-bridge` extension. Save your workflows, restart ComfyUI and refresh the dsh panel. The extension remains in the mounted directory when the container is recreated.

Set either `customNodesDir` or `frontendExtensionsDir`. With the frontend-directory approach, the directory must also be a **persistent mounted path writable by dsh and visible to the container**. Do not enter a container-only `/usr/local/...` path when dsh runs on the host.

If Windows cannot directly access the mounted directory, manually create `dsh-comfyui-bridge/__init__.py` there:

```python
WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
```

Copy the plugin's `comfy-extension.js` to `dsh-comfyui-bridge/web/loader.js`, then restart ComfyUI. Opening ComfyUI from the dsh panel supplies the bridge address automatically; no script editing is needed. Once the manual installation is connected, you can disregard the host's “not configured” log message.

</details>

## Usage

### 1. Start and open

1. Start ComfyUI.
2. Run `dsh web` and open `http://127.0.0.1:3080`.
3. Open a conversation and click **ComfyUI** at the top right.

![ComfyUI embedded in the dsh side panel](docs/images/comfyui-panel.png)

Discuss your request on the left; edit nodes and watch previews on the right. Manual edits and AI actions operate on the current workflow.

The plugin follows dsh's interface language and supports Chinese and English. Change the language in dsh's language settings. ComfyUI keeps its own language setting.

### 2. Check the connection URL

The default URL is `http://127.0.0.1:8188`. If you use another port, open **Connection settings**, update the URL and click **Save and connect**.

![Connection URL and MCP switch](docs/images/comfyui-settings.png)

MCP is enabled by default, and dsh connects automatically. You can turn MCP off here or copy the configuration for another local AI client.

### 3. Ask AI to operate the workflow

Send a request in the current conversation, for example:

> Read the current workflow, improve the positive prompt, keep the existing model and node connections, generate one image and inspect the result.

![AI editing a prompt and generating an image](docs/images/comfyui-ai-preview.png)

Prompts are written into the current nodes. Watch the generation preview on the right and see the results in the conversation on the left. AI edits are visible on the canvas as they happen.

For large workflows, AI reads a structural summary first and retrieves node values as needed to save conversation context.

Images and videos from tasks submitted through the plugin appear automatically below the reply that started them. They remain visible when tool details are collapsed. Multiple images keep their aspect ratio and wrap onto another row when needed.

If the same image feeds both a standard save node and a Preview node, the conversation shows the saved version once. Separate branches and preview-only results are still shown. To display an older result, ask AI to “show this image or video using the plugin.”

You can also say “list the workflow tabs and switch to XXX” or “duplicate this workflow in a new tab named Test.” Saved workflows can be opened or copied while preserving the source workflow and its unsaved changes.

More examples:

- “Use the reference image I just uploaded for image-to-image generation and put it in the image node.”
- “Add an upscaler node before the output and connect it.”
- “Save this workflow” or “save a copy as Video Test.” Existing names are not overwritten when saving a copy.
- “List edit snapshots and restore the version before this change.” Undo, redo and snapshots survive a refresh in the same browser. Up to 20 snapshots are kept, subject to browser storage limits.
- “Show my generation tasks and cancel the one that has not started.” Queued tasks can be cancelled individually. Interrupting a running generation affects the current generation of the whole ComfyUI instance.

Completion automatically notifies the original conversation without forcibly interrupting an ongoing reply. If you manually stop generation in ComfyUI, AI receives an interruption notice and the plugin blocks resubmission from that conversation until you send a new message. To resume, explicitly ask AI to continue generating.

The minimal agent preset supports completion notifications too, without manual configuration. Restarting the plugin restores task tracking and results; pending notifications reconnect when the original AI conversation resumes, without submitting another generation.

Ask “undo the last change” to undo an AI edit. Use the top **− / +** buttons to scale the interface, or **Refresh** to reload ComfyUI.

**Blur chat media** is off by default and covers both images and videos. When enabled, clicking a blurred image reveals it; clicking again opens the original. Reveal a video before using its playback controls. Hover over an item to use the grey eye icon at the top left to toggle its blur. Turning the main switch off hides the blur hints and eye buttons. This setting is remembered and only affects images and videos returned by this plugin.

## Friends

[LINUX DO](https://linux.do/)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=mangfufu/dsh-comfyui-web&type=Date)](https://www.star-history.com/?repos=mangfufu%2Fdsh-comfyui-web&type=date)
