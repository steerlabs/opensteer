/**
 * USB cancellation failures, written before the transport fix:
 * - Cancelling before opening must never claim a device.
 * - Cancelling while WebUSB opens must close the eventual connection without authentication.
 * - An opening failure after cancellation must preserve the cancellation reason, not show busy.
 * - Cancelling during authentication must close the device and end that wait.
 */
import { AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import { expect, it, vi } from "vitest";
import { connectAgentPhone } from "./webusb.js";

function pendingDevice() {
  const opening = Promise.withResolvers<Awaited<ReturnType<AdbDaemonWebUsbDevice["connect"]>>>();
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(() => opening.promise);
  const device = {
    connect,
    raw: { close },
    serial: "test-phone",
  } as unknown as AdbDaemonWebUsbDevice;
  return { close, connect, device, opening };
}

function options(signal: AbortSignal) {
  return {
    credentialStore: {
      generateKey: vi.fn(),
      iterateKeys: async function* () {},
    },
    onAuthorizePrompt: vi.fn(),
    signal,
  };
}

it("never opens USB when setup was already cancelled", async () => {
  const controller = new AbortController();
  const reason = new Error("Setup cancelled");
  controller.abort(reason);
  const phone = pendingDevice();
  await expect(connectAgentPhone(phone.device, options(controller.signal))).rejects.toBe(reason);
  expect(phone.connect).not.toHaveBeenCalled();
});

it("closes a device opened after setup was cancelled without starting authentication", async () => {
  const phone = pendingDevice();
  const controller = new AbortController();
  const reason = new Error("Setup cancelled while USB opened");
  const authenticate = vi
    .spyOn(AdbDaemonTransport, "authenticate")
    .mockRejectedValue(new Error("Authentication must not start"));
  const connected = connectAgentPhone(phone.device, options(controller.signal));
  controller.abort(reason);
  expect(phone.close).toHaveBeenCalled();
  phone.opening.resolve({} as Awaited<ReturnType<AdbDaemonWebUsbDevice["connect"]>>);
  await expect(connected).rejects.toBe(reason);
  expect(authenticate).not.toHaveBeenCalled();
  expect(phone.close).toHaveBeenCalled();
});

it("keeps cancellation as the result when an opening failure arrives afterwards", async () => {
  const phone = pendingDevice();
  const controller = new AbortController();
  const reason = new Error("Setup cancelled while USB opened");
  const connected = connectAgentPhone(phone.device, options(controller.signal));
  controller.abort(reason);
  phone.opening.reject(new AdbDaemonWebUsbDevice.DeviceBusyError());
  await expect(connected).rejects.toBe(reason);
});

it("closes USB to interrupt authentication when setup is cancelled", async () => {
  const phone = pendingDevice();
  const controller = new AbortController();
  const reason = new Error("Setup cancelled during authorization");
  const authenticating = Promise.withResolvers<never>();
  vi.spyOn(AdbDaemonTransport, "authenticate").mockReturnValue(authenticating.promise);
  const connected = connectAgentPhone(phone.device, options(controller.signal));
  phone.opening.resolve({} as Awaited<ReturnType<AdbDaemonWebUsbDevice["connect"]>>);
  await Promise.resolve();
  controller.abort(reason);
  expect(phone.close).toHaveBeenCalled();
  authenticating.reject(new Error("USB closed"));
  await expect(connected).rejects.toBe(reason);
});

it("releases USB when an existing ADB server owns the interface", async () => {
  const phone = pendingDevice();
  const connected = connectAgentPhone(phone.device, options(new AbortController().signal));
  phone.opening.reject(new AdbDaemonWebUsbDevice.DeviceBusyError());
  await expect(connected).resolves.toEqual({ kind: "busy" });
  expect(phone.close).toHaveBeenCalledTimes(1);
});

it("releases USB after authentication fails", async () => {
  const phone = pendingDevice();
  const failure = new Error("Authentication failed");
  vi.spyOn(AdbDaemonTransport, "authenticate").mockRejectedValue(failure);
  const connected = connectAgentPhone(phone.device, options(new AbortController().signal));
  phone.opening.resolve({} as Awaited<ReturnType<AdbDaemonWebUsbDevice["connect"]>>);
  await expect(connected).rejects.toBe(failure);
  expect(phone.close).toHaveBeenCalledTimes(1);
});
