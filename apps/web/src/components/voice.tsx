import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { DictationController } from "@opensteer/client/dictation";
import type { HostClient } from "@opensteer/client/host";
import {
  VoiceController,
  type VoiceControllerInput,
  type VoiceLevels,
  type VoicePhase,
  type VoiceSnapshot,
  type VoiceTarget,
} from "@opensteer/client/voice";
import { createBrowserVoiceMediaPort } from "../voice/media-port.js";
import { Icon } from "./icon.js";

/** What the voice UI drives: the runtime's one `VoiceController`. */
export interface VoiceControls {
  subscribe(listener: () => void): () => void;
  getSnapshot(): VoiceSnapshot;
  subscribeLevel(listener: (levels: VoiceLevels) => void): () => void;
  start(): Promise<void>;
  stop(): unknown;
  setMuted(muted: boolean): void;
  dismissNotice(): void;
  openMicrophoneSettings?(): void;
}

export const VoiceContext = createContext<VoiceControls | null>(null);

/**
 * The runtime's one voice controller for this Host. Navigation goes through a
 * ref so the controller outlives re-renders; starting voice ends dictation,
 * keeping its words, so only one thing holds the microphone.
 */
export function useVoiceRuntime(
  hostClient: HostClient,
  navigate: (target: VoiceTarget) => void,
  dictation: DictationController | null,
  places?: VoiceControllerInput["places"],
): VoiceController | null {
  const latest = useRef({ navigate, dictation, places });
  latest.current = { navigate, dictation, places };
  const [controller, setController] = useState<VoiceController | null>(null);
  useEffect(() => {
    const created = new VoiceController({
      hostClient,
      media: createBrowserVoiceMediaPort(),
      navigate: (target) => latest.current.navigate(target),
      createId: () => crypto.randomUUID(),
      places: () => latest.current.places?.() ?? Promise.resolve([]),
      onStart: async () => {
        const dictating = latest.current.dictation;
        const owner = dictating?.getSnapshot().owner;
        if (dictating && owner) await dictating.stop(owner);
      },
    });
    setController(created);
    return () => {
      created.dispose();
      setController(null);
    };
  }, [hostClient]);
  return controller;
}

const idle: VoiceSnapshot = {
  available: false,
  phase: "idle",
  muted: false,
  heard: null,
  spoken: null,
  since: null,
  notice: null,
};
const noSubscribe = () => () => {};
const idleSnapshot = () => idle;

export function useVoice() {
  const controller = useContext(VoiceContext);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? idleSnapshot,
  );
  return { controller, snapshot };
}

const labels: Record<VoicePhase, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening",
  thinking: "Working on it",
  speaking: "Speaking",
};

/** The composer's way in: starts voice, or ends the call it started. */
export function VoiceButton() {
  const { controller, snapshot } = useVoice();
  if (!controller || (!snapshot.available && snapshot.phase === "idle")) return null;
  const on = snapshot.phase !== "idle";
  return (
    <button
      aria-label={on ? "End voice" : "Talk to Opensteer"}
      aria-pressed={on}
      className={`composer__attach composer__voice${on ? " composer__voice--on" : ""}`}
      onClick={() => (on ? void controller.stop() : void controller.start())}
      title={on ? "End voice" : "Talk to Opensteer"}
      type="button"
    >
      {snapshot.phase === "connecting" ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <Icon name="waveform" />
      )}
    </button>
  );
}

/**
 * Where the voice bar sits while a composer is on screen: just above it, never
 * over it. With no dock mounted, the bar floats at the bottom of the main area.
 */
const docks: HTMLElement[] = [];
const dockListeners = new Set<() => void>();
const dockStore = {
  subscribe(listener: () => void) {
    dockListeners.add(listener);
    return () => dockListeners.delete(listener);
  },
  current: () => docks.at(-1) ?? null,
};
function changeDocks(change: () => void) {
  change();
  for (const listener of dockListeners) listener();
}

export function VoiceDock() {
  const element = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (element.current) {
      const previous = element.current;
      changeDocks(() => docks.splice(docks.indexOf(previous), 1));
    }
    element.current = node;
    if (node) changeDocks(() => docks.push(node));
  }, []);
  return <div className="voice-dock" ref={attach} />;
}

