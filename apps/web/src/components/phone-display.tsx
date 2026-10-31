import { StreamedContextMenu } from "./browser/streamed-context-menu.js";
import type { DisplayClientDiagnostic } from "@opensteer/protocol";
import { reportDisplayDiagnostic, displayDiagnosticSource } from "../display-diagnostics.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type { NativeViewerSource, HostClient, HostSnapshot } from "@opensteer/client/host";
import {
  DisplayEditingSession,
  displayEditingAbilities,
  computerDisplayScope,
  computerDisplayStatus,
  sharedDisplayStreams,
  type DisplayLease,
  type DisplaySnapshot,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import {
  RemoteEditingProxy,
  type RemoteEditingProxyHandle,
  type RemoteCaretPosition,
} from "./remote-editing/remote-editing-proxy.js";
import type { EditingContext } from "@opensteer/protocol/editing";
import { Icon } from "./icon.js";
import {
  PhoneDisplayInput,
  committedInput,
  editKey,
  type DisplayKey,
  fittedPicture,
  pictureFraction,
  wheelFraction,
} from "./phone-display-input.js";
import {
  knownPhoneDisplayDecoding,
  phoneDisplayDecoding,
  retainPhoneDisplayPicture,
  type PhoneDisplayPicture,
  type PhoneDisplayPictureState,
} from "./phone-display-media.js";

/** A phone's usual shape, held by the empty picture box until the stream says. */
const defaultRatio = "9 / 19.5";

const idleSnapshot: DisplaySnapshot = {
  connection: "connecting",
  closeCode: null,
  display: null,
  input: "unavailable",
  power: "unavailable",
  keyframeFailed: false,
};
const idlePicture: PhoneDisplayPictureState = {
  shown: null,
  stale: false,
  generation: 0,
  waitingForKey: true,
};
const noStore = {
  getSnapshot: () => undefined,
  subscribe: () => () => undefined,
};

/** One view's live display of a phone session, and its owner's hold on the phone. */
export interface ComputerDisplayView {
  /** Why nothing current is shown, in the shared Watch words (`computerWatchStatus`). */
  readonly reason: ReturnType<typeof computerDisplayStatus>["reason"] | "decoder-unsupported";
  readonly retrying: boolean;
  /** A picture is shown that may lag the phone: the stream restarts, or awaits a keyframe. */
  readonly startingWords: string;
  readonly viewportEnabled: boolean;
  /** The picture on the canvases, or null. */
  readonly picture: PhoneDisplayPictureState["shown"];
  readonly snapshot: DisplaySnapshot;
  /** The stream's geometry generation, which navigation is sent in. */
  readonly generation: number;
  /**
   * The geometry pointer input is sent in: the shown picture's, while it is
   * the stream's current one and live. Null refuses input against a picture
   * the phone has moved on from.
   */
  readonly geometry: number | null;
  readonly lease: DisplayLease | null;
  readonly media: PhoneDisplayPicture | null;
  reopen(): void;
  /** This view's input when input is available. */
  readonly input: PhoneDisplayInput | null;
  readonly editing: DisplayEditingSession | null;
  readonly editingContext: EditingContext | null;
  readonly receipt: string | null;
}

/**
 * Holds the computer's live display while enabled: decoder support is asked
 * before any socket opens, the socket and decoder are shared with other views
 * of the session, and disabling — a hidden page, an unmount — ends any stroke,
 * resets input and lets go of both.
 */
export function useComputerDisplay({
  enabled,
  disabledReason = "disabled",
  hostClient,
  source,
  streamable,
  macWindow,
}: {
  readonly enabled: boolean;
  readonly disabledReason?: DisplayClientDiagnostic["reason"] | undefined;
  readonly hostClient: HostClient;
  readonly source: NativeViewerSource | null;
  /** The phone's app can stream; one that cannot is asked to update. */
  readonly streamable: boolean;
  readonly macWindow: boolean;
}): ComputerDisplayView {
  const [decoding, setDecoding] = useState(knownPhoneDisplayDecoding);
  useEffect(() => {
    if (!enabled || !streamable || decoding !== undefined) return;
    let current = true;
    void phoneDisplayDecoding().then((answer) => {
      if (current) setDecoding(answer);
    });
    return () => {
      current = false;
    };
  }, [decoding, enabled, streamable]);

  const selectScope = useCallback(
    (snapshot: HostSnapshot) => computerDisplayScope(snapshot, source),
    [
      source?.kind,
      source?.kind === "task-session" ? source.sessionId : source?.viewId,
      source?.kind === "owner-view" ? source.generation : (source?.appKey ?? null),
    ],
  );
  const scope = useHostSelector(hostClient, selectScope);
  const [held, setHeld] = useState<{
    readonly lease: DisplayLease;
    readonly media: PhoneDisplayPicture;
    readonly editing: DisplayEditingSession;
  } | null>(null);
  const [input, setInput] = useState<PhoneDisplayInput | null>(null);
  // Bumped when the Host invalidates this scope, so a scope that comes back
  // unchanged in the same batch still gets a fresh socket.
  const [generation, setGeneration] = useState(0);
  const sourceKey = source ? JSON.stringify(source) : null;
  const pictureOwner = useRef<{
    hostClient: HostClient;
    scope: string | null;
    sourceKey: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    const previous = pictureOwner.current;
    if (
      previous &&
      (previous.hostClient !== hostClient ||
        previous.scope !== scope ||
        previous.sourceKey !== sourceKey)
    )
      held?.media.clear();
    pictureOwner.current = { hostClient, scope, sourceKey };
  }, [hostClient, scope, sourceKey, held?.media]);
  const lease = held?.lease ?? null;
  const snapshot = useSyncExternalStore(
    lease?.subscribe ?? noStore.subscribe,
    lease?.getSnapshot ?? noStore.getSnapshot,
  );
  const pictureState = useSyncExternalStore(
    held?.media.subscribe ?? noStore.subscribe,
    held?.media.getSnapshot ?? noStore.getSnapshot,
  );
  const editing = held?.editing ?? null;
  const editingState = useSyncExternalStore(
    editing?.subscribe ?? noStore.subscribe,
    editing?.getSnapshot ?? noStore.getSnapshot,
  );
  const holding = snapshot?.input === "available";

  // Declared before the socket's effect so its cleanup runs first: a stroke
  // ends before input is reset.
  useEffect(() => {
    if (!enabled || !holding || !lease) return;
    const controller = new PhoneDisplayInput({
      send: (geometry, events) => {
        if (lease.getSnapshot().display?.editingVersion === 1 && editing)
          void editing.input(geometry, events).catch(() => undefined);
        else lease.input(geometry, events);
      },
      requestFrame: (callback) => {
        const request = requestAnimationFrame(callback);
        return () => cancelAnimationFrame(request);
      },
    });
    const cancel = () => {
      controller.cancel(performance.now());
      lease.resetInput();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    setInput(controller);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
      controller.dispose(performance.now());
      lease.resetInput();
      setInput(null);
    };
  }, [enabled, holding, lease, editing]);

  const diagnosticInputs = useRef({ enabled, disabledReason, hostClient, scope, sourceKey });
  useLayoutEffect(() => {
    diagnosticInputs.current = { enabled, disabledReason, hostClient, scope, sourceKey };
  });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || !streamable || !scope || !source || !decoding) return;
    const streams = sharedDisplayStreams(hostClient, reportDisplayDiagnostic);
    const target = { scope, source, editing: 1 as const };
    const current = streams.retain(target);
    const shared = retainPhoneDisplayPicture(streams, target, decoding);
    reportDisplayDiagnostic({
      transition: "retain",
      reason: "visible",
      ...displayDiagnosticSource(source),
    });
    const editing = new DisplayEditingSession(current);
    setHeld({ lease: current, media: shared.picture, editing });
    let invalidated = false;
    // The old login's socket closes with the Host's change, not React's next effect.
    const unsubscribe = hostClient.subscribe(() => {
      if (invalidated || computerDisplayScope(hostClient.getSnapshot(), source) === scope) return;
      invalidated = true;
      shared.picture.clear();
      streams.invalidate(
        (candidate) =>
          computerDisplayScope(hostClient.getSnapshot(), candidate.source) === candidate.scope,
      );
      setGeneration((value) => value + 1);
    });
    return () => {
      const next = diagnosticInputs.current;
      const reason = !mounted.current
        ? "unmount"
        : next.hostClient !== hostClient || next.sourceKey !== sourceKey
          ? "destination-changed"
          : !next.enabled
            ? next.disabledReason
            : invalidated || next.scope !== scope
              ? "source-invalidated"
              : "unavailable";
      reportDisplayDiagnostic({
        transition: "release",
        reason,
        ...displayDiagnosticSource(source),
      });
      unsubscribe();
      editing.dispose();
      current.resetInput();
      current.release();
      shared.release();
      setHeld(null);
    };
  }, [
    decoding,
    enabled,
    generation,
    hostClient,
    scope,
    source?.kind,
    source?.kind === "task-session" ? source.sessionId : source?.viewId,
    source?.kind === "owner-view" ? source.generation : (source?.appKey ?? null),
    streamable,
  ]);

  const display = snapshot ?? idleSnapshot;
  const media = pictureState ?? idlePicture;
  const streamGeneration = Math.max(display.display?.generation ?? 0, media.generation);
  useEffect(() => {
    input?.geometryChanged(streamGeneration);
  }, [input, streamGeneration]);

  const status = !streamable
    ? { reason: "unsupported" as const, retrying: false }
    : decoding === null
      ? { reason: "decoder-unsupported" as const, retrying: false }
      : computerDisplayStatus(display, !macWindow);
  // A picture kept through a reconnect stands in for the new one; once the
  // socket is open and none arrives, the words take over as for a first start.
  const awaiting = media.shown === null || (media.stale && display.connection === "open");
  const [startingSlow, setStartingSlow] = useState(false);
  useEffect(() => {
    setStartingSlow(false);
    if (!enabled || !awaiting) return;
    const timer = setTimeout(() => setStartingSlow(true), 5_000);
    return () => clearTimeout(timer);
  }, [enabled, awaiting]);
  const shown = media.stale && startingSlow ? null : media.shown;
  const geometry =
    shown &&
    !media.stale &&
    display.display?.state === "live" &&
    shown.generation === streamGeneration
      ? shown.generation
      : null;
  useLayoutEffect(() => editing?.setGeometry(geometry), [editing, geometry]);
  return {
    ...status,
    viewportEnabled: macWindow,
    reason:
      shown !== null && display.connection !== "closed" && status.reason === "display-failed"
        ? null
        : status.reason,
    startingWords: startingSlow
      ? "macOS is taking longer to start sharing this window."
      : "Starting window sharing…",
    picture: shown,
    snapshot: display,
    generation: streamGeneration,
    geometry,
    lease,
    reopen: () => {
      if (scope && source) sharedDisplayStreams(hostClient).reopen({ scope, source, editing: 1 });
    },
    media: held?.media ?? null,
    input,
    editing,
    editingContext: editingState?.context ?? null,
    receipt: editingState?.receipt ?? null,
  };
}

