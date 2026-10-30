import { createRoot } from "react-dom/client";
import type { VoiceLevels, VoiceNotice, VoiceSnapshot } from "@opensteer/client/voice";
import { Composer } from "./components/composer.js";
import {
  VoiceButton,
  VoiceContext,
  VoiceDock,
  VoiceIsland,
  type VoiceControls,
} from "./components/voice.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";

const params = new URLSearchParams(location.search);
const layout = params.get("layout") ?? "docked";
const state = params.get("state") ?? "listening";
const level = Number(params.get("level") ?? "0.55");

const notices: Record<string, VoiceNotice> = {
  "permission-denied": {
    kind: "permission-denied",
    message: "Allow microphone access to talk to Opensteer.",
    action: "open-settings",
  },
  ended: { kind: "ended", message: "Voice moved to another device.", action: null },
};
const base: VoiceSnapshot = {
  available: true,
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  since: Date.now() - 42_000,
  notice: null,
};
const snapshots: Record<string, Partial<VoiceSnapshot>> = {
  idle: { since: null },
  connecting: { phase: "connecting" },
  listening: { phase: "listening" },
  hearing: { phase: "hearing", heard: "Show me the flight booking" },
  "hearing-long": {
    phase: "hearing",
    heard:
      "Can you find a table for four at Nopa on Friday around seven thirty and check with me before you book it",
  },
  thinking: { phase: "thinking", heard: "Book a table for four at Nopa on Friday" },
  speaking: {
    phase: "speaking",
    spoken: "Nopa has a table for four at seven thirty on Friday. Want me to book it?",
  },
  muted: { phase: "listening", muted: true },
  "permission-denied": { since: null, notice: notices["permission-denied"]! },
  ended: { since: null, notice: notices.ended! },
};
let snapshot: VoiceSnapshot = { ...base, ...snapshots[state] };
const listeners = new Set<() => void>();
const set = (next: Partial<VoiceSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
};
const controller: VoiceControls = {
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,
  subscribeLevel: (listener: (levels: VoiceLevels) => void) => {
    if (params.has("live")) {
      const started = performance.now();
      const timer = setInterval(() => {
        const t = (performance.now() - started) / 1000;
        const wave = Math.abs(Math.sin(t * 5.3) * Math.sin(t * 1.7));
        listener({ input: wave, output: wave });
      }, 100);
      return () => clearInterval(timer);
    }
    listener({ input: level, output: level });
    return () => {};
  },
  start: async () => {
    set({ phase: "connecting", since: Date.now(), notice: null });
    setTimeout(() => set({ phase: "listening" }), 900);
  },
  stop: () => set({ phase: "idle", since: null, heard: null, spoken: null, muted: false }),
  setMuted: (muted) => set({ muted }),
  dismissNotice: () => set({ notice: null }),
  openMicrophoneSettings: () => {},
};

function Messages() {
  return (
    <div className="voice-visual__messages">
      <p className="voice-visual__mine">Can you book a table for four at Nopa on Friday?</p>
      <p className="voice-visual__theirs">
        I’ll find a table for four at Nopa on Friday and check with you before booking.
      </p>
    </div>
  );
}

function Fixture() {
  if (layout === "float")
    return (
      <div className="app-shell__main voice-visual__float">
        <div className="voice-visual__page">
          <div className="voice-visual__toolbar">en.wikipedia.org</div>
          <h1>Your reading list</h1>
        </div>
        <VoiceIsland />
      </div>
    );
  return (
    <main className={`voice-visual__chat${layout === "phone" ? " voice-visual__chat--phone" : ""}`}>
      <header className="voice-visual__header">Chat</header>
      <Messages />
      <div className="voice-visual__composer">
        <VoiceDock />
        <VoiceIsland />
        <Composer
          onSend={async () => {}}
          placeholder="Ask Opensteer…"
          variant="conversation"
          voice={<VoiceButton />}
        />
      </div>
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; background: var(--bg); }
  .voice-visual__chat { display: flex; flex-direction: column; height: 100vh; max-width: 900px; margin: 0 auto; padding: 0 24px; box-sizing: border-box; }
  .voice-visual__chat--phone { padding: 0 12px; }
  .voice-visual__header { padding: 18px 0; color: var(--text); font-weight: 600; }
  .voice-visual__messages { flex: 1; display: flex; flex-direction: column; gap: 16px; justify-content: flex-end; padding-bottom: 24px; max-width: var(--transcript-max-width); width: 100%; margin: 0 auto; }
  .voice-visual__messages p { margin: 0; padding: 12px 16px; border-radius: 18px; font-size: var(--text-2xl); line-height: 1.5; max-width: 80%; }
  .voice-visual__mine { align-self: flex-end; background: #e6beb0; color: var(--ink-on-ember); }
  .voice-visual__theirs { background: var(--surface-elevated); color: var(--text); }
  .voice-visual__composer { padding-bottom: 20px; }
  .voice-visual__float { height: 100vh; background: #f4f2ee; }
  .voice-visual__page { height: 100%; color: #222; padding: 0 40px; }
  .voice-visual__toolbar { margin: 12px -28px 32px; padding: 8px 16px; border-radius: 12px; background: #1a1a1a; color: var(--text-soft); font-size: 13px; }
`;
document.head.append(style);

createRoot(document.getElementById("root")!).render(
  <VoiceContext value={controller}>
    <Fixture />
  </VoiceContext>,
);
