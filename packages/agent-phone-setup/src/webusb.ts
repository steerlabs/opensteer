/// <reference types="w3c-web-usb" />
import {
  Adb,
  AdbDaemonTransport,
  AdbPublicKeyAuthenticator,
  AdbSignatureAuthenticator,
  type AdbAuthenticator,
  type AdbCredentialStore,
} from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";

/**
 * The product transport: the phone's ADB interface over WebUSB, in Chrome and
 * in the desktop app's own window. The person picks the phone in the browser's
 * chooser (the desktop surfaces its own), so the page only ever reaches a
 * device somebody handed it.
 */

export type { AdbDaemonWebUsbDevice as AgentPhoneUsbDevice } from "@yume-chan/adb-daemon-webusb";

/** WebUSB, where this browser has it; Safari and Firefox do not. */
export function agentPhoneUsb(): USB | null {
  return typeof navigator !== "undefined" && "usb" in navigator ? navigator.usb : null;
}

/**
 * Asks the person to choose their phone. Only devices exposing Android's ADB
 * interface are offered, so null means nothing was chosen — which is also what
 * a phone with USB debugging off looks like, since it is never listed.
 */
export async function chooseAgentPhone(usb: USB): Promise<AdbDaemonWebUsbDevice | null> {
  return (await new AdbDaemonWebUsbDeviceManager(usb).requestDevice()) ?? null;
}

/** The phones this page may open again without asking, for resuming after a replug. */
export function grantedAgentPhones(usb: USB): Promise<AdbDaemonWebUsbDevice[]> {
  return new AdbDaemonWebUsbDeviceManager(usb).getDevices();
}

/**
 * The RSA key this browser profile identifies itself to phones with. The
 * phone shows its fingerprint in "Allow USB debugging?", and remembers it
 * when the person also ticks "Always allow".
 */
export function agentPhoneCredentialStore(): AdbCredentialStore {
  return new AdbWebCredentialStore("Opensteer");
}

export type AgentPhoneUsbConnection =
  | { readonly adb: Adb; readonly kind: "connected" }
  /** Another ADB program, such as Android Studio's `adb` server, holds the phone. */
  | { readonly kind: "busy" }
  /** Nobody allowed USB debugging on the phone in time, or it was denied. */
  | { readonly kind: "unauthorized" };

/** How long the phone's "Allow USB debugging?" prompt is waited on. */
const authorizeTimeoutMs = 120_000;

export async function connectAgentPhone(
  device: AdbDaemonWebUsbDevice,
  options: {
    readonly credentialStore: AdbCredentialStore;
    /** Called when the phone is about to ask the person to allow USB debugging. */
    readonly onAuthorizePrompt: () => void;
    readonly signal: AbortSignal;
  },
): Promise<AgentPhoneUsbConnection> {
  options.signal.throwIfAborted();
  // A phone that already trusts this key accepts its signature silently; the
  // public key is only offered — and the prompt only shown — when it does not.
  const promptingPublicKey: AdbAuthenticator = (store, getNextRequest) => {
    options.onAuthorizePrompt();
    return AdbPublicKeyAuthenticator(store, getNextRequest);
  };
  // Tango waits for the phone's answer indefinitely, and a denied prompt is
  // never answered at all. Closing the device is what ends that wait.
  let timedOut = false;
  const release = () => void device.raw.close().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  options.signal.addEventListener("abort", release, { once: true });
  try {
    let connection: Awaited<ReturnType<AdbDaemonWebUsbDevice["connect"]>>;
    try {
      connection = await device.connect();
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof AdbDaemonWebUsbDevice.DeviceBusyError) return { kind: "busy" };
      throw error;
    }
    if (options.signal.aborted) {
      // WebUSB can finish opening after the abort handler already closed it.
      await device.raw.close().catch(() => undefined);
      options.signal.throwIfAborted();
    }
    timer = setTimeout(() => {
      timedOut = true;
      release();
    }, authorizeTimeoutMs);
    const transport = await AdbDaemonTransport.authenticate({
      authenticators: [AdbSignatureAuthenticator, promptingPublicKey],
      connection,
      credentialStore: options.credentialStore,
      serial: device.serial,
    });
    options.signal.throwIfAborted();
    return { adb: new Adb(transport), kind: "connected" };
  } catch (error) {
    options.signal.throwIfAborted();
    if (timedOut) return { kind: "unauthorized" };
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", release);
  }
}
