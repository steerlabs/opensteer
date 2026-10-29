import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MockHostClient } from "@opensteer/client/mock";
import { MockPhoneDisplaySocket } from "../../../../packages/client/src/mock/mock-phone-display.js";
import type { WebSocketClient } from "@opensteer/client/host";
import {
  DisplayViewerClientMessageSchema,
  type DisplayInputEvent,
  type DisplayViewerServerMessage,
} from "@opensteer/protocol";
import {
  ComputerDisplayScreen,
  PhoneControlBar,
  PhoneControlButton,
  useComputerDisplay,
} from "../../src/components/phone-display.js";
import "../../src/styles/watch.css";

export interface DisplayEditingSmokeApi {
  events(): readonly DisplayInputEvent[];
  mac(value: boolean): void;
  emptyCopy(): void;
  close(): void;
}
const events: DisplayInputEvent[] = [];
let empty = false;
const client = new MockHostClient({ latencyMs: 0 });
await client.load();
const machine = client.getSnapshot().machines.find((machine) => machine.device?.form === "phone");
const sessionId = machine?.computerUse?.sessions[0]?.sessionId;
if (!sessionId) throw new Error("Missing display fixture");
const context = {
  contextId: crypto.randomUUID(),
  field: { kind: "text" as const, multiline: true, sensitive: false },
  caret: { x: 0.25, y: 0.5, height: 0.025 },
};
class EditingSocket implements WebSocketClient {
  readonly #base: WebSocketClient = new MockPhoneDisplaySocket("live");
  readonly #listeners = new Map<string, Set<(event: never) => void>>();
  get binaryType() {
    return this.#base.binaryType;
  }
  set binaryType(value: "blob" | "arraybuffer") {
    this.#base.binaryType = value;
  }
  get readyState() {
    return this.#base.readyState;
  }
  constructor() {
    this.#base.addEventListener("open", () => this.#emit("open", {}));
    this.#base.addEventListener("close", (event) => this.#emit("close", event));
    this.#base.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        this.#emit("message", event);
        return;
      }
      const message = JSON.parse(event.data) as DisplayViewerServerMessage;
      this.#json(message.type === "display.state" ? { ...message, editingVersion: 1 } : message);
      if (message.type === "display.control" && message.state === "held")
        this.#json({ type: "display.editing", generation: 1, context });
    });
  }
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }
  #emit(type: string, event: unknown) {
    for (const listener of this.#listeners.get(type) ?? [])
      (listener as (event: unknown) => void)(event);
  }
  #json(message: DisplayViewerServerMessage) {
    this.#emit("message", { data: JSON.stringify(message) });
  }
  close(code?: number, reason?: string) {
    this.#base.close(code, reason);
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data !== "string") throw new Error("Expected JSON");
    const message = DisplayViewerClientMessageSchema.parse(JSON.parse(data));
    if (message.type !== "display.input") {
      this.#base.send(data);
      return;
    }
    events.push(...message.events);
    const rich = message.events.some((event) => event.kind === "paste" && "items" in event);
    this.#json({
      type: "display.input.result",
      sequence: message.sequence,
      outcome: rich ? "refused" : "dispatched",
      ...(rich ? { reason: "unsupported" as const } : {}),
    });
    if (message.events.some((event) => event.kind === "copy"))
      this.#json({
        type: "display.clipboard",
        sequence: message.sequence,
        outcome: empty ? "empty" : "copied",
        ...(empty ? {} : { text: "remote clipboard fixture" }),
      });
  }
}
const socketUrl = new URLSearchParams(location.search).get("displaySocketUrl");
client.connectComputerDisplay = () => {
  if (!socketUrl) return new EditingSocket();
  const socket = new WebSocket(socketUrl);
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    if (typeof data === "string") {
      const message = DisplayViewerClientMessageSchema.parse(JSON.parse(data));
      if (message.type === "display.input") events.push(...message.events);
    }
    send(data);
  };
  return socket;
};
let setMac: (value: boolean) => void = () => undefined;
let close: () => void = () => undefined;
function Fixture() {
  const [mac, chooseMac] = useState(new URLSearchParams(location.search).get("mac") === "1");
  const [enabled, setEnabled] = useState(true);
  setMac = chooseMac;
  close = () => {
    setEnabled(false);
    client.dispose();
  };
  const display = useComputerDisplay({
    enabled,
    hostClient: client,
    source: { kind: "task-session", sessionId: sessionId! },
    streamable: true,
    macWindow: mac,
  });
  return (
    <section className="computer-watch" style={{ width: 720 }}>
      <PhoneControlButton display={display} phoneName={mac ? "Fixture app" : "Fixture phone"} />
      <ComputerDisplayScreen
        dim={false}
        display={display}
        interactive={display.snapshot.control.state === "held"}
        label="Display smoke"
        onEnlarge={null}
        shown={display.picture !== null}
      />
      <PhoneControlBar display={display} />
    </section>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
Reflect.set(window, "displayEditingSmoke", {
  events: () => events,
  mac: (value: boolean) => setMac(value),
  emptyCopy: () => {
    empty = true;
  },
  close: () => {
    close();
    root.unmount();
  },
} satisfies DisplayEditingSmokeApi);
