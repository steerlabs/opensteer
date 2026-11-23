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
  const store =
    client.browserFrames?.editing ??
    new BrowserEditingStore((_session, _surface, command) => {
      if (!sendBaseline(command)) throw new Error("Browser input was refused.");
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
    dismissMenu: target.dismissMenu,
    fillAutofill: target.fillAutofill,
    answerPasswordSave: target.answerPasswordSave,
    clearPasswordSave: target.clearPasswordSave,
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
    /**
     * CZ6: the transport's own answer, now: a send it refused at once is false, so the proxy tells
     * the reducer (CY8) and the person is told.
     */
    send(operation: EditingOperation): boolean {
      if (!active) return false;
      const current = epoch;
      const { accepted, done } = target.submit(operation);
      if (!accepted) error("The page is reconnecting. Try again in a moment.");
      void done
        .then(async (result) => {
          if (!active || current !== epoch || !result) return;
          if (result.outcome === "copied" || result.outcome === "cut")
            await write(result.items, current);
          else if (result.outcome === "unknown")
            error(
              operation.kind === "cut"
                ? "May have been cut: check before cutting again."
                : "May have been pasted: check before pasting again.",
            );
          else if (!["empty", "pasted"].includes(result.outcome))
            error(`Clipboard ${result.outcome}.`);
        })
        // A send refused at once already said the page is reconnecting.
        .catch(() => {
          if (active && current === epoch && accepted) error("Editing unavailable.");
        });
      return accepted;
    },
  };
}
