import {
  chooseAgentPhone,
  grantedAgentPhones,
} from "../../../packages/agent-phone-setup/src/webusb.js";

/** What a page of the app learns when it asks for a phone the way setup does. */
export type UsbSmokeChoice =
  | { readonly kind: "chosen"; readonly opened: boolean; readonly serial: string }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly error: string };

declare global {
  interface Window {
    usbSmoke: {
      readonly choose: () => Promise<UsbSmokeChoice>;
      readonly granted: () => Promise<{ readonly phones: string[]; readonly devices: string[] }>;
    };
  }
}

window.usbSmoke = {
  // Setup's own call, with Tango's ADB interface filter and its check of the
  // device main hands back; the phone is never opened.
  choose: async () => {
    try {
      const phone = await chooseAgentPhone(navigator.usb);
      return phone
        ? { kind: "chosen", opened: phone.raw.opened, serial: phone.serial }
        : { kind: "none" };
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.name : String(error) };
    }
  },
  granted: async () => ({
    devices: (await navigator.usb.getDevices()).map((device) => device.serialNumber ?? ""),
    phones: (await grantedAgentPhones(navigator.usb)).map((phone) => phone.serial),
  }),
};
