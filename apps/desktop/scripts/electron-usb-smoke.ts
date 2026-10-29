import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
/**
 * The desktop's WebUSB authority on the pinned Electron, as Add a phone uses it.
 *
 * Electron asks three questions on the way to a phone, each with its own
 * context, and setup fails if any answer is wrong:
 *
 * 1. May this origin request a device? Asked with an origin only. Refusing the
 *    app's own page rejects every request before a device is offered, which
 *    the page reports as "No phone was chosen".
 * 2. Which device? Asked with the requesting frame. A frame other than the
 *    app's main frame, or a page off the app's origin, must get nothing, even
 *    with a phone attached; the main frame gets its only phone.
 * 3. May the page open this device? Asked per device. Only the device the
 *    person picked may be reached again; any other device stays invisible.
 *
 * Every other permission stays denied. No request may hang: an empty list is
 * an immediate "nothing chosen".
 *
 * Without hardware this proves questions 1 and 2 reach device selection and
 * nothing hangs. With `OPENSTEER_USB_SMOKE_PHONE_SERIAL` naming a plugged-in
 * phone with USB debugging on, it also proves the phone is offered to the main
 * frame alone and is the only device granted. The phone is never opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, protocol, session, type Session } from "electron";
import { desktopAppEntryUrl, registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { configureDesktopSession } from "../src/app/electron-window.js";
import { DesktopAppOriginPolicy } from "../src/app/navigation-policy.js";
import { DesktopUsbDeviceAccess } from "../src/app/usb-device-access.js";
import type { UsbSmokeChoice } from "./electron-usb-renderer-smoke.js";

const smokeDownloads = smokeDesktopDownloads();

const expectedPhone = process.env.OPENSTEER_USB_SMOKE_PHONE_SERIAL?.trim() || null;
const artifactDirectory =
  process.env.OPENSTEER_USB_E2E_ARTIFACT_DIR ?? path.join(tmpdir(), "opensteer-usb-e2e");
const userData = mkdtempSync(path.join(tmpdir(), "opensteer-usb-smoke-"));
app.setPath("userData", userData);
registerDesktopAppScheme(protocol);

interface PermissionCheck {
  readonly allowed: boolean;
  readonly isMainFrame: boolean;
  readonly permission: string;
  readonly requestingOrigin: string;
  readonly webContents: boolean;
}
interface DeviceSelection {
  readonly devices: string[];
  readonly frameIsMain: boolean;
  readonly frameUrl: string | null;
}
interface DevicePermission {
  readonly allowed: boolean;
  readonly origin: string;
  readonly serialNumber: string | null;
}

const checks: PermissionCheck[] = [];
const selections: DeviceSelection[] = [];
const devicePermissions: DevicePermission[] = [];
const cases: object[] = [];
const liveness = setInterval(() => undefined, 1_000);
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});
app.on("window-all-closed", () => undefined);

void run().then(
  () => finish(null),
  (error: unknown) => finish(error),
);

async function run(): Promise<void> {
  await app.whenReady();
  const renderer = readFileSync(
    path.join(import.meta.dirname, "usb-renderer-smoke.global.js"),
    "utf8",
  );
  protocol.handle("app", (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/renderer.js") {
      return new Response(renderer, { headers: { "content-type": "text/javascript" } });
    }
    const frame = pathname === "/" ? '<iframe src="/frame"></iframe>' : "";
    return new Response(
      `<!doctype html><meta charset="utf-8"><script src="/renderer.js"></script>${frame}`,
      { headers: { "content-type": "text/html" } },
    );
  });

  // Main's own wiring of its session, observed rather than replaced.
  const desktop = session.defaultSession;
  observe(desktop);
  const usbDevices = new DesktopUsbDeviceAccess();
  configureDesktopSession(desktop, new DesktopAppOriginPolicy(), usbDevices, smokeDownloads);
  const detach = usbDevices.attach(desktop);
  desktop.on("select-usb-device", (_event, details) => {
    selections.push({
      devices: details.deviceList.map((device) => device.serialNumber ?? device.productName ?? ""),
      frameIsMain: details.frame?.parent === null,
      frameUrl: details.frame?.url ?? null,
    });
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  try {
    await window.loadURL(desktopAppEntryUrl);
    const main = window.webContents.mainFrame;
    const sub = main.frames[0];
    assert(sub, "The app page's subframe did not load.");

    const mainSelectionsBefore = selections.length;
    const mainChoice = await choose(() => main.executeJavaScript("window.usbSmoke.choose()", true));
    const mainSelection = selections.slice(mainSelectionsBefore);
    const usbChecks = checks.filter((check) => check.permission === "usb");
    assert(
      usbChecks.some((check) => check.allowed),
      `Electron asked whether the app may request a USB device and was refused: ${JSON.stringify(usbChecks)}`,
    );
    assert.equal(
      mainSelection.length,
      1,
      "The app's main frame asked for a phone but no device selection followed.",
    );
    assert.equal(mainSelection[0]?.frameIsMain, true);
    assert.equal(mainSelection[0]?.frameUrl, desktopAppEntryUrl);
    if (expectedPhone) {
      assert(
        mainSelection[0]?.devices.includes(expectedPhone),
        `Phone ${expectedPhone} was not among the devices offered: ${JSON.stringify(mainSelection[0]?.devices)}`,
      );
      assert.deepEqual(mainChoice.result, { kind: "chosen", opened: false, serial: expectedPhone });
    } else {
      assert.deepEqual(
        mainSelection[0]?.devices,
        [],
        "An ADB device is attached; name it with OPENSTEER_USB_SMOKE_PHONE_SERIAL.",
      );
      assert.deepEqual(mainChoice.result, { kind: "none" });
    }
    cases.push({ case: "main-frame-reaches-device-selection", ...mainChoice, mainSelection });

    const granted = (await main.executeJavaScript("window.usbSmoke.granted()", true)) as {
      phones: string[];
      devices: string[];
    };
    const expectedGrant =
      expectedPhone && mainChoice.result.kind === "chosen" ? [expectedPhone] : [];
    assert.deepEqual(granted.phones, expectedGrant);
    assert.deepEqual(granted.devices, expectedGrant);
    assert(
      devicePermissions
        .filter((check) => expectedPhone === null || check.serialNumber !== expectedPhone)
        .every((check) => !check.allowed),
      `A device nobody picked was granted: ${JSON.stringify(devicePermissions)}`,
    );
    cases.push({ case: "only-the-picked-device-is-granted", granted, devicePermissions });

    const subSelectionsBefore = selections.length;
    const subChoice = await choose(() => sub.executeJavaScript("window.usbSmoke.choose()", true));
    const subSelection = selections.slice(subSelectionsBefore);
    assert.equal(subSelection.length, 1, "The subframe's request never reached device selection.");
    assert.equal(subSelection[0]?.frameIsMain, false);
    assert.deepEqual(subChoice.result, { kind: "none" });
    cases.push({
      case: "subframe-gets-no-device",
      proves: expectedPhone ? "frame rule with a phone attached" : "no device without hardware",
      ...subChoice,
      subSelection,
    });

    const otherChecks = checks.filter((check) => check.permission !== "usb");
    assert(
      otherChecks.every((check) => !check.allowed),
      `A permission other than USB was allowed: ${JSON.stringify(otherChecks)}`,
    );
    cases.push({ case: "every-other-permission-denied", otherChecks });
  } finally {
    window.destroy();
    detach();
  }
}

/** One request, which must answer rather than hang. */
async function choose(
  request: () => Promise<unknown>,
): Promise<{ elapsedMs: number; result: UsbSmokeChoice }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    request() as Promise<UsbSmokeChoice>,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("A USB device request did not answer.")), 15_000);
    }),
  ]).finally(() => clearTimeout(timer));
  return { elapsedMs: Math.round(performance.now() - started), result };
}

