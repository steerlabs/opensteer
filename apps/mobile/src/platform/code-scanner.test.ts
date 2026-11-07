import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (result: { readonly data: unknown }) => void;

const native = vi.hoisted(() => ({
  os: "android" as "android" | "ios",
  permission: { canAskAgain: true, granted: true },
  listener: null as Listener | null,
  dismiss: vi.fn(),
  launch: vi.fn(),
  request: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));
vi.mock("expo-camera", () => ({
  Camera: {
    getCameraPermissionsAsync: async () => native.permission,
    requestCameraPermissionsAsync: native.request,
  },
  CameraView: {
    dismissScanner: native.dismiss,
    isModernBarcodeScannerAvailable: true,
    launchScanner: native.launch,
    onModernBarcodeScanned: (listener: Listener) => {
      native.listener = listener;
      return {
        remove: () => {
          if (native.listener === listener) native.listener = null;
        },
      };
    },
  },
}));

async function scanner() {
  vi.resetModules();
  return (await import("./code-scanner.js")).scanQrCode;
}

beforeEach(() => {
  native.os = "android";
  native.permission = { canAskAgain: true, granted: true };
  native.listener = null;
  native.launch.mockReset();
  native.request.mockReset();
  native.dismiss.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the system code scanner", () => {
  it("reads one code on Android, and closing the scanner is not a failure", async () => {
    const scan = await scanner();
    native.launch.mockImplementationOnce(async () => native.listener?.({ data: "code" }));
    await expect(scan()).resolves.toEqual({ kind: "scanned", text: "code" });

    native.launch.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), { code: "ERR_BARCODE_SCANNING_CANCELLED" }),
    );
    await expect(scan()).resolves.toEqual({ kind: "cancelled" });

    native.launch.mockRejectedValueOnce(
      Object.assign(new Error("no Play services"), {
        code: "ERR_GOOGLE_PLAY_SERVICES_UNAVAILABLE",
      }),
    );
    await expect(scan()).resolves.toEqual({ kind: "unavailable" });
  });

  it("asks for the camera on iOS, and hands the code on once its scanner has gone", async () => {
    vi.useFakeTimers();
    native.os = "ios";
    native.permission = { canAskAgain: true, granted: false };
    native.request.mockResolvedValueOnce({ canAskAgain: true, granted: true });
    native.launch.mockResolvedValueOnce(undefined);
    const scan = await scanner();

    const outcome = scan();
    await vi.waitFor(() => expect(native.listener, "the scanner never started").not.toBeNull());
    native.listener!({ data: "code" });
    native.listener?.({ data: "code" });
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(outcome).resolves.toEqual({ kind: "scanned", text: "code" });
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.dismiss).toHaveBeenCalledOnce();
  });

  it("says when the camera is off on iOS, without opening the scanner", async () => {
    native.os = "ios";
    native.permission = { canAskAgain: false, granted: false };
    const scan = await scanner();

    await expect(scan()).resolves.toEqual({ kind: "camera-denied" });
    expect(native.launch).not.toHaveBeenCalled();
  });

  it("settles a scanner swiped away on iOS when the next scan starts", async () => {
    native.os = "ios";
    native.launch.mockResolvedValue(undefined);
    const scan = await scanner();

    const forgotten = scan();
    await vi.waitFor(() => expect(native.listener, "the scanner never started").not.toBeNull());
    void scan();

    await expect(forgotten).resolves.toEqual({ kind: "cancelled" });
  });
});
