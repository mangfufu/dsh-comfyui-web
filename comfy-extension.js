import { app } from '../../scripts/app.js';
app.registerExtension({
  name: 'dsh.ComfyUI.LiveBridge',
  async setup() {
    async function connect() {
      if (window.__DSH_COMFYUI_BRIDGE_ACTIVE__) return;
      const configured = new URLSearchParams(location.search).get('dsh_bridge');
      const bridgeBase = configured || (typeof __DSH_DEFAULT_BRIDGE__ === 'string' ? __DSH_DEFAULT_BRIDGE__ : null);
      // A portable custom_nodes copy has no default on ordinary ComfyUI pages.
      // The dsh panel supplies dsh_bridge; standalone pages can safely do nothing.
      if (!bridgeBase) return;
      try {
        const response = await fetch(bridgeBase + '/__dsh_comfyui/bootstrap');
        if (!response.ok) throw new Error('Bridge unavailable');
        window.__DSH_COMFYUI_BOOTSTRAP__ = await response.json();
        const script = document.createElement('script');
        script.src = bridgeBase + '/__dsh_comfyui/bridge.js';
        script.onerror = () => setTimeout(connect, 3000);
        document.head.appendChild(script);
      } catch { setTimeout(connect, 3000); }
    }
    connect();
  }
});