/** Records each answer main gives Electron, with the context Electron gave it. */
function observe(target: Session): void {
  const setPermissionCheck = target.setPermissionCheckHandler.bind(target);
  target.setPermissionCheckHandler = (handler) =>
    setPermissionCheck(
      handler &&
        ((webContents, permission, requestingOrigin, details) => {
          const allowed = handler(webContents, permission, requestingOrigin, details);
          checks.push({
            allowed,
            isMainFrame: details.isMainFrame,
            permission,
            requestingOrigin,
            webContents: webContents !== null,
          });
          return allowed;
        }),
    );
  const setDevicePermission = target.setDevicePermissionHandler.bind(target);
  target.setDevicePermissionHandler = (handler) =>
    setDevicePermission(
      handler &&
        ((details) => {
          const allowed = handler(details);
          const device = details.device as { serialNumber?: string };
          devicePermissions.push({
            allowed,
            origin: details.origin,
            serialNumber: device.serialNumber ?? null,
          });
          return allowed;
        }),
    );
}

function finish(error: unknown): void {
  finished = true;
  clearInterval(liveness);
  const report = {
    chrome: process.versions.chrome,
    checks,
    devicePermissions,
    electron: process.versions.electron,
    error: error ? (error instanceof Error ? error.stack : String(error)) : null,
    expectedPhone,
    cases,
    selections,
  };
  void mkdir(artifactDirectory, { recursive: true })
    .then(() =>
      writeFile(path.join(artifactDirectory, "usb.json"), `${JSON.stringify(report, null, 2)}\n`),
    )
    .finally(() => {
      // Chromium may still be writing its profile; a leftover temporary
      // directory must not keep the smoke from reporting.
      try {
        rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
      if (error) {
        process.stderr.write(
          `${JSON.stringify({ event: "electron-usb-smoke.failed", error: report.error })}\n`,
        );
        app.exit(1);
      } else {
        process.stdout.write(`${JSON.stringify({ event: "electron-usb-smoke.passed" })}\n`);
        app.quit();
      }
    });
}
