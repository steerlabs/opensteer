import { contextBridge } from "electron";
import { installBrowserPagePolicy } from "@opensteer/browser-runtime-core/page-policy";

// Browser Session pages receive no Electron API: this sandboxed preload only
// installs the page policy in the main world before the page's scripts run.
contextBridge.executeInMainWorld({ func: installBrowserPagePolicy });
