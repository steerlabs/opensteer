import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { VoiceLevels, VoiceNotice, VoiceSnapshot } from "@opensteer/client/voice";
import { Composer } from "./components/composer.js";
import { VoiceContext } from "@opensteer/client/react";
import {
  VoiceButton,
  VoiceClock,
  VoiceDock,
  VoiceIsland,
  VoiceMark,
  type VoiceControls,
} from "./components/voice.js";
import { useVoiceCursor } from "./components/voice-cursor.js";
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
  ended: { kind: "ended", message: "The voice call ended.", action: null },
};
const base: VoiceSnapshot = {
  available: true,
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  since: Date.now() - 42_000,
  activity: null,
  tasks: 0,
  ask: null,
  notice: null,
};
const snapshots: Record<string, Partial<VoiceSnapshot>> = {
  idle: { since: null },
  connecting: { phase: "connecting", since: null },
  listening: { phase: "listening" },
  hearing: { phase: "hearing", heard: "Open my reading list" },
  "hearing-long": {
    phase: "hearing",
    heard:
      "Can you find a table for four at Nopa on Friday around seven thirty and check with me before you book it",
  },
  thinking: { phase: "thinking", heard: "Book a table for four at Nopa on Friday" },
  "working-browser": {
    phase: "thinking",
    heard: "Open my reading list",
    activity: "browser",
  },
  "working-task": { phase: "thinking", heard: "What's left on the launch task?", activity: "list" },
  "working-integration": {
    phase: "thinking",
    heard: "Anything new from Maya in Gmail?",
    activity: "puzzle",
  },
  shown: { phase: "listening", heard: "Open my reading list" },
  speaking: {
    phase: "speaking",
    spoken: "Nopa has a table for four at seven thirty on Friday. Want me to book it?",
  },
  muted: { phase: "listening", muted: true },
  "muted-speaking": { phase: "speaking", muted: true, spoken: "It's open." },
  tasks: { phase: "listening", tasks: 2 },
  "tasks-hearing": { phase: "hearing", heard: "Which ones are still running?", tasks: 3 },
  ask: { phase: "listening" },
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
  // `state=shown` glints once the island is drawn, as when the agent opens something.
  subscribeShown: (listener) => {
    if (state !== "shown") return () => {};
    const timer = setTimeout(listener, 300);
    return () => clearTimeout(timer);
  },
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
  openThread: async () => "thr_visual",
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

/** A turn of a call, token by token, so a trace can see what one really costs. */
function playTurn() {
  const heard = "Book a table for four at Nopa on Friday around seven thirty".split(" ");
  const spoken = "Nopa has a table for four at seven thirty. Want me to book it?".split(" ");
  const beats: (() => void)[] = [
    ...heard.map(
      (_, index) => () =>
        set({ phase: "hearing", heard: heard.slice(0, index + 1).join(" "), spoken: null }),
    ),
    () => set({ phase: "thinking" }),
    ...spoken.map(
      (_, index) => () =>
        set({ phase: "speaking", heard: null, spoken: spoken.slice(0, index + 1).join(" ") }),
    ),
    () => set({ phase: "listening", spoken: null }),
  ];
  let beat = 0;
  const timer = setInterval(() => {
    beats[beat % beats.length]!();
    beat += 1;
  }, 90);
  return () => clearInterval(timer);
}

const ask = (
  <div className="voice-ask voice-visual__ask">
    <strong>Book for 7:30?</strong>
    <span>Say yes, or tap</span>
  </div>
);

/** The sidebar a show's cursor flies to. `?glide=<row>` runs one, as a call's show would. */
function Rows() {
  return (
    <aside className="voice-visual__sidebar">
      <div data-voice-row="chat">Chat</div>
      <div>
        <VoiceMark /> Voice <VoiceClock />
      </div>
      <h2>Tasks</h2>
      <div data-voice-row="nopa">Nopa reservation</div>
      <div data-voice-row="friday">Friday plans</div>
      <div>Weekend weather</div>
    </aside>
  );
}

function Fixture() {
  const cursor = useVoiceCursor();
  const played = useRef(false);
  useEffect(() => {
    if (params.has("turn")) return playTurn();
    const glide = params.get("glide");
    if (!glide || played.current) return undefined;
    played.current = true;
    const fly = (row: string) =>
      cursor.show({ kind: "thread", threadId: row }, true, () => undefined);
    setTimeout(() => fly(glide), 400);
    if (params.has("again")) setTimeout(() => fly(params.get("again")!), 700);
    return undefined;
  });
  if (layout === "float")
    return (
      <div className="app-shell__main voice-visual__float">
        <div className="voice-visual__page">
          <div className="voice-visual__toolbar">en.wikipedia.org</div>
          <h1>Your reading list</h1>
        </div>
        <VoiceIsland ask={state === "ask" ? ask : undefined} />
      </div>
    );
  if (layout === "beside")
    return (
      <div className="voice-visual__beside">
        <Rows />
        <div className="voice-visual__page voice-visual__float">
          <div className="voice-visual__toolbar">en.wikipedia.org</div>
          <h1>Your reading list</h1>
        </div>
        <section className="voice-visual__dock">
          <Messages />
          <div className="voice-visual__composer">
            <VoiceDock />
            <VoiceIsland ask={state === "ask" ? ask : undefined} />
            <Composer
              onSend={async () => {}}
              placeholder="Ask Opensteer…"
              variant="conversation"
              voice={<VoiceButton />}
            />
          </div>
        </section>
        {cursor.layer}
      </div>
    );
  const chat = (
    <main className={`voice-visual__chat${layout === "phone" ? " voice-visual__chat--phone" : ""}`}>
      <header className="voice-visual__header">Chat</header>
      <Messages />
      <div className="voice-visual__composer">
        <VoiceDock />
        <VoiceIsland ask={state === "ask" ? ask : undefined} />
        <Composer
          onSend={async () => {}}
          placeholder="Ask Opensteer…"
          variant="conversation"
          voice={<VoiceButton />}
        />
      </div>
    </main>
  );
  return layout === "shell" ? (
    <div className="voice-visual__shell">
      <Rows />
      {chat}
      {cursor.layer}
    </div>
  ) : (
    chat
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
  .voice-visual__shell { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
  .voice-visual__beside { display: grid; grid-template-columns: 240px 1fr 360px; height: 100vh; }
  .voice-visual__dock { display: flex; flex-direction: column; min-width: 0; padding: 0 12px; }
  .voice-visual__dock .voice-visual__messages p { font-size: var(--text-lg); }
  .voice-visual__sidebar { display: flex; flex-direction: column; gap: 2px; padding: 16px 10px; background: var(--surface); color: var(--text-soft); font-size: var(--text-md); }
  .voice-visual__sidebar > div { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; }
  .voice-visual__sidebar h2 { margin: 12px 8px 4px; color: var(--muted); font-size: var(--text-xs); font-weight: 500; }
  .voice-visual__ask { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; color: var(--text); font-size: var(--text-md); }
  .voice-visual__ask span { color: var(--muted); }
  .voice-visual__toolbar { margin: 12px -28px 32px; padding: 8px 16px; border-radius: 12px; background: #1a1a1a; color: var(--text-soft); font-size: 13px; }
`;
document.head.append(style);

createRoot(document.getElementById("root")!).render(
  <VoiceContext value={controller}>
    <Fixture />
  </VoiceContext>,
);
