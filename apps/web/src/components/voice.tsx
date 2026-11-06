import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { VoiceContext, useVoiceValue } from "@opensteer/client/react";
import type { DictationController } from "@opensteer/client/dictation";
import type { HostClient } from "@opensteer/client/host";
import {
  VoiceController,
  callClock,
  heldWords,
  voiceBar,
  voiceCursorPath,
  type VoiceControllerInput,
  type VoiceControls,
  type VoiceNotice,
  type VoiceSnapshot,
} from "@opensteer/client/voice";
import { observeResize } from "@opensteer/shared/resizeObserver";
import { createBrowserVoiceMediaPort } from "../voice/media-port.js";
import { FoldRow, FoldToFit } from "./fold-to-fit.js";
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

const selectPhase = ({ phase }: VoiceSnapshot) => phase;
const selectMuted = ({ muted }: VoiceSnapshot) => muted;
const selectActivity = ({ activity }: VoiceSnapshot) => activity;
const selectTasks = ({ tasks }: VoiceSnapshot) => tasks;
const selectNotice = ({ notice }: VoiceSnapshot) => notice;
const selectSince = ({ since }: VoiceSnapshot) => since;
const selectAvailable = ({ available }: VoiceSnapshot) => available;
const selectShowing = ({ notice, phase }: VoiceSnapshot) => phase !== "idle" || notice !== null;
const selectStatus = (snapshot: VoiceSnapshot) => voiceBar(snapshot).status;
const selectSpeaker = (snapshot: VoiceSnapshot) => voiceBar(snapshot).speaker;
const selectWords = (snapshot: VoiceSnapshot) => voiceBar(snapshot).words;
const selectTone = (snapshot: VoiceSnapshot) => voiceBar(snapshot).tone;

