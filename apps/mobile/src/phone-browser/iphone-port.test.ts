import { expect, test, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";
import { composeIphoneBrowserPort } from "./iphone-port.js";
import type { PhoneBrowserNativeEvent } from "./native-port.js";
import type { IphoneBrowserConnectionPort } from "../iphone-apps/browser-transport.js";

test("a dialog and its answer pass an unfinished action on the composed event stream", async () => {
  const views = new FakePhoneBrowserNative("ios");
  const transport = new FakePhoneBrowserNative("ios");
  const connection: IphoneBrowserConnectionPort = {
    configure: async () => undefined,
    fence: (reason) => transport.fence(reason),
    setForeground: (input) => transport.setForeground(input),
    verifyAttach: (input) => transport.verifyAttach(input),
    commitAttach: (input) => transport.commitAttach(input),
    sendRelay: (input) => transport.sendRelay(input),
    closeChannel: (input) => transport.closeChannel(input),
    attachAgent: (input) => transport.attachAgent(input),
    detachAgent: (input) => transport.detachAgent(input),
    onEvent: (listener) => transport.onEvent(listener),
    onErasure: () => () => undefined,
    retryErasure: async () => undefined,
  };
  const port = composeIphoneBrowserPort(views, connection);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const seen: string[] = [];
  const unsubscribe = port.onEvent(async (event) => {
    seen.push(event.type);
    if (event.type === "relayCommand") await blocked;
    else finish();
  });
  try {
    const action = transport.emit({
      type: "relayCommand",
      message: { type: "browser.client-message", message: { type: "agent.action" } },
    } as PhoneBrowserNativeEvent);
    await vi.waitFor(() => expect(seen).toEqual(["relayCommand"]));
    const dialog = views.emit({ type: "dialog" } as PhoneBrowserNativeEvent);
    await withTimeout(Promise.all([action, dialog]), 1000, {
      timeoutError: () => new Error("A dialog was held behind the action it must interrupt."),
    });
    expect(seen).toEqual(["relayCommand", "dialog"]);
  } finally {
    finish();
    unsubscribe();
  }
});