/**
 * The phone's screen: a canvas the shared decoder draws into. While this
 * view accepts input the canvas takes the owner's pointer, wheel and keys,
 * mapped into the picture drawn inside it; otherwise it is only a picture,
 * enlarged by pressing it when the view can enlarge.
 */
export function ComputerDisplayScreen({
  dim,
  display,
  interactive,
  label,
  onEnlarge,
  shown,
}: {
  readonly dim: boolean;
  readonly display: ComputerDisplayView;
  /** Input reaches the phone from here when input is available. */
  readonly interactive: boolean;
  readonly label: string;
  readonly onEnlarge: (() => void) | null;
  readonly shown: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const media = display.media;
  const input =
    interactive && shown && display.geometry !== null && display.snapshot.input === "available"
      ? display.input
      : null;
  const geometry = useRef(display.geometry);
  geometry.current = display.geometry;
  const pointer = useRef<number | null>(null);
  const clickCounts = useRef(new Map<string, number>());
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const pictureRef = useRef<HTMLSpanElement | null>(null);
  const proxy = useRef<RemoteEditingProxyHandle | null>(null);
  const negotiated = display.snapshot.display?.editingVersion === 1;
  const mac = display.viewportEnabled;
  const editingEnabled = input !== null && negotiated && shown && display.geometry !== null;
  const [menu, setMenu] = useState<{ left: number; top: number; contextId: string } | null>(null);
  const dismissMenu = useCallback(() => {
    setMenu(null);
    proxy.current?.focus();
  }, []);
  const [caret, setCaret] = useState<RemoteCaretPosition | null>(null);
  const wire = useMemo(
    () => ({
      send: (operation: Parameters<DisplayEditingSession["send"]>[0]) => {
        input?.flush();
        return display.editing
          ? display.editing.send(operation)
          : Promise.reject(new Error("Input unavailable."));
      },
    }),
    [display.editing, input],
  );
  const leave = () => {
    proxy.current?.cancel();
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && pictureRef.current?.contains(focused)) focused.blur();
    input?.cancel(performance.now());
    display.lease?.resetInput();
  };
  useEffect(() => {
    const reset = () => {
      proxy.current?.cancel();
      pointer.current = null;
      if (keyboardRef.current) keyboardRef.current.value = "";
    };
    const hide = () => {
      if (document.visibilityState === "hidden") reset();
    };
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", hide);
    return () => {
      reset();
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const at = display.editingContext?.caret;
      const rect = drawnPicture(canvas);
      const box = pictureRef.current?.getBoundingClientRect();
      setCaret(
        at && box
          ? {
              left: rect.left - box.left + at.x * rect.width,
              top: rect.top - box.top + at.y * rect.height,
              height: at.height * rect.height,
            }
          : null,
      );
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(canvas);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [display.editingContext, display.picture]);
  useLayoutEffect(
    () => () => {
      proxy.current?.cancel();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && pictureRef.current?.contains(focused)) focused.blur();
      input?.cancel(performance.now());
      display.lease?.resetInput();
    },
    [input, display.lease],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !media) return;
    return media.attach(canvas);
  }, [media]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (
      !display.viewportEnabled ||
      !canvas ||
      !display.lease ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const update = () => {
      const rect = canvas.getBoundingClientRect();
      display.lease?.viewport(Math.max(rect.width, rect.height) * window.devicePixelRatio);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [display.lease, display.viewportEnabled]);

  // A stroke this view started ends with it: the enlarged picture can close,
  // or input can become unavailable, while the finger is still down on the phone.
  useEffect(() => {
    if (!input) return;
    return () => {
      if (pointer.current === null) return;
      pointer.current = null;
      input.cancel(performance.now());
    };
  }, [input]);

  // Baseline phones retain their original committed-text path.
  useEffect(() => {
    const keyboard = keyboardRef.current;
    if (!keyboard || !input || negotiated) return;
    const type = (key: DisplayKey) => {
      const at = geometry.current;
      if (at !== null) input.key(at, key);
    };
    const beforeInput = (event: InputEvent) => {
      const edit = committedInput(event);
      if (edit === "compose") return;
      event.preventDefault();
      if (edit) type(edit);
    };
    const compositionEnd = (event: CompositionEvent) => {
      keyboard.value = "";
      if (event.data && document.activeElement === keyboard) type({ insert: event.data });
    };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain");
      if (text) type({ insert: text });
    };
    keyboard.addEventListener("beforeinput", beforeInput);
    keyboard.addEventListener("compositionend", compositionEnd);
    keyboard.addEventListener("paste", paste);
    return () => {
      keyboard.removeEventListener("beforeinput", beforeInput);
      keyboard.removeEventListener("compositionend", compositionEnd);
      keyboard.removeEventListener("paste", paste);
    };
  }, [input, negotiated]);

  // React's wheel listener is passive; the page must not scroll under the phone.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !input) return;
    const wheel = (event: WheelEvent) => {
      const at = geometry.current;
      const picture = drawnPicture(canvas);
      const point = pictureFraction({ x: event.clientX, y: event.clientY }, picture, false);
      if (at === null || !point) return;
      event.preventDefault();
      input.scroll(at, point, wheelFraction(event, picture));
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [input]);

  const end = (event: PointerEvent<HTMLCanvasElement>, phase: "up" | "cancel") => {
    if (!input || pointer.current !== event.pointerId) return;
    if (mac) {
      const at = geometry.current;
      const point = pictureFraction(
        { x: event.clientX, y: event.clientY },
        drawnPicture(event.currentTarget),
        true,
      );
      if (at !== null && point && phase === "up") {
        const up = mouseEvent(event, "up", point);
        input.mouse(at, { ...up, clickCount: clickCounts.current.get(up.button) ?? 1 });
        clickCounts.current.delete(up.button);
      } else input.cancel(event.timeStamp);
      if (!event.buttons || phase === "cancel") pointer.current = null;
      return;
    }
    pointer.current = null;
    if (phase === "cancel") {
      input.cancel(event.timeStamp);
      return;
    }
    const point = pictureFraction(
      { x: event.clientX, y: event.clientY },
      drawnPicture(event.currentTarget),
      true,
    );
    if (point) input.up(point, event.timeStamp);
    else input.cancel(event.timeStamp);
  };

  const ratio = display.picture
    ? `${display.picture.width} / ${display.picture.height}`
    : display.snapshot.display?.width && display.snapshot.display.height
      ? `${display.snapshot.display.width} / ${display.snapshot.display.height}`
      : defaultRatio;
  const canvas = (
    <canvas
      aria-hidden
      className={[
        "computer-watch__frame",
        "phone-display__canvas",
        dim ? "computer-watch__frame--dim" : "",
        input ? "phone-display__canvas--control" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onContextMenu={(event) => {
        if (input) event.preventDefault();
        const box = pictureRef.current?.getBoundingClientRect();
        if (editingEnabled && !mac && box && display.editingContext?.field)
          setMenu({
            left: event.clientX - box.left,
            top: event.clientY - box.top,
            contextId: display.editingContext.contextId,
          });
      }}
      onLostPointerCapture={(event) => end(event, "cancel")}
      onMouseDown={(event) => {
        const at = geometry.current;
        if (!mac || !input || at === null) return;
        const point = pictureFraction(
          { x: event.clientX, y: event.clientY },
          drawnPicture(event.currentTarget),
          false,
        );
        if (!point) return;
        event.preventDefault();
        proxy.current?.pointerDown();
        proxy.current?.focus();
        const down = mouseEvent(event, "down", point);
        clickCounts.current.set(down.button, down.clickCount ?? 1);
        input.mouse(at, down);
      }}
      onPointerCancel={(event) => end(event, "cancel")}
      onPointerDown={(event) => {
        const at = geometry.current;
        if (!input || at === null || !event.isPrimary) return;
        if (!mac && event.pointerType === "mouse" && event.button !== 0) return;
        const target = event.currentTarget;
        const point = pictureFraction(
          { x: event.clientX, y: event.clientY },
          drawnPicture(target),
          false,
        );
        if (!point) return;
        if (mac && event.pointerType === "mouse") {
          // Pointer detail is zero in browsers; the paired mousedown owns click count.
          target.setPointerCapture(event.pointerId);
          pointer.current = event.pointerId;
          return;
        }
        event.preventDefault();
        if (negotiated) {
          proxy.current?.pointerDown();
          proxy.current?.focus(event.pointerType === "touch");
        } else keyboardRef.current?.focus({ preventScroll: true });
        target.setPointerCapture(event.pointerId);
        pointer.current = event.pointerId;
        if (mac) {
          const down = mouseEvent(event, "down", point);
          clickCounts.current.set(down.button, down.clickCount ?? 1);
          input.mouse(at, down);
        } else input.down(at, point, event.timeStamp);
      }}
      onPointerMove={(event) => {
        if (!input || (!mac && pointer.current !== event.pointerId)) return;
        const point = pictureFraction(
          { x: event.clientX, y: event.clientY },
          drawnPicture(event.currentTarget),
          pointer.current === event.pointerId,
        );
        const at = geometry.current;
        if (point && mac && at !== null) input.mouse(at, mouseEvent(event, "move", point));
        else if (point) input.move(point, event.timeStamp);
      }}
      onPointerUp={(event) => end(event, "up")}
      ref={canvasRef}
    />
  );
  // The canvas stays mounted whether it is shown, enlargeable or controlled:
  // a new canvas would be blank until the next picture is drawn.
  return (
    <span
      className={
        shown ? "computer-watch__picture" : "computer-watch__picture phone-display__picture--hidden"
      }
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          proxy.current?.cancel();
          input?.cancel(performance.now());
          display.lease?.resetInput();
        }
      }}
      onKeyDown={(event) => {
        if (
          input &&
          event.key === "F6" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          leave();
        }
      }}
      ref={pictureRef}
      data-live-page={input ? "" : undefined}
      style={{ "--picture-ratio": ratio } as CSSProperties}
    >
      {canvas}
      {editingEnabled && !mac && menu && menu.contextId === display.editingContext?.contextId ? (
        <StreamedContextMenu
          left={menu.left}
          top={menu.top}
          editable={display.editingContext.field != null}
          selection={!display.editingContext.field?.sensitive}
          canCut={display.snapshot.display?.displayCut === 1}
          onDismiss={dismissMenu}
          onAction={(action) => {
            if (action === "copy" || action === "cut") proxy.current?.perform({ kind: action });
            else if (action === "paste") proxy.current?.pasteFromMenu();
            else if (action === "select-all")
              proxy.current?.perform({ kind: "command", command: "selectAll" });
            dismissMenu();
          }}
        />
      ) : null}
      {negotiated ? (
        <RemoteEditingProxy
          cancelCompositionOnBlur
          abilities={displayEditingAbilities}
          caret={caret}
          context={display.editingContext}
          enabled={editingEnabled}
          label={`Type on ${label}.`}
          onLeave={leave}
          ref={proxy}
          wire={wire}
        />
      ) : input ? (
        <textarea
          aria-label={`Type on ${label}.`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="phone-display__keyboard"
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            const at = geometry.current;
            const edit = editKey({
              key: event.key,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (at === null || !edit) return;
            event.preventDefault();
            input.key(at, edit);
          }}
          ref={keyboardRef}
          rows={1}
          spellCheck={false}
        />
      ) : null}
      {onEnlarge && shown && !input ? (
        <button
          aria-label={`Enlarge ${label}`}
          className="phone-display__enlarge"
          onClick={onEnlarge}
          title="Enlarge"
          type="button"
        />
      ) : null}
    </span>
  );
}