/** The composer's way in: starts voice, or ends the call it started. */
export function VoiceButton() {
  const controller = useContext(VoiceContext);
  const phase = useVoiceValue(selectPhase);
  const available = useVoiceValue(selectAvailable);
  if (!controller || (!available && phase === "idle")) return null;
  const on = phase !== "idle";
  return (
    <button
      aria-label={on ? "End voice" : "Talk to Opensteer"}
      aria-pressed={on}
      className={`composer__attach composer__voice${on ? " composer__voice--on" : ""}`}
      onClick={() => (on ? void controller.stop() : void controller.start())}
      title={on ? "End voice" : "Talk to Opensteer"}
      type="button"
    >
      {phase === "connecting" ? (
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

/** `hidden`: what is around this dock keeps it off screen, as a phone's closed sheet does. */
export function VoiceDock({ hidden = false }: { readonly hidden?: boolean }) {
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
  if (hidden || (workspace?.work && !workspace.phone && !workspace.dock.open)) return null;
  return <div className="voice-dock" ref={attach} />;
}

/**
 * The live voice bar: on whenever a call is, wherever the person goes. What
 * needs them during the call rides on it, so it follows them too.
 */
export function VoiceIsland({ ask }: { readonly ask?: ReactNode }) {
  const controller = useContext(VoiceContext);
  const showing = useVoiceValue(selectShowing);
  const dock = useSyncExternalStore(dockStore.subscribe, dockStore.current, () => null);
  if (!controller || !showing) return null;
  const island = (
    <>
      {ask}
      <Island controller={controller} docked={dock !== null} />
    </>
  );
  return dock ? createPortal(island, dock) : <VoiceFloat>{island}</VoiceFloat>;
}

/** The air around the floating pill, above and below; `.voice-float` holds half of it beneath. */
const floatAir = 20;

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
      root.style.setProperty("--voice-reserve", `${Math.ceil(float.offsetHeight) + floatAir}px`);
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
export function VoiceStart({
  controls,
  dockHidden,
}: {
  readonly controls: ReactNode;
  readonly dockHidden: boolean;
}) {
  const controller = useContext(VoiceContext);
  const idle = useVoiceValue(selectPhase) === "idle";
  const available = useVoiceValue(selectAvailable);
  return (
    <div className="input-surface voice-slot">
      <VoiceDock hidden={dockHidden} />
      {idle ? (
        <FoldToFit className="voice-start">
          <button
            className="voice-start__talk"
            disabled={!controller || !available}
            onClick={() => void controller?.start()}
            type="button"
          >
            <Icon name="waveform" />
            Talk to Opensteer
          </button>
          <FoldRow className="voice-start__settings">{controls}</FoldRow>
        </FoldToFit>
      ) : null}
    </div>
  );
}

/** The cursor's arrow: the call's mark on the pill and on the move. */
export function VoiceMark({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className ? `voice-mark ${className}` : "voice-mark"}
      viewBox="0 0 16 18"
    >
      <path d={voiceCursorPath} />
    </svg>
  );
}

/** The call's length, owning its own tick so only these digits redraw each second. */
export function VoiceClock() {
  const since = useVoiceValue(selectSince);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  if (since === null) return null;
  return <span className="voice-clock">{callClock(now - since)}</span>;
}

/**
 * Keeps the pill as wide as its words. The lane never changes size: `--voice-cut`
 * is how far the plate's left edge sits in from the lane's, and the stylesheet
 * turns it into transforms. An observer reads sizes after layout, so a token
 * never forces one. Within one person's turn the pill only grows.
 */
function usePillFit(turn: string | null) {
  const lane = useRef<HTMLElement | null>(null);
  const room = useRef<HTMLDivElement | null>(null);
  const words = useRef<HTMLDivElement | null>(null);
  const held = useRef(0);
  const fit = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    const [pill, lanes, line] = [lane.current, room.current, words.current];
    if (!pill || !lanes || !line) return;
    fit.current = () => {
      const width = line.offsetWidth;
      held.current = heldWords(width, held.current, false);
      const cut = Math.max(0, lanes.clientWidth - held.current);
      pill.style.setProperty("--voice-cut", `${cut}px`);
      lanes.dataset.overflow = String(width > lanes.clientWidth);
    };
    fit.current();
    const stop = observeResize([lanes, line], () => fit.current());
    // The first fit places the pill; only what follows it glides.
    const settle = requestAnimationFrame(() => (pill.dataset.fit = "true"));
    return () => {
      cancelAnimationFrame(settle);
      stop();
      fit.current = () => undefined;
    };
  }, []);
  useLayoutEffect(() => {
    held.current = 0;
    fit.current();
  }, [turn]);
  return { lane, room, words };
}

function Island({ controller, docked }: { controller: VoiceControls; docked: boolean }) {
  const phase = useVoiceValue(selectPhase);
  const notice = useVoiceValue(selectNotice);
  if (phase === "idle" && notice)
    return <Notice controller={controller} docked={docked} notice={notice} />;
  return <Pill controller={controller} docked={docked} />;
}

function Notice({
  controller,
  docked,
  notice,
}: {
  controller: VoiceControls;
  docked: boolean;
  notice: VoiceNotice;
}) {
  return (
    <section
      aria-label="Voice"
      className={`voice-notice${docked ? " voice-notice--docked" : ""}`}
      role="alert"
    >
      <Icon name="alert-circle" />
      <span className="voice-notice__text">{notice.message}</span>
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
}

/**
 * The pill. Each fact is read alone, so a caption's tokens redraw only `Words`.
 * Nothing in it scales: the plate slides out from under the controls, and the
 * words are wiped into view by a window that moves with the plate's edge.
 */
function Pill({ controller, docked }: { controller: VoiceControls; docked: boolean }) {
  const phase = useVoiceValue(selectPhase);
  const muted = useVoiceValue(selectMuted);
  const tasks = useVoiceValue(selectTasks);
  const status = useVoiceValue(selectStatus);
  const speaker = useVoiceValue(selectSpeaker);
  const { lane, room, words } = usePillFit(speaker);
  return (
    <section
      aria-label="Voice"
      className={`voice-island${docked ? " voice-island--docked" : ""}`}
      data-muted={muted}
      data-phase={phase}
      data-speaker={speaker ?? "none"}
      ref={lane}
    >
      <span className="voice-island__plate" aria-hidden="true">
        <span className="voice-island__fill">
          <Glow controller={controller} />
        </span>
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">
        {status}
      </span>
      <Mark controller={controller} />
      <div className="voice-island__room" aria-hidden="true" ref={room}>
        <div className="voice-island__window">
          <Words line={words} />
        </div>
      </div>
      <div className="voice-island__rest">
        <VoiceClock />
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
          aria-label="End"
          className="voice-island__button voice-island__end"
          onClick={() => void controller.stop()}
          title="End"
          type="button"
        >
          <Icon name="close" />
        </button>
      </div>
    </section>
  );
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * When the agent opens something, the screen changing is the answer; the
 * pill only glints once to say it was the call. Web Animations run on the
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
        element.animate(
          [
            { opacity: 0, easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
            { opacity: still ? 0.8 : 1, offset: 0.25, easing: "cubic-bezier(0.4, 0, 0.6, 1)" },
            { opacity: 0 },
          ],
          { duration: still ? 500 : 900 },
        );
        if (still) return;
        element
          .closest(".voice-island")
          ?.querySelector(".voice-cursor")
          ?.animate(
            [
              { scale: 1, easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
              { scale: 1.22, offset: 0.3, easing: "cubic-bezier(0.34, 1.3, 0.5, 1)" },
              { scale: 1 },
            ],
            { duration: 460 },
          );
      }),
    [controller],
  );
  return <span className="voice-island__glow" ref={glow} />;
}

/**
 * The cursor is the call's face: its color says who is talking, and loudness
 * moves it without re-rendering. Each level writes one CSS variable, and the
 * stylesheet turns it into scale. The three colors are stacked and cross-fade,
 * since opacity stays on the compositor and color does not.
 */
function Mark({ controller }: { controller: VoiceControls }) {
  const phase = useVoiceValue(selectPhase);
  const muted = useVoiceValue(selectMuted);
  const cursor = useRef<HTMLSpanElement | null>(null);
  const listening = useRef({ phase, muted });
  listening.current = { phase, muted };
  useEffect(
    () =>
      controller.subscribeLevel(({ input, output }) => {
        const { phase: now, muted: silent } = listening.current;
        const level = now === "speaking" ? output : silent || now === "thinking" ? 0 : input;
        cursor.current?.style.setProperty("--level", Math.min(1, Math.max(0, level)).toFixed(3));
      }),
    [controller],
  );
  return (
    <span className="voice-island__mark" aria-hidden="true">
      <span className="voice-cursor" ref={cursor}>
        <VoiceMark className="voice-cursor__quiet" />
        <VoiceMark className="voice-cursor__person" />
        <VoiceMark className="voice-cursor__opensteer" />
      </span>
    </span>
  );
}

/**
 * The one line that changes with every token. It hangs from its right edge, so
 * the newest words stay in view with nothing to scroll. The last words stay
 * through their fade, out of the flow so the plate can close over them.
 */
function Words({ line }: { readonly line: React.RefObject<HTMLDivElement | null> }) {
  const words = useVoiceValue(selectWords);
  const tone = useVoiceValue(selectTone);
  const activity = useVoiceValue(selectActivity);
  const last = useRef(words);
  if (words !== null) last.current = words;
  return (
    <div className="voice-island__words" ref={line}>
      {activity ? (
        <span className="voice-island__activity" key={activity}>
          <Icon name={activity} />
        </span>
      ) : null}
      {last.current === null ? null : (
        <span className="voice-island__caption" data-gone={words === null} data-tone={tone}>
          {last.current}
        </span>
      )}
    </div>
  );
}
