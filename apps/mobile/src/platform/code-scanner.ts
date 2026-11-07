import { Platform } from "react-native";

export type CodeScan =
  | { readonly kind: "scanned"; readonly text: string }
  | { readonly kind: "cancelled" }
  /** iOS only: the camera is off for Opensteer and only Settings can turn it on. */
  | { readonly kind: "camera-denied" }
  | { readonly kind: "unavailable" };

/** Longer than UIKit's sheet dismissal. */
const iosScannerDismissalMilliseconds = 600;

let launching = false;
let settlePrevious: (() => void) | null = null;

/**
 * Reads one QR code with the system's own scanner: VisionKit's data scanner on
 * iOS, and the Google code scanner on Android, which runs in Play services and
 * needs no camera permission of this app's.
 *
 * The camera module is loaded here rather than at startup, so a build without
 * it still runs and only scanning is unavailable.
 */
export async function scanQrCode(): Promise<CodeScan> {
  // A second tap while the scanner is still coming up is the same request.
  if (launching) return { kind: "cancelled" };
  launching = true;
  let presented: { readonly outcome: Promise<CodeScan> };
  try {
    presented = await present();
  } finally {
    launching = false;
  }
  return presented.outcome;
}

async function present(): Promise<{ readonly outcome: Promise<CodeScan> }> {
  // iOS says nothing when its scanner is swiped away, so a new scan settles one left open.
  settlePrevious?.();
  let camera: typeof import("expo-camera");
  try {
    camera = await import("expo-camera");
  } catch {
    return { outcome: Promise.resolve({ kind: "unavailable" }) };
  }
  const { Camera, CameraView } = camera;
  if (!CameraView.isModernBarcodeScannerAvailable) {
    return { outcome: Promise.resolve({ kind: "unavailable" }) };
  }
  if (Platform.OS === "ios") {
    let permission = await Camera.getCameraPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Camera.requestCameraPermissionsAsync();
    }
    if (!permission.granted) return { outcome: Promise.resolve({ kind: "camera-denied" }) };
  }
  let settle: (scan: CodeScan) => void = () => undefined;
  const outcome = new Promise<CodeScan>((resolve) => {
    let settled = false;
    settle = (scan) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      if (settlePrevious === cancel) settlePrevious = null;
      resolve(scan);
    };
  });
  const cancel = (): void => settle({ kind: "cancelled" });
  let heard = false;
  const subscription = CameraView.onModernBarcodeScanned((result) => {
    if (heard || typeof result.data !== "string") return;
    heard = true;
    const scanned = { kind: "scanned", text: result.data } as const;
    // Android closes its scanner itself; iOS keeps reading until told to stop.
    if (Platform.OS !== "ios") {
      settle(scanned);
      return;
    }
    void CameraView.dismissScanner().catch(() => undefined);
    // That resolves before UIKit finishes the dismissal, and a React Native
    // Modal presented during it is dropped, so the code is handed on after.
    setTimeout(() => settle(scanned), iosScannerDismissalMilliseconds);
  });
  settlePrevious = cancel;
  try {
    // iOS answers once the scanner is up; Android once it has read a code.
    await CameraView.launchScanner({ barcodeTypes: ["qr"], isHighlightingEnabled: true });
  } catch (error) {
    settle(
      isCode(error, "ERR_BARCODE_SCANNING_CANCELLED")
        ? { kind: "cancelled" }
        : { kind: "unavailable" },
    );
  }
  return { outcome };
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
