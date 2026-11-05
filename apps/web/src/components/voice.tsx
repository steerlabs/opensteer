import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useVoice } from "@opensteer/client/react";
import type { DictationController } from "@opensteer/client/dictation";
import type { HostClient } from "@opensteer/client/host";
import {
  VoiceController,
  voiceBar,
  type VoiceControllerInput,
  type VoiceControls,
  type VoicePhase,
  type VoiceSnapshot,
} from "@opensteer/client/voice";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { createBrowserVoiceMediaPort } from "../voice/media-port.js";
import { Icon } from "./icon.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/**
 * The runtime's one voice controller for this Host. What is on screen is read
 * through a ref so the controller outlives re-renders; starting voice ends
 * dictation, keeping its words, so only one thing holds the microphone.
 */
export function useVoiceRuntime(
  hostClient: HostClient,
  dictation: DictationController | null,
  currentView: NonNullable<VoiceControllerInput["currentView"]>,
): VoiceController | null {
  const latest = useRef({ dictation, currentView });
  latest.current = { dictation, currentView };
  const [controller, setController] = useState<VoiceController | null>(null);
  useEffect(() => {
    const created = new VoiceController({
      hostClient,
      media: createBrowserVoiceMediaPort(),
      createId: () => crypto.randomUUID(),
      currentView: () => latest.current.currentView(),
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

export type { VoiceControls };

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
  const workspace = useOptionalWorkspace();
  const element = useRef<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    if (element.current) {
      const previous = element.current;
      changeDocks(() => docks.splice(docks.indexOf(previous), 1));
    }
    element.current = node;
    if (node) changeDocks(() => docks.push(node));
  }, []);
  // A conversation put away beside a place stays mounted, so its dock would hide the call.
  if (workspace?.work && !workspace.phone && !workspace.dock.open) return null;
  return <div className="voice-dock" ref={attach} />;
}

/**
 * The live voice bar: on whenever a call is, wherever the person goes. What
 * needs them during the call rides on it, so it follows them too.
 */
export function VoiceIsland({ ask }: { readonly ask?: ReactNode }) {
  const { controller, snapshot } = useVoice();
  const dock = useSyncExternalStore(dockStore.subscribe, dockStore.current, () => null);
  if (!controller || (snapshot.phase === "idle" && !snapshot.notice)) return null;
  const island = (
    <>
      {ask}
      <Island controller={controller} snapshot={snapshot} docked={dock !== null} />
    </>
  );
  return dock ? createPortal(island, dock) : <VoiceFloat>{island}</VoiceFloat>;
}

/**
 * The bar with no composer to dock above. A desktop tab is a native view drawn
 * over this page, so the bar claims real space and the tab shrinks to leave it.
 */
function VoiceFloat({ children }: { readonly children: ReactNode }) {
  const element = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const float = element.current;
    if (!float) return;
    const root = document.documentElement;
    const claim = () =>
      root.style.setProperty("--voice-reserve", `${Math.ceil(float.offsetHeight) + 28}px`);
    const stop = observeResize([float], claim);
    claim();
    return () => {
      stop();
      root.style.removeProperty("--voice-reserve");
    };
  }, []);
  return (
    <div className="voice-float" ref={element}>
      {children}
    </div>
  );
}

