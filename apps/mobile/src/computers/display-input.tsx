import type { EditingOperation } from "@opensteer/client/editing";
import {
  DisplayEditingSession,
  displayEditingAbilities,
  phoneControlNote,
  type DisplayLease,
  type DisplayEditingSnapshot,
} from "@opensteer/client/integrations";
import type { DisplayInputEvent } from "@opensteer/protocol";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import {
  NativeEditingProxy,
  type NativeEditingProxyHandle,
} from "../../modules/remote-text-input/src/editing-proxy.js";
import { createMobileClipboardPort } from "../../modules/remote-text-input/src/clipboard.js";
import { AppText } from "../ui/primitives.js";
import { color } from "../theme.js";

const emptyEditing: DisplayEditingSnapshot = { context: null, receipt: null };
const getEmptyEditing = () => emptyEditing;
const subscribeEmptyEditing = () => () => undefined;

export interface DisplayPicture {
  readonly generation: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayControlsHandle {
  giveBack(): void;
}

/** Input uses the geometry actually decoded, and the same lease that owns its pixels. */
export function DisplayControls({
  lease,
  picture,
  phone,
  visible,
  ref,
}: {
  readonly lease: DisplayLease;
  readonly picture: DisplayPicture | null;
  readonly phone: boolean;
  readonly visible: boolean;
  readonly ref?: Ref<DisplayControlsHandle>;
}) {
  const snapshot = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
  const held = snapshot.control.state === "held";
  const controlNote = phone
    ? phoneControlNote(snapshot.control)
    : held
      ? "You’re controlling this app"
      : snapshot.control.state === "busy"
        ? "Another viewer is controlling this app"
        : "reason" in snapshot.control && snapshot.control.reason
          ? `Control ${snapshot.control.state}: ${snapshot.control.reason}`
          : null;
  const negotiated = snapshot.display?.editingVersion === 1;
  const [session, setSession] = useState<DisplayEditingSession | null>(null);
  const currentSession = useRef<DisplayEditingSession | null>(null);
  const editing = useSyncExternalStore(
    session?.subscribe ?? subscribeEmptyEditing,
    session?.getSnapshot ?? getEmptyEditing,
  );
  const context = snapshot.display?.generation === picture?.generation ? editing.context : null;
  const [typing, setTyping] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  useEffect(() => setReceipt(null), [snapshot.control, snapshot.display?.generation]);
  const proxy = useRef<NativeEditingProxyHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      giveBack() {
        proxy.current?.interrupt("blur");
        lease.giveBack();
      },
    }),
    [lease],
  );
  const clipboard = useMemo(createMobileClipboardPort, []);
  const size = useRef({ width: 0, height: 0 });
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
      proxy.current?.interrupt("blur");
      lease.giveBack();
      currentSession.current = null;
      next.dispose();
    };
  }, [lease]);
  useEffect(
    () => session?.setGeometry(picture?.generation ?? null),
    [session, picture?.generation],
  );
  useEffect(() => {
    if (!held) setTyping(false);
    stroke.current = null;
  }, [held, picture?.generation]);

  const submit = (action: () => ReturnType<DisplayEditingSession["send"]>): boolean => {
    const before = lease.getSnapshot();
    if (!session || before.control.state !== "held") return false;
    const controlId = before.control.controlId;
    const generation = before.display?.generation;
    const active = () => {
      const now = lease.getSnapshot();
      return (
        currentSession.current === session &&
        now.connection === "open" &&
        now.control.state === "held" &&
        now.control.controlId === controlId &&
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
    session !== null && submit(() => session.input(geometry ?? null, events));
  const sendOperation = (operation: EditingOperation): boolean =>
    session !== null && submit(() => session.send(operation));
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
    const sent = send(
      [
        phone
          ? { kind: "pointer", phase, x, y, t }
          : { kind: "mouse", phase, x, y, button: "left", modifiers: [], clickCount: 1 },
      ],
      heldStroke.generation,
    );
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
          const heldStroke = stroke.current;
          if (heldStroke && (previous.width !== next.width || previous.height !== next.height)) {
            send(
              [
                phone
                  ? {
                      kind: "pointer",
                      phase: "cancel",
                      x: heldStroke.x,
                      y: heldStroke.y,
                      t: heldStroke.t,
                    }
                  : {
                      kind: "mouse",
                      phase: "cancel",
                      x: heldStroke.x,
                      y: heldStroke.y,
                      button: "left",
                      modifiers: [],
                    },
              ],
              heldStroke.generation,
            );
            stroke.current = null;
          }
          size.current = next;
        }}
        onTouchStart={(event) => touch("down", event)}
        onTouchMove={(event) => touch("move", event)}
        onTouchEnd={(event) => touch("up", event)}
        onTouchCancel={(event) => touch("cancel", event)}
      />
      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={held ? "Give back" : "Take over"}
          disabled={
            !held &&
            (!negotiated ||
              snapshot.control.state === "acquiring" ||
              snapshot.connection !== "open")
          }
          onPress={() => {
            if (held) {
              proxy.current?.interrupt("blur");
              lease.giveBack();
            } else {
              lease.takeOver();
              if (lease.getSnapshot().control.state !== "acquiring")
                setReceipt("Take over refused: unsupported for this view.");
            }
          }}
        >
          <AppText>{held ? "Give back" : "Take over"}</AppText>
        </Pressable>
        {held && context?.field ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Keyboard"
            onPress={() => setTyping(true)}
          >
            <AppText>Keyboard</AppText>
          </Pressable>
        ) : null}
        <AppText>{receipt ?? editing.receipt ?? controlNote}</AppText>
        {!negotiated ? <AppText>Editing is unavailable for this display.</AppText> : null}
        {held && typing ? (
          <View style={styles.keyboard}>
            <NativeEditingProxy
              ref={proxy}
              label={`Type into the ${phone ? "phone" : "Mac app"}`}
              context={context}
              abilities={displayEditingAbilities}
              sendOperation={sendOperation}
              onDone={() => setTyping(false)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={() => setTyping(false)}
            >
              <AppText>Done</AppText>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  controls: {
    position: "absolute",
    bottom: 12,
    left: 12,
    right: 12,
    padding: 12,
    gap: 8,
    backgroundColor: color.surfaceElevated,
    borderRadius: 12,
  },
  keyboard: { minHeight: 44, flexDirection: "row", alignItems: "center" },
});
