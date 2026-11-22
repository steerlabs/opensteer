import { useShell } from "../app-shell.js";
import { ConnectChrome } from "./connect-chrome.js";
import { useShellChromeEnvironment } from "./use-shell-chrome-environment.js";

/**
 * Adding Chrome as a device: the Chrome profile a person already uses, connected here so they
 * can share its tabs. Add a device › Chrome and the first run's "Connect your Chrome" both open
 * this one panel. It speaks only to this Opensteer, so it needs no Opensteer account, and it
 * reads or pairs nothing until it is opened.
 */
export function AddChrome() {
  const { hostClient } = useShell();
  const environment = useShellChromeEnvironment();
  return (
    <div className="add-device__panel" data-testid="add-chrome">
      <p>Share tabs from the Chrome you already use. Connect it, then choose a tab to share.</p>
      <ConnectChrome client={hostClient} compact environment={environment} />
    </div>
  );
}
