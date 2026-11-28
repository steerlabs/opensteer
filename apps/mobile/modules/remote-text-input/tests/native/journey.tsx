import "../../../../src/runtime.js";
import { registerRootComponent } from "expo";
import { hideMenu } from "expo-dev-client";
import * as SplashScreen from "expo-splash-screen";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import type { EditingOperation } from "@opensteer/client/editing";
import type { WebSocketClient } from "@opensteer/client/host";
import { DisplayStreams, type DisplayLease } from "@opensteer/client/integrations";
import { ComputerUseSessionIdSchema, DisplayViewerClientMessageSchema } from "@opensteer/protocol";
import type { EditingContext } from "@opensteer/protocol/editing";
import { PageTyping } from "../../../../src/browser/browser-page.js";
import { DisplayControls } from "../../../../src/computers/display-input.js";
import { createMobileClipboardPort } from "../../src/clipboard.js";
import { FarField } from "../remote-input-port.js";

// This Metro entry is a native viewer boundary fixture, never a shipping entry or a real target.
const coordinator = `http://${Platform.OS === "android" ? "10.0.2.2" : "127.0.0.1"}:18766`;
const copiedText = "fixture clipboard 👩‍💻";
const picture = { generation: 1, width: 200, height: 400 };
const contextId = (field: number) => `00000000-0000-4000-8000-${String(field).padStart(12, "0")}`;
const contextAt = (field: number): EditingContext => contextFor(contextId(field));
const contextFor = (id: string): EditingContext => ({
  contextId: id,
  field: { kind: "text", multiline: true, sensitive: false, autocapitalize: "none" },
  caret: { x: 0.5, y: 0.5, height: 0.02 },
});
type Log = (type: string, details: unknown) => void;

class FixtureSocket implements WebSocketClient {
  readyState = 0;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  readonly listeners = new Map<string, ((event: never) => void)[]>();
  constructor(
    readonly context: () => EditingContext,
    readonly log: Log,
    readonly reject: () => boolean,
    readonly rotate: () => void,
  ) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
      this.json({
        type: "display.state",
        state: "live",
        generation: 1,
        width: 200,
        height: 400,
        editingVersion: 1,
        sharedInput: 1,
      });
      this.publish();
    });
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      (listener as (event: unknown) => void)(event);
  }
  json(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  publish(context = this.context()) {
    this.json({ type: "display.editing", generation: 1, context });
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data !== "string") throw new Error("Unexpected binary viewer input");
    const message = DisplayViewerClientMessageSchema.parse(JSON.parse(data));
    this.log("display-wire", message);
    queueMicrotask(() => {
      if (message.type === "display.input") {
        const refused = this.reject();
        this.json({
          type: "display.input.result",
          sequence: message.sequence,
          outcome: refused ? "stale" : "dispatched",
        });
        if (refused) this.rotate();
        if (message.events.some((event) => event.kind === "copy"))
          this.json({
            type: "display.clipboard",
            sequence: message.sequence,
            outcome: "copied",
            text: copiedText,
          });
      }
    });
  }
  close() {
    this.readyState = 3;
  }
}

