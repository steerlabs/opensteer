import { z } from "zod";
import { contextBridge } from "electron";
import {
  installBrowserPagePolicy,
  type BrowserPagePolicyConfig,
} from "@opensteer/browser-runtime-core/page-policy";

// Browser Session pages receive no Electron API: this sandboxed preload only
// installs the page policy in the main world before the page's scripts run.
const argument = process.argv.find((value) => value.startsWith("--opensteer-passkey-provider="));
let config: BrowserPagePolicyConfig;
if (argument) {
  try {
    config = z
      .object({
        bindingName: z.string().regex(/^opensteerPasskey_[a-f0-9]{64}$/u),
        replyName: z.string().regex(/^opensteerReply_[a-f0-9]{64}$/u),
      })
      .parse(JSON.parse(argument.slice("--opensteer-passkey-provider=".length)));
  } catch {
    /* Invalid preload configuration keeps the absent policy. */
  }
}
contextBridge.executeInMainWorld({ func: installBrowserPagePolicy, args: [config] });
