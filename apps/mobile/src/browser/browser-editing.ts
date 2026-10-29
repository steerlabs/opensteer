import type { EditingOperation } from "@opensteer/client/editing";
import { BrowserEditingStore, type BrowserCommand } from "@opensteer/client/host";
import type { MobileClipboardPort } from "../../modules/remote-text-input/src/clipboard.js";

/** The shared transport owns negotiation, legacy projection and clipboard assembly. */
export function createMobileBrowserEditing(
  client: { readonly browserFrames?: { readonly editing?: BrowserEditingStore } },
  session: string,
  surface: string,
  sendBaseline: (command: BrowserCommand) => boolean,
  clipboard: MobileClipboardPort,
) {
  let active = false;
  let epoch = 0;
  let error: (message: string) => void = () => undefined;
  let admitted = true;
  const store =
    client.browserFrames?.editing ??
    new BrowserEditingStore((_session, _surface, command) => {
      if (!sendBaseline(command)) {
        admitted = false;
        error("The page is reconnecting. Try again in a moment.");
        throw new Error("Browser input was refused.");
      }
    });
  const target = store.target(session, surface);
  const write = async (items: Parameters<MobileClipboardPort["write"]>[0], current: number) => {
    if (!active || current !== epoch) return;
    const outcome = await clipboard.write(items);
    if (active && current === epoch && outcome !== "written" && outcome !== "empty")
      error(`Clipboard ${outcome}.`);
  };
  return {
    get: target.get,
    subscribe: target.subscribe,
    activate(onError: (message: string) => void) {
      active = true;
      const current = ++epoch;
      error = onError;
      const stop = target.activate((items) => {
        void write(items, current);
      }, onError);
      return () => {
        active = false;
        epoch++;
        stop();
      };
    },
    send(operation: EditingOperation): boolean {
      if (!active) return false;
      admitted = true;
      const current = epoch;
      void target
        .send(operation)
        .then(async (result) => {
          if (!active || current !== epoch || !result) return;
          if (result.outcome === "copied" || result.outcome === "cut")
            await write(result.items, current);
          else if (!["empty", "pasted"].includes(result.outcome))
            error(`Clipboard ${result.outcome}.`);
        })
        .catch((reason: unknown) => {
          if (active && current === epoch)
            error(reason instanceof Error ? reason.message : "Editing unavailable.");
        });
      return admitted;
    },
  };
}