/** Where a composer would be on the Voice Thread: the way in, then the call itself. */
export function VoiceStart({ controls }: { readonly controls: ReactNode }) {
  const { controller, snapshot } = useVoice();
  const idle = snapshot.phase === "idle";
  return (
    <div className="input-surface voice-slot">
      <VoiceDock />
      {idle ? (
        <div className="voice-start">
          <button
            className="voice-start__talk"
            disabled={!controller || !snapshot.available}
            onClick={() => void controller?.start()}
            type="button"
          >
            <Icon name="waveform" />
            Talk to Opensteer
          </button>
          {controls}
        </div>
      ) : null}
    </div>
  );
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
  const { phase, notice, muted, activity, tasks } = snapshot;
  const bar = voiceBar(snapshot);
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
  return (
    <section aria-label="Voice" className={className} data-phase={phase} data-muted={muted}>
      <Glow controller={controller} />
      <span className="visually-hidden" role="status" aria-live="polite">
        {bar.status}
      </span>
      <Orb controller={controller} phase={phase} muted={muted} activity={activity} />
      <div className="voice-island__text" aria-hidden="true">
        <Caption text={bar.words} live={bar.live} />
      </div>
      {tasks > 0 ? (
        <span className="voice-island__tasks">
          <span aria-hidden="true" className="spinner" />
          {tasks === 1 ? "1 task" : `${tasks} tasks`}
        </span>
      ) : null}
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

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * When the agent opens something, the screen changing is the answer; the
 * island only glints once to say it was the call. Web Animations run on the
 * compositor and never re-render React.
 */
function Glow({ controller }: { controller: VoiceControls }) {
  const glow = useRef<HTMLSpanElement | null>(null);
  useEffect(
    () =>
      controller.subscribeShown?.(() => {
        const element = glow.current;
        if (typeof element?.animate !== "function") return;
        const still = reducedMotion();
        // Easing per keyframe: a quick rise to the peak, then a long settle.
        const rise = "cubic-bezier(0.3, 0, 0.2, 1)";
        const settle = "cubic-bezier(0.4, 0, 0.6, 1)";
        element.animate(
          still
            ? [
                { opacity: 0, easing: rise },
                { opacity: 0.8, offset: 0.3, easing: settle },
                { opacity: 0 },
              ]
            : [
                { opacity: 0, transform: "scale(0.985)", easing: rise },
                { opacity: 1, transform: "scale(1)", offset: 0.22, easing: settle },
                { opacity: 0, transform: "scale(1.03)" },
              ],
          { duration: still ? 500 : 950 },
        );
        if (still) return;
        element.parentElement
          ?.querySelector(".voice-orb__body")
          ?.animate(
            [
              { transform: "scale(1)", easing: rise },
              { transform: "scale(1.18)", offset: 0.3, easing: "cubic-bezier(0.34, 1.3, 0.5, 1)" },
              { transform: "scale(1)" },
            ],
            { duration: 560 },
          );
      }),
    [controller],
  );
  return <span className="voice-island__glow" ref={glow} aria-hidden="true" />;
}

/**
 * The orb is the call's face. Loudness moves it without re-rendering: each
 * level writes one CSS variable, and the stylesheet turns it into scale and
 * glow. A ring circles it while the agent works, holding the glyph of the
 * step it is taking.
 */
function Orb({
  controller,
  phase,
  muted,
  activity,
}: {
  controller: VoiceControls;
  phase: VoicePhase;
  muted: boolean;
  activity: VoiceSnapshot["activity"];
}) {
  const orb = useRef<HTMLSpanElement | null>(null);
  const listening = useRef({ phase, muted });
  listening.current = { phase, muted };
  useEffect(
    () =>
      controller.subscribeLevel(({ input, output }) => {
        const { phase: now, muted: silent } = listening.current;
        const level = now === "speaking" ? output : silent || now === "thinking" ? 0 : input;
        orb.current?.style.setProperty("--level", Math.min(1, Math.max(0, level)).toFixed(3));
      }),
    [controller],
  );
  return (
    <span className="voice-orb" ref={orb} aria-hidden="true">
      <span className="voice-orb__halo" />
      <span className="voice-orb__ring" />
      <span className="voice-orb__body">
        <span className="voice-orb__core" />
        {activity ? (
          <span className="voice-orb__glyph" key={activity}>
            <Icon name={activity} />
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** One line of live words, showing the newest when they overflow. */
function Caption({ text, live }: { text: string | null; live: boolean }) {
  const line = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    element.scrollLeft = element.scrollWidth;
    element.dataset.overflow = String(element.scrollWidth > element.clientWidth);
  }, [text]);
  if (!text) return null;
  return (
    <span className="voice-island__caption" data-live={live} ref={line}>
      {text}
    </span>
  );
}
