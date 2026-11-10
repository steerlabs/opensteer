import { expect, test, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { BrowserSurfaceIdSchema } from "@opensteer/core";
import { FakePhoneBrowserNative } from "./fake-native.test-support.js";
import { composeAndroidBrowserPort } from "./android-port.js";
import { PhoneBrowserError, type PhoneBrowserNativeEvent } from "./native-port.js";

test("Android qualifies the views before reading connection evidence and uses only its epoch", async () => {
  const views = new FakePhoneBrowserNative("android");
  const connection = new FakePhoneBrowserNative("android");
  const probed = vi.spyOn(views, "initialize");
  const read = vi.spyOn(connection, "initialize");
  const viewFence = vi.spyOn(views, "fence");
  const port = composeAndroidBrowserPort(views, connection);
  const epoch = port.fence("initialize");
  expect(viewFence).not.toHaveBeenCalled();
  views.epoch = epoch;
  const identity = { epoch, deploymentId: "enrolled-deployment", runnerId: "runner" };
  expect(await port.initialize(identity)).toEqual(connection.qualification);
  expect(probed.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
  await port.setForeground({ epoch, active: true });
  await port.setForeground({ epoch, active: false });
  expect(connection.calls.map(({ method }) => method)).toContain("setForeground");
});

test("native popup and viewer input refusals retain their typed reason", async () => {
  const views = new FakePhoneBrowserNative("android");
  const sentence =
    "A page opened this tab and this phone cannot hand it to an agent; open its address in a new tab instead.";
  vi.spyOn(views, "openCdpPipe").mockRejectedValue(
    Object.assign(new Error(sentence), { code: "unsupported-operation" }),
  );
  const port = composeAndroidBrowserPort(views, new FakePhoneBrowserNative("android"));
  await expect(
    port.openCdpPipe({
      epoch: 0,
      sessionId: "session",
      tabId: "popup",
      generation: 1,
      documentId: "document",
      geometryRevision: 1,
      attachmentId: "attachment",
    }),
  ).rejects.toEqual(new PhoneBrowserError("unsupported-operation", sentence));
  vi.spyOn(views, "applyViewerInput").mockRejectedValue(
    Object.assign(new Error("The drawn page geometry changed."), { code: "stale-geometry" }),
  );
  await expect(
    port.applyViewerInput({
      epoch: 0,
      sessionId: "session",
      tabId: "page",
      generation: 1,
      documentId: "document",
      geometryRevision: 1,
      channelId: "channel",
      message: {
        type: "clipboard.paste",
        surfaceId: BrowserSurfaceIdSchema.parse("page"),
        text: "viewer typed",
      },
    }),
  ).rejects.toEqual(new PhoneBrowserError("stale-geometry", "The drawn page geometry changed."));
});

test("CDP dialogs, answers and cancellation interrupt unfinished relay work in ingress order", async () => {
  const views = new FakePhoneBrowserNative("android");
  const connection = new FakePhoneBrowserNative("android");
  const port = composeAndroidBrowserPort(views, connection);
  const blocked = Promise.withResolvers<void>();
  const seen: string[] = [];
  const stop = port.onEvent(async (event) => {
    seen.push(event.type);
    if (event.type === "relayCommand" && seen.length === 1) await blocked.promise;
    if (event.type === "connection") blocked.resolve();
  });
  try {
    const command = connection.emit({
      type: "relayCommand",
      message: { type: "browser.client-message", message: { type: "cdp.command" } },
    } as PhoneBrowserNativeEvent);
    await vi.waitFor(() => expect(seen).toEqual(["relayCommand"]));
    await withTimeout(
      Promise.all([
        command,
        views.emit({ type: "dialog" } as PhoneBrowserNativeEvent),
        connection.emit({
          type: "relayCommand",
          message: { type: "browser.client-message", message: { type: "dialog.respond" } },
        } as PhoneBrowserNativeEvent),
        connection.emit({ type: "connection" } as PhoneBrowserNativeEvent),
      ]),
      1000,
      {
        timeoutError: () =>
          new Error("CDP held its dialog or cancellation behind the interrupted command."),
      },
    );
    expect(seen).toEqual(["relayCommand", "dialog", "relayCommand", "connection"]);
  } finally {
    blocked.resolve();
    stop();
  }
});