/** The live voice bar: on whenever a call is, wherever the person goes. */
export function VoiceIsland() {
  const { controller, snapshot } = useVoice();
  const dock = useSyncExternalStore(dockStore.subscribe, dockStore.current, () => null);
  if (!controller || (snapshot.phase === "idle" && !snapshot.notice)) return null;
  const island = <Island controller={controller} snapshot={snapshot} docked={dock !== null} />;
  return dock ? createPortal(island, dock) : <div className="voice-float">{island}</div>;
}

function Island({
  controller,
  snapshot,
  docked,
}: {
  controller: VoiceControls;
  snapshot: VoiceSnapshot;
  docked: boolean;
}) {
  const { phase, notice, muted } = snapshot;
  const className = `voice-island${docked ? " voice-island--docked" : ""}`;
  if (phase === "idle" && notice)
    return (
      <section aria-label="Voice" className={`${className} voice-island--notice`} role="alert">
        <Icon name="alert-circle" />
        <span className="voice-island__notice">{notice.message}</span>
        {notice.action === "open-settings" && controller.openMicrophoneSettings ? (
          <button
            className="btn btn--small"
            onClick={() => controller.openMicrophoneSettings?.()}
            type="button"
          >
            Open Settings
          </button>
        ) : null}
        <button
          aria-label="Dismiss"
          className="voice-island__button"
          onClick={() => controller.dismissNotice()}
          type="button"
        >
          <Icon name="close" />
        </button>
      </section>
    );
  const caption =
    phase === "hearing"
      ? snapshot.heard
      : phase === "speaking"
        ? snapshot.spoken
        : phase === "thinking"
          ? snapshot.heard
          : null;
  return (
    <section aria-label="Voice" className={className} data-phase={phase} data-muted={muted}>
      <span className="visually-hidden" role="status" aria-live="polite">
        {muted ? "Microphone muted" : labels[phase]}
      </span>
      <Orb controller={controller} phase={phase} muted={muted} />
      <div className="voice-island__text" aria-hidden="true">
        <span className="voice-island__label">
          {muted && phase !== "connecting" ? "Muted" : labels[phase]}
        </span>
        <Caption text={caption} />
      </div>
      <button
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={muted}
        className={`voice-island__button${muted ? " voice-island__button--on" : ""}`}
        disabled={phase === "connecting"}
        onClick={() => controller.setMuted(!muted)}
        title={muted ? "Unmute" : "Mute"}
        type="button"
      >
        <Icon name={muted ? "microphone-off" : "microphone"} />
      </button>
      <button
        className="voice-island__end"
        onClick={() => void controller.stop()}
        title="End voice"
        type="button"
      >
        End
      </button>
    </section>
  );
}

/**
 * Loudness moves the orb without re-rendering: each level writes one CSS
 * variable, and the stylesheet turns it into scale and glow.
 */
function Orb({
  controller,
  phase,
  muted,
}: {
  controller: VoiceControls;
  phase: VoicePhase;
  muted: boolean;
}) {
  const orb = useRef<HTMLSpanElement | null>(null);
  const listening = useRef({ phase, muted });
  listening.current = { phase, muted };
  useEffect(
    () =>
      controller.subscribeLevel(({ input, output }) => {
        const { phase: now, muted: silent } = listening.current;
        const level = now === "speaking" ? output : silent ? 0 : input;
        orb.current?.style.setProperty("--level", Math.min(1, Math.max(0, level)).toFixed(3));
      }),
    [controller],
  );
  return <span className="voice-orb" ref={orb} aria-hidden="true" />;
}

/** One line of live words, showing the newest when they overflow. */
function Caption({ text }: { text: string | null }) {
  const line = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    element.scrollLeft = element.scrollWidth;
    element.dataset.overflow = String(element.scrollWidth > element.clientWidth);
  }, [text]);
  if (!text) return null;
  return (
    <span className="voice-island__caption" ref={line}>
      {text}
    </span>
  );
}
