import { DictationController } from "@opensteer/client/dictation";
import type { DictationPort } from "@opensteer/protocol/dictation";

export function installDictation(port: DictationPort | undefined): DictationController | null {
  if (!port) return null;
  const controller = new DictationController({ port, createId: () => crypto.randomUUID() });
  const refresh = () => {
    if (document.visibilityState !== "hidden") void controller.refresh();
  };
  void controller.refresh();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener(
    "pagehide",
    () => {
      controller.dispose();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    },
    { once: true },
  );
  return controller;
}
