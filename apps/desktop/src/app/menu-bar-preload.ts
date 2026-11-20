import { contextBridge, ipcRenderer } from "electron";
import {
  MenuBarStatusSchema,
  MenuBarSwitchInputSchema,
  type OpensteerMenuBarBridge,
} from "@opensteer/client/computers";
import { z } from "zod";
import { menuBarChannels, menuBarPopoverUrl } from "./menu-bar-channels.js";

const bridge: OpensteerMenuBarBridge = Object.freeze<OpensteerMenuBarBridge>({
  status: async () => MenuBarStatusSchema.parse(await ipcRenderer.invoke(menuBarChannels.status)),
  onStatus: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, status: unknown) => {
      listener(MenuBarStatusSchema.parse(status));
    };
    ipcRenderer.on(menuBarChannels.statusChanged, receive);
    return () => {
      ipcRenderer.removeListener(menuBarChannels.statusChanged, receive);
    };
  },
  setSwitch: async (input) => {
    await ipcRenderer.invoke(menuBarChannels.setSwitch, MenuBarSwitchInputSchema.parse(input));
  },
  stop: async () => {
    await ipcRenderer.invoke(menuBarChannels.stop);
  },
  resume: async () => {
    await ipcRenderer.invoke(menuBarChannels.resume);
  },
  setOpenAtLogin: async (on) => {
    await ipcRenderer.invoke(menuBarChannels.setOpenAtLogin, z.boolean().parse(on));
  },
  openApp: async () => {
    await ipcRenderer.invoke(menuBarChannels.openApp);
  },
  quitCompletely: async () => {
    await ipcRenderer.invoke(menuBarChannels.quitCompletely);
  },
});
// The popover window loads only this document; any other gets no bridge.
if (window.location.href === menuBarPopoverUrl)
  contextBridge.exposeInMainWorld("opensteerMenuBar", bridge);
