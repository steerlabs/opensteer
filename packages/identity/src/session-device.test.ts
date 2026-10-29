import { describe, expect, it } from "vitest";
import { describeSessionDevice } from "./session-device.js";

/**
 * Every way a device list stops telling a person which device is which,
 * written down before the parser existed. A wrong answer here is worse than
 * "Unknown device": it tells someone that the phone they lost is their laptop.
 */
describe("describeSessionDevice", () => {
  it("says nothing it cannot know about an absent or blank user agent", () => {
    expect(describeSessionDevice(null)).toEqual({ form: null, label: "Unknown device" });
    expect(describeSessionDevice("")).toEqual({ form: null, label: "Unknown device" });
    expect(describeSessionDevice("   ")).toEqual({ form: null, label: "Unknown device" });
  });

  it("never echoes the raw header, however long or strange it is", () => {
    const hostile = `curl/8.7.1 ${"\u0000<script>".repeat(40)}`;
    expect(describeSessionDevice(hostile)).toEqual({ form: null, label: "Unknown device" });
    expect(describeSessionDevice("node")).toEqual({ form: null, label: "Unknown device" });
  });

  it("names the Opensteer desktop app rather than the Chromium inside it", () => {
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Opensteer/0.1.98 Chrome/138.0.7204.100 Electron/37.2.0 Safari/537.36",
      ),
    ).toEqual({ form: "computer", label: "Opensteer app on Mac" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Opensteer/0.1.98 Chrome/138.0.0.0 Electron/37.2.0 Safari/537.36",
      ),
    ).toEqual({ form: "computer", label: "Opensteer app on Windows" });
  });

  it("names the phone app from its native networking stack", () => {
    expect(describeSessionDevice("Opensteer/42 CFNetwork/1568.100.1 Darwin/24.0.0")).toEqual({
      form: "mobile",
      label: "Opensteer app on iOS",
    });
    expect(describeSessionDevice("okhttp/4.12.0")).toEqual({
      form: "mobile",
      label: "Opensteer app on Android",
    });
  });

  it("does not mistake Chrome, Edge or Opera for Safari, which all claim to be", () => {
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toEqual({ form: "computer", label: "Chrome on Mac" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toEqual({ form: "computer", label: "Edge on Windows" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0",
      ),
    ).toEqual({ form: "computer", label: "Opera on Windows" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      ),
    ).toEqual({ form: "computer", label: "Safari on Mac" });
  });

  it("reads iPhone before the “like Mac OS X” every iPhone claims", () => {
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ form: "mobile", label: "Safari on iPhone" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
      ),
    ).toEqual({ form: "mobile", label: "Chrome on iPhone" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/142.0 Mobile/15E148 Safari/605.1.15",
      ),
    ).toEqual({ form: "mobile", label: "Firefox on iPad" });
  });

  it("reads Android before the Linux every Android claims", () => {
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ form: "mobile", label: "Chrome on Android" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
      ),
    ).toEqual({ form: "mobile", label: "Samsung Internet on Android" });
    expect(
      describeSessionDevice("Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0"),
    ).toEqual({ form: "mobile", label: "Firefox on Android" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
      ),
    ).toEqual({ form: "computer", label: "Firefox on Linux" });
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (X11; CrOS x86_64 16181.61.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toEqual({ form: "computer", label: "Chrome on ChromeOS" });
  });

  it("keeps whichever half it does know", () => {
    expect(
      describeSessionDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) SomeBrowser/1.0"),
    ).toEqual({ form: "computer", label: "Browser on Mac" });
    expect(describeSessionDevice("Mozilla/5.0 Firefox/142.0")).toEqual({
      form: null,
      label: "Firefox",
    });
  });
});
