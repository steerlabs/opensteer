import { contextBridge, ipcRenderer } from "electron";
import {
  DesktopAutofillSceneSchema,
  type OpensteerAutofillPopupBridge,
} from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import { autofillChoiceSchema, autofillMeasurementSchema } from "./autofill-state.js";

const bridge: OpensteerAutofillPopupBridge = Object.freeze<OpensteerAutofillPopupBridge>({
  onScene: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, scene: unknown) =>
      listener(DesktopAutofillSceneSchema.nullable().parse(scene));
    ipcRenderer.on(desktopBridgeChannels.autofillScene, receive);
    return () => {
      ipcRenderer.removeListener(desktopBridgeChannels.autofillScene, receive);
    };
  },
  measured: (input) =>
    ipcRenderer.send(
      desktopBridgeChannels.autofillMeasured,
      autofillMeasurementSchema.parse(input),
    ),
  choose: (input) =>
    ipcRenderer.send(desktopBridgeChannels.autofillChoose, autofillChoiceSchema.parse(input)),
});
contextBridge.exposeInMainWorld("opensteerAutofill", bridge);
