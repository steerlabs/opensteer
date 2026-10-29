import { randomUUID } from "node:crypto";
import type {
  DevicePermissionHandlerHandlerDetails,
  Event,
  SelectUsbDeviceDetails,
  Session,
  USBDevice,
  WebFrameMain,
} from "electron";
import { z } from "zod";
import {
  DesktopUsbDeviceChoiceSchema,
  type DesktopChooseUsbDeviceInput,
} from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "../bridge/desktop-bridge-channels.js";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";

/**
 * WebUSB for exactly one purpose: the bundled app's window setting a phone up
 * over its ADB interface.
 *
 * Chrome shows its own device chooser and remembers what the person picked;
 * Electron has neither, so main plays both parts. Electron puts three
 * questions on the way to a device, each with only its own context, and this
 * class answers all three so no answer depends on context Electron never
 * gives:
 *
 * - {@link permitsRequest}: may this origin request a device at all? Electron
 *   asks with the origin alone — no WebContents, no frame — so only the app's
 *   own origin passes; the frame is judged at the next question.
 * - `select-usb-device`: which device? Asked with the requesting frame, which
 *   must be the app's main frame. Chromium offers only devices with Android's
 *   ADB interface, as the page's request asks; one is the person's evident
 *   choice — they plugged it in to set it up — and several are put to the page
 *   to choose between.
 * - The device permission handler: may the page reach this device? Only the
 *   device the person picked, for as long as this app runs; nothing is
 *   granted ahead of a pick.
 */
export class DesktopUsbDeviceAccess {
  readonly #policy = new DesktopAppOriginPolicy();
  /** Devices the person picked, keyed so a replugged phone is still the one they picked. */
  readonly #granted = new Set<string>();
  #pending: {
    readonly callback: (deviceId?: string) => void;
    readonly choiceId: string;
    readonly devices: ReadonlyMap<string, USBDevice>;
    readonly frame: WebFrameMain;
  } | null = null;

  attach(session: Session): () => void {
    const select = (
      event: Event,
      details: SelectUsbDeviceDetails,
      callback: (deviceId?: string) => void,
    ) => {
      event.preventDefault();
      this.#select(details, callback);
    };
    const revoked = (_event: Event, details: { readonly device: USBDevice }) => {
      this.#granted.delete(deviceKey(details.device));
    };
    session.on("select-usb-device", select);
    session.on("usb-device-revoked", revoked);
    session.setDevicePermissionHandler((details) => this.#permits(details));
    return () => {
      session.off("select-usb-device", select);
      session.off("usb-device-revoked", revoked);
      session.setDevicePermissionHandler(null);
      this.#cancelPending();
    };
  }

  /** Whether a page of `requestingOrigin` may ask for a USB device. */
  permitsRequest(requestingOrigin: string): boolean {
    return this.#policy.isAppOrigin(requestingOrigin);
  }

  /** The page's answer to the open choice, from the frame that was asked. */
  choose(input: DesktopChooseUsbDeviceInput, frame: WebFrameMain | null): void {
    const pending = this.#pending;
    if (!pending || pending.choiceId !== input.choiceId || pending.frame !== frame) {
      throw new Error("That USB device choice is no longer open.");
    }
    this.#pending = null;
    if (input.deviceId === null) {
      pending.callback();
      return;
    }
    const device = pending.devices.get(input.deviceId);
    if (!device) {
      pending.callback();
      throw new Error("That USB device was not one of the choices.");
    }
    this.#granted.add(deviceKey(device));
    pending.callback(device.deviceId);
  }

  #select(details: SelectUsbDeviceDetails, callback: (deviceId?: string) => void): void {
    // A newer request replaces an unanswered one, as Chrome's chooser does.
    this.#cancelPending();
    const frame = details.frame;
    if (!frame || frame.parent !== null || !this.#policy.allowsNavigation(frame.url)) {
      callback();
      return;
    }
    // Chromium hands over only devices matching the request's own filters,
    // which this app's page sets to Android's ADB interface. Main cannot check
    // that again: Electron 43 reports one interface per configuration here.
    const devices = details.deviceList;
    const [only] = devices;
    if (devices.length === 0 || !only) {
      callback();
      return;
    }
    if (devices.length === 1) {
      this.#granted.add(deviceKey(only));
      callback(only.deviceId);
      return;
    }
    const choice = DesktopUsbDeviceChoiceSchema.parse({
      choiceId: randomUUID(),
      devices: devices.slice(0, 32).map((device) => ({
        deviceId: device.deviceId,
        name: device.productName?.slice(0, 256) ?? null,
        serialNumber: device.serialNumber?.slice(0, 256) ?? null,
      })),
    });
    this.#pending = {
      callback,
      choiceId: choice.choiceId,
      devices: new Map(devices.map((device) => [device.deviceId, device])),
      frame,
    };
    frame.send(desktopBridgeChannels.usbDeviceChoice, choice);
  }

  #permits(details: DevicePermissionHandlerHandlerDetails): boolean {
    if (details.deviceType !== "usb" || !this.#policy.isAppOrigin(details.origin)) return false;
    const device = UsbDeviceIdentitySchema.safeParse(details.device);
    return device.success && this.#granted.has(deviceKey(device.data));
  }

  #cancelPending(): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.callback();
  }
}

const UsbDeviceIdentitySchema = z.object({
  deviceId: z.string(),
  productId: z.number(),
  serialNumber: z.string().optional(),
  vendorId: z.number(),
});

/**
 * A phone's serial number survives unplugging it, while Electron's device id
 * names one connection; a device without a serial is granted for that
 * connection alone.
 */
function deviceKey(device: z.infer<typeof UsbDeviceIdentitySchema>): string {
  return device.serialNumber
    ? `${device.vendorId}:${device.productId}:${device.serialNumber}`
    : `connection:${device.deviceId}`;
}