/** The picture drawn inside the canvas, fitted as its CSS fits it. */
function drawnPicture(canvas: HTMLCanvasElement) {
  return fittedPicture(canvas.getBoundingClientRect(), {
    width: canvas.width,
    height: canvas.height,
  });
}

const navigation = [
  { to: "back", label: "Back", icon: "chevron-left" },
  { to: "home", label: "Home", icon: "home" },
  { to: "recents", label: "Recent apps", icon: "recents" },
] as const;

/** The phone’s navigation whenever shared input is available. */
export function PhoneControlBar({ display }: { readonly display: ComputerDisplayView }) {
  const input =
    display.snapshot.input === "available" && display.geometry !== null ? display.input : null;
  const powerAvailable =
    !display.viewportEnabled &&
    display.snapshot.power === "available" &&
    (display.snapshot.display?.state === "live" ||
      display.snapshot.display?.state === "screen-off");
  if ((!input || display.viewportEnabled) && !display.receipt && !powerAvailable) return null;
  return (
    <div className="phone-display__control surface-row">
      {display.receipt ? (
        <span className="phone-display__note" role="status">
          {display.receipt}
        </span>
      ) : null}
      {powerAvailable ? (
        <button
          className="btn btn--small"
          type="button"
          onClick={() =>
            display.lease?.power(display.snapshot.display?.state === "screen-off" ? "wake" : "lock")
          }
        >
          {display.snapshot.display?.state === "screen-off" ? "Wake phone" : "Lock phone"}
        </button>
      ) : null}
      {input && !display.viewportEnabled ? (
        <span className="phone-display__nav">
          {navigation.map(({ icon, label, to }) => (
            <button
              aria-label={label}
              className="icon-btn"
              disabled={display.snapshot.display?.state !== "live"}
              key={to}
              onClick={() => input.nav(display.generation, to)}
              title={label}
              type="button"
            >
              <Icon name={icon} />
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function mouseEvent(
  event: MouseEvent<HTMLCanvasElement>,
  phase: "down" | "move" | "up",
  point: { x: number; y: number },
): Extract<import("@opensteer/protocol").DisplayInputEvent, { kind: "mouse" }> {
  const button =
    phase === "move"
      ? event.buttons & 1
        ? "left"
        : event.buttons & 2
          ? "right"
          : event.buttons & 4
            ? "middle"
            : "none"
      : event.button === 1
        ? "middle"
        : event.button === 2
          ? "right"
          : "left";
  const modifiers: import("@opensteer/protocol/editing").EditingModifier[] = [];
  if (event.altKey) modifiers.push("alt");
  if (event.ctrlKey) modifiers.push("control");
  if (event.metaKey) modifiers.push("meta");
  if (event.shiftKey) modifiers.push("shift");
  return {
    kind: "mouse",
    phase,
    button,
    ...point,
    modifiers,
    ...(phase === "move" ? {} : { clickCount: Math.max(1, Math.min(3, event.detail)) }),
  };
}
