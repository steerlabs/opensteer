import { describe, expect, it } from "vitest";
import type { AuthSessionSummary } from "@opensteer/core";
import { newestNewPhoneSession, phoneOpenUrl } from "./phone-setup.js";

const deploymentId = "dep_6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("phoneOpenUrl", () => {
  it("carries only the computer id, in the fragment, on the portal origin", () => {
    const url = new URL(phoneOpenUrl("https://app.opensteer.test/some/path?x=1", deploymentId));
    expect(url.origin).toBe("https://app.opensteer.test");
    expect(url.pathname).toBe("/open");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#d=${deploymentId}`);
  });
});

describe("newestNewPhoneSession", () => {
  const session = (overrides: Partial<Record<keyof AuthSessionSummary, unknown>>) =>
    ({
      absoluteExpiresAt: "2026-12-01T00:00:00.000Z",
      createdAt: "2026-11-03T10:00:00.000Z",
      current: false,
      deviceLabel: "Opensteer on iPhone",
      expiresAt: "2026-12-01T00:00:00.000Z",
      form: "mobile",
      id: "ses_a",
      lastSeenAt: "2026-11-03T10:00:00.000Z",
      ...overrides,
    }) as AuthSessionSummary;

  it("reports only a phone that signed in after the code appeared", () => {
    const old = session({ id: "ses_old" });
    const computer = session({ form: "computer", id: "ses_mac" });
    const here = session({ current: true, id: "ses_here" });
    const first = session({ createdAt: "2026-11-03T10:05:00.000Z", id: "ses_new1" });
    const second = session({
      createdAt: "2026-11-03T10:06:00.000Z",
      deviceLabel: "Opensteer on Pixel",
      id: "ses_new2",
    });
    const baseline = new Set(["ses_old"]);
    expect(newestNewPhoneSession([old, computer, here], baseline)).toBeNull();
    expect(newestNewPhoneSession([old, first, second], baseline)?.deviceLabel).toBe(
      "Opensteer on Pixel",
    );
  });
});
