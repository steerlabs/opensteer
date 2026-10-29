import { contextBridge, ipcRenderer } from "electron";
import { DesktopGlassSceneSchema, type OpensteerGlassBridge } from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";

const bridge: OpensteerGlassBridge = Object.freeze<OpensteerGlassBridge>({
  onScene: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, scene: unknown) => {
      listener(DesktopGlassSceneSchema.nullable().parse(scene));
    };
    ipcRenderer.on(desktopBridgeChannels.glassScene, receive);
    return () => {
      ipcRenderer.removeListener(desktopBridgeChannels.glassScene, receive);
    };
  },
});
contextBridge.exposeInMainWorld("opensteerGlass", bridge);