function NativeEditingJourney() {
  const [mode, setMode] = useState<"browser" | "baseline" | "phone">("browser");
  const [context, setContext] = useState(() => contextAt(1));
  const [typing, setTyping] = useState(true);
  const rejectNext = useRef(false);
  /*
   * The far page: each field is the port's FarField (tests/remote-input-port.ts), the model
   * tests/editing-far-model.test.ts holds to the real applier in Chromium. It takes an edit only
   * where its own text matches the edit's before and after, composes, pastes and runs the caret
   * and deletion commands as a page does, and rotates its context on a refusal. Keyed by every
   * context it has had; the legacy path's field takes any context.
   */
  const fields = useRef(new Map<string, FarField>());
  const rotations = useRef(0);
  const currentContext = useRef(context);
  currentContext.current = context;
  const field = useRef(1);
  const [lease, setLease] = useState<DisplayLease | null>(null);
  const socket = useRef<FixtureSocket | null>(null);
  const [clipboard] = useState(createMobileClipboardPort);
  const [last, setLast] = useState("Ready");
  const [fault, setFault] = useState<string | null>(null);
  const output = useRef(Promise.resolve());
  const log = useCallback<Log>((type, details) => {
    const event = { type, details, platform: Platform.OS, at: Date.now(), fixtureTarget: true };
    setLast(JSON.stringify(event));
    output.current = output.current
      .then(async () => {
        const response = await fetch(`${coordinator}/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        if (!response.ok) throw new Error(`Fixture event delivery: ${response.status}`);
      })
      .catch((error: unknown) => setFault(error instanceof Error ? error.message : String(error)));
  }, []);
  useEffect(() => {
    void SplashScreen.hideAsync();
    hideMenu();
    const wire = new FixtureSocket(
      () => currentContext.current,
      log,
      () => {
        const value = rejectNext.current;
        rejectNext.current = false;
        return value;
      },
      () => change(),
    );
    socket.current = wire;
    const streams = new DisplayStreams({ connect: () => wire });
    const next = streams.retain({
      scope: "native-fixture",
      editing: 1,
      source: {
        kind: "task-session",
        sessionId: ComputerUseSessionIdSchema.parse("cus_11111111-1111-4111-8111-111111111111"),
      },
    });
    setLease(next);
    log("ready", { context: currentContext.current });
    return () => {
      next.release();
      socket.current = null;
    };
  }, [log]);
  const change = () => {
    const next = contextAt(++field.current);
    log("context", next);
    setContext(next);
    socket.current?.publish(next);
  };
  const fieldFor = (id: string) => {
    let far = fields.current.get(id);
    if (far) return far;
    far = new FarField();
    far.contextId = id === "legacy" ? null : id;
    // A rotation's context is the page's next one: never a context another field has had.
    far.nextContextId = () => contextId(1_000_000 + ++rotations.current);
    far.onRotate = (next) => {
      fields.current.set(next, far);
      const rotated = contextFor(next);
      log("context", rotated);
      setContext(rotated);
      socket.current?.publish(rotated);
    };
    fields.current.set(id, far);
    return far;
  };
  const send = (operation: EditingOperation) => {
    log(
      "browser-operation",
      operation.kind === "paste"
        ? {
            ...operation,
            items: operation.items.map((item) => ({
              type: item.type,
              text: new TextDecoder().decode(item.bytes),
            })),
          }
        : operation,
    );
    if (rejectNext.current) {
      rejectNext.current = false;
      log("refused", { kind: operation.kind });
      queueMicrotask(change);
      return false;
    }
    const id =
      mode === "baseline"
        ? "legacy"
        : operation.kind === "edit"
          ? operation.edit.contextId
          : operation.kind === "compose"
            ? operation.composition.contextId
            : currentContext.current.contextId;
    const far = fieldFor(id);
    const mismatched = far.mismatched.length;
    const value = far.value;
    far.take(operation);
    // A mismatch is a fault upstream, never the person's: the field shows it.
    if (far.mismatched.length > mismatched) setFault(`Fixture target range mismatch: ${id}`);
    // One event per change of the field's text, as the walker counts them.
    if (far.value !== value) log("target", { contextId: id, value: far.value, caret: far.caret });
    if (operation.kind === "copy")
      void clipboard
        .write([{ type: "text/plain", bytes: new TextEncoder().encode(copiedText) }])
        .then((outcome) => log("browser-copy-result", { outcome }));
    return true;
  };
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#101010", paddingTop: 40 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* The controls scroll and their rows wrap, so at the largest text size they shrink before
          the typing field does and the field stays inside the window for the walker to reach. */}
      <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: "white", padding: 8 }}>
          Native viewer fixture — local protocol target
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {(["browser", "baseline", "phone"] as const).map((value) => (
            <Button
              key={value}
              title={value}
              onPress={() => {
                setMode(value);
                setTyping(true);
                change();
              }}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Button
            title="Refuse next edit"
            onPress={() => {
              rejectNext.current = true;
            }}
          />
          <Button title="Open browser keyboard" onPress={() => setTyping(true)} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <Button title="Next field" accessibilityLabel="Next remote field" onPress={change} />
          <Button
            title="Seed"
            accessibilityLabel="Seed system clipboard"
            onPress={() => {
              void Clipboard.setStringAsync(copiedText).then(() =>
                log("clipboard-seeded", { text: copiedText }),
              );
            }}
          />
          <Button
            title="Read"
            accessibilityLabel="Read system clipboard"
            onPress={() => {
              void Clipboard.getStringAsync().then((text) => log("clipboard-read", { text }));
            }}
          />
        </View>
        <Text
          style={{ color: "white", padding: 4, fontSize: 12 }}
          accessibilityLabel="Fixture context"
        >
          {context.contextId}
        </Text>
        <Text
          style={{ color: fault ? "red" : "white", padding: 8 }}
          numberOfLines={2}
          accessibilityLabel="Fixture result"
        >
          {fault ?? last}
        </Text>
      </ScrollView>
      <View style={{ flex: 1, minHeight: 120 }}>
        {mode === "phone" ? (
          lease && <DisplayControls lease={lease} picture={picture} phone visible />
        ) : typing ? (
          <PageTyping
            key={mode}
            legacy={mode === "baseline"}
            context={mode === "baseline" ? null : context}
            sendOperation={send}
            onDone={() => {
              log("keyboard-done", { mode });
              setTyping(false);
            }}
          />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}
registerRootComponent(NativeEditingJourney);
