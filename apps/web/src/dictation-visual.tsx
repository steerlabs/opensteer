import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { DictationController } from "@opensteer/client/dictation";
import type { DictationEvent, DictationPort, DictationError } from "@opensteer/protocol/dictation";
import { Composer } from "./components/composer.js";
import { DictationContext } from "./components/dictation.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";

const scenario = new URLSearchParams(location.search).get("state") ?? "idle";
const errors: readonly DictationError[] = [
  "permission-denied",
  "busy",
  "microphone-unavailable",
  "model-unavailable",
  "download-failed",
  "recognition-failed",
  "service-unavailable",
];
let receive: (event: DictationEvent) => void = () => {};
let session = "";
let seq = 0;
let limit: (() => void) | undefined;
const emit = (
  event:
    | Omit<Extract<DictationEvent, { type: "ended" }>, "session" | "seq">
    | { type: "listening" }
    | { type: "text"; finalized: string[]; volatile: string[] }
    | { type: "downloading"; progress: number }
    | { type: "level"; level: number },
) => receive({ ...event, session, seq: ++seq } as DictationEvent);
const port: DictationPort = {
  availability: async () => ({
    available: true,
    languageName: "English",
    locale: "en-US",
    model: scenario === "downloading" || scenario === "downloaded" ? "download" : "installed",
    microphone: scenario === "permission-denied" ? "denied" : "granted",
  }),
  subscribe: (listener) => {
    receive = listener;
    return () => {};
  },
  start: async (id) => {
    session = id;
  },
  download: async (id) => {
    session = id;
  },
  stop: async () => {},
  cancel: async () => {},
  openMicrophoneSettings: async () => {},
};
const controller = new DictationController({
  port,
  createId: () => crypto.randomUUID(),
  setTimer: (callback, ms) => {
    if (ms === 600_000) limit = callback;
    return setTimeout(callback, ms);
  },
});
await controller.refresh();
function Fixture() {
  useEffect(() => {
    const drive = setTimeout(() => {
      const field = document.querySelector("textarea")!;
      field.setSelectionRange(13, 13);
      if (scenario !== "idle")
        document.querySelector<HTMLButtonElement>('[title="Dictate"]')!.click();
      if (scenario === "downloading") emit({ type: "downloading", progress: 0.42 });
      else if (scenario === "downloaded") emit({ type: "ended", reason: "completed", error: null });
      else if (scenario !== "idle" && scenario !== "starting" && scenario !== "permission-denied") {
        emit({ type: "listening" });
        if (scenario !== "empty")
          emit({
            type: "text",
            finalized: ["the latest design"],
            volatile: scenario === "listening" ? ["with Maya"] : [],
          });
        if (scenario === "finishing") void controller.stop();
        else if (scenario === "limit") {
          limit?.();
          emit({ type: "ended", reason: "completed", error: null });
        } else if (scenario === "empty") emit({ type: "ended", reason: "completed", error: null });
        else if (scenario === "interrupted" || scenario === "device-changed")
          emit({ type: "ended", reason: scenario, error: null });
        else if (errors.includes(scenario as DictationError))
          emit({ type: "ended", reason: "failed", error: scenario as DictationError });
      }
      emit({ type: "level", level: 0.7 });
    }, 50);
    return () => clearTimeout(drive);
  }, []);
  return (
    <main style={{ width: "min(760px, 100%)", margin: "100px auto", padding: 24 }}>
      <p className="eyebrow">OPENSTEER · DICTATION</p>
      <h1 style={{ fontSize: 28, marginBottom: 40 }}>What’s on your mind?</h1>
      <DictationContext value={controller}>
        <Composer
          onSend={async () => {}}
          placeholder="Ask Opensteer…"
          restore={{ key: 1, text: "Please review before Friday." }}
          footerExtras={
            <span style={{ color: "var(--muted)", fontSize: 12 }}>Claude Opus 4.8</span>
          }
        />
      </DictationContext>
      <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 16 }}>
        On-device dictation · {scenario}
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
