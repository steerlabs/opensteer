import type { EditingOperation } from "@opensteer/client/editing";
import {
  DisplayEditingSession,
  displayEditingAbilities,
  type DisplayLease,
  type DisplayEditingSnapshot,
} from "@opensteer/client/integrations";
import type { DisplayInputEvent } from "@opensteer/protocol";
import {
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { StyleSheet, View, type GestureResponderEvent } from "react-native";
import {
  NativeEditingProxy,
  type NativeEditingProxyHandle,
} from "../../modules/remote-text-input/src/editing-proxy.js";
import { createMobileClipboardPort } from "../../modules/remote-text-input/src/clipboard.js";
import { AppText } from "../ui/primitives.js";
import { usePaneGeometry } from "../ui/pane.js";
import { ToolbarButton, ToolbarCapsule } from "../browser/toolbar.js";
import { material, radius, space } from "../theme.js";

const emptyEditing: DisplayEditingSnapshot = { context: null, receipt: null };
const getEmptyEditing = () => emptyEditing;
const subscribeEmptyEditing = () => () => undefined;

export interface DisplayPicture {
  readonly generation: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayControlsHandle {
  resetInput(): void;
  /** Brings up the keyboard for the field the display reports, from the place's bar. */
  startTyping(): void;
}

/** Input uses the geometry actually decoded, and the same lease that owns its pixels. */
export function DisplayControls({
  lease,
  onCanType,
  onTyping,
  picture,
  phone,
  visible,
  ref,
}: {
  readonly lease: DisplayLease;
  /** Whether a field has focus to type into now, for the bar's keyboard button. */
  readonly onCanType?: (canType: boolean) => void;
  /** The keyboard is up for the display, and its pane should make room. */
  readonly onTyping?: (typing: boolean) => void;
  readonly picture: DisplayPicture | null;
  readonly phone: boolean;
  readonly visible: boolean;
  readonly ref?: Ref<DisplayControlsHandle>;
}) {
  const snapshot = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
  const held =
    visible &&
    snapshot.input === "available" &&
    picture !== null &&
    picture.generation === snapshot.display?.generation;
  const negotiated = snapshot.display?.editingVersion === 1;
  const [session, setSession] = useState<DisplayEditingSession | null>(null);
  const currentSession = useRef<DisplayEditingSession | null>(null);
  const editing = useSyncExternalStore(
    session?.subscribe ?? subscribeEmptyEditing,
    session?.getSnapshot ?? getEmptyEditing,
  );
  const context = snapshot.display?.generation === picture?.generation ? editing.context : null;
  const [typing, setTyping] = useState(false);
  const canType = held && negotiated && context?.field != null;
  useEffect(() => onCanType?.(canType), [canType, onCanType]);
  const keyboardUp = held && typing;
  useEffect(() => onTyping?.(keyboardUp), [keyboardUp, onTyping]);
  useEffect(() => () => onTyping?.(false), [onTyping]);
  useEffect(() => {
    if (!canType) setTyping(false);
  }, [canType]);
  const [receipt, setReceipt] = useState<string | null>(null);
  useEffect(() => setReceipt(null), [snapshot.input, snapshot.display?.generation]);
  const proxy = useRef<NativeEditingProxyHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      resetInput() {
        proxy.current?.cancel();
        lease.resetInput();
      },
      startTyping() {
        setTyping(true);
      },
    }),
    [lease],
  );
  const clipboard = useMemo(createMobileClipboardPort, []);
  const size = useRef({ width: 0, height: 0, x: 0, y: 0 });
  const stroke = useRef<{
    generation: number;
    x: number;
    y: number;
    t: number;
    identifier: number;
  } | null>(null);
  useEffect(() => {
    const next = new DisplayEditingSession(lease);
    currentSession.current = next;
    setSession(next);
    return () => {
      proxy.current?.cancel();
      lease.resetInput();
      currentSession.current = null;
      next.dispose();
    };
  }, [lease]);
  useEffect(
    () => session?.setGeometry(picture?.generation ?? null),
    [session, picture?.generation],
  );
  useEffect(() => {
    if (!held) {
      proxy.current?.cancel();
      lease.resetInput();
      setTyping(false);
    }
    stroke.current = null;
  }, [held, picture?.generation, lease]);

  const submit = (action: () => ReturnType<DisplayEditingSession["send"]>): boolean => {
    const before = lease.getSnapshot();
    if (!session || before.input !== "available") return false;
    const generation = before.display?.generation;
    const active = () => {
      const now = lease.getSnapshot();
      return (
        currentSession.current === session &&
        now.connection === "open" &&
        now.input === "available" &&
        now.display?.generation === generation
      );
    };
    setReceipt(null);
    void action()
      .then(async (result) => {
        if (!active() || !result) return;
        if (result.outcome === "copied") {
          const outcome = await clipboard.write(result.items);
          if (active()) setReceipt(outcome === "written" ? "Copied" : `Copy ${outcome}`);
        } else if (result.outcome !== "empty") setReceipt(`Copy ${result.outcome}`);
      })
      .catch((error: unknown) => {
        if (active()) setReceipt(error instanceof Error ? error.message : "Input unavailable.");
      });
    return true;
  };
  const send = (events: readonly DisplayInputEvent[], geometry = picture?.generation): boolean =>
    held &&
    geometry !== undefined &&
    (negotiated
      ? session !== null && submit(() => session.input(geometry, events))
      : lease.input(geometry, events));
  const sendOperation = (operation: EditingOperation): boolean =>
    session !== null && submit(() => session.send(operation));
  const pendingMove = useRef<{ geometry: number; event: DisplayInputEvent } | null>(null);
  const moveFrame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const discardMove = () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = null;
    pendingMove.current = null;
  };
  useEffect(() => {
    discardMove();
    return discardMove;
  }, [held, picture?.generation, lease]);
  const flushMove = () => {
    const move = pendingMove.current;
    discardMove();
    if (move) send([move.event], move.geometry);
  };
  const cancelStroke = () => {
    flushMove();
    const current = stroke.current;
    if (!current) return;
    stroke.current = null;
    send(
      [
        phone
          ? { kind: "pointer", phase: "cancel", x: current.x, y: current.y, t: current.t }
          : {
              kind: "mouse",
              phase: "cancel",
              x: current.x,
              y: current.y,
              button: "left",
              modifiers: [],
            },
      ],
      current.generation,
    );
  };
  const cancelMovedStroke = useRef(cancelStroke);
  cancelMovedStroke.current = cancelStroke;
  const geometry = usePaneGeometry();
  useLayoutEffect(() => {
    cancelMovedStroke.current();
  }, [geometry]);
  const touch = (phase: "down" | "move" | "up" | "cancel", event: GestureResponderEvent) => {
    if (!held || !picture) return;
    const { width, height } = size.current;
    const scale = Math.min(width / picture.width, height / picture.height);
    if (!(scale > 0)) return;
    const w = picture.width * scale,
      h = picture.height * scale;
    const rawX = (event.nativeEvent.locationX - (width - w) / 2) / w;
    const rawY = (event.nativeEvent.locationY - (height - h) / 2) / h;
    if (phase === "down") {
      if (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1 || stroke.current) return;
      proxy.current?.interrupt();
      stroke.current = {
        generation: picture.generation,
        x: rawX,
        y: rawY,
        t: event.nativeEvent.timestamp,
        identifier: event.nativeEvent.identifier,
      };
    }
    const heldStroke = stroke.current;
    if (!heldStroke || heldStroke.identifier !== event.nativeEvent.identifier) return;
    if (heldStroke.generation !== picture.generation) {
      stroke.current = null;
      return;
    }
    const x = Math.max(0, Math.min(1, rawX)),
      y = Math.max(0, Math.min(1, rawY));
    const t = Math.max(heldStroke.t, event.nativeEvent.timestamp);
    const inputEvent: DisplayInputEvent = phone
      ? { kind: "pointer", phase, x, y, t }
      : { kind: "mouse", phase, x, y, button: "left", modifiers: [], clickCount: 1 };
    let sent = true;
    if (phase === "move") {
      pendingMove.current = { geometry: heldStroke.generation, event: inputEvent };
      moveFrame.current ??= requestAnimationFrame(() => {
        moveFrame.current = null;
        flushMove();
      });
    } else {
      flushMove();
      sent = send([inputEvent], heldStroke.generation);
    }
    heldStroke.x = x;
    heldStroke.y = y;
    heldStroke.t = t;
    if (!sent || phase === "up" || phase === "cancel") stroke.current = null;
  };
  if (!picture) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, !visible && { display: "none" }]}
    >
      <View
        testID="display-input"
        pointerEvents={held ? "auto" : "none"}
        style={StyleSheet.absoluteFill}
        onLayout={(event) => {
          const next = event.nativeEvent.layout;
          const previous = size.current;
          if (
            previous.width !== next.width ||
            previous.height !== next.height ||
            previous.x !== next.x ||
            previous.y !== next.y
          )
            cancelStroke();
          size.current = next;
        }}
        onTouchStart={(event) => touch("down", event)}
        onTouchMove={(event) => touch("move", event)}
        onTouchEnd={(event) => touch("up", event)}
        onTouchCancel={(event) => touch("cancel", event)}
      />
      {(receipt ?? editing.receipt) ? (
        <View pointerEvents="none" style={styles.receipt}>
          <AppText role="caption">{receipt ?? editing.receipt}</AppText>
        </View>
      ) : null}
      {held && typing ? (
        <View style={styles.typing}>
          <ToolbarCapsule style={styles.field}>
            <NativeEditingProxy
              cancelCompositionOnBlur
              ref={proxy}
              label={`Type into the ${phone ? "phone" : "Mac app"}`}
              context={context}
              abilities={displayEditingAbilities}
              sendOperation={sendOperation}
              onDone={() => {
                lease.resetInput();
                setTyping(false);
              }}
            />
          </ToolbarCapsule>
          <ToolbarButton
            label="Done"
            onPress={() => {
              proxy.current?.cancel();
              lease.resetInput();
              setTyping(false);
            }}
            selected
            symbol="checkmark"
          />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  field: { flex: 1, minWidth: 0, paddingHorizontal: space[12] },
  // What a copy or a refused edit came to, said briefly over the picture's foot.
  receipt: {
    ...material.float,
    alignSelf: "center",
    borderRadius: radius.full,
    bottom: space[12],
    paddingHorizontal: space[14],
    paddingVertical: space[6],
    position: "absolute",
  },
  typing: {
    alignItems: "center",
    bottom: space[8],
    flexDirection: "row",
    gap: space[8],
    left: space[12],
    position: "absolute",
    right: space[12],
  },
});
