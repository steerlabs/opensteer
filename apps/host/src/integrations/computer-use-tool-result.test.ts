import { normalizeToolOutput } from "@opensteer/core";
import {
  AndroidPhoneObservationSchema,
  readComputerUseResultHeadline,
  type AndroidPhoneObservation,
  type ComputerUseObservation,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { computerObservationContent } from "./computer-use-tool-result.js";

function observation(overrides: Partial<ComputerUseObservation> = {}): ComputerUseObservation {
  return {
    app: { bundleId: "com.tinyspeck.slackmacgap", displayName: "Slack", teamId: null },
    capturedAt: "2026-09-22T12:00:00.000Z",
    elementCount: 214,
    focusChanged: false,
    geometry: { height: 900, width: 1440 },
    snapshot: "obs_7",
    windows: [],
    blockedBy: [],
    alone: false,
    screenshot: { base64: "AAAA", height: 900, mime: "image/jpeg", width: 1440 },
    tree: '[0] window "Opensteer" (0,0 1440×900)\n[12] button "Opensteer 2" (10,80 40×40)',
    truncated: false,
    window: {
      ref: "window-1",
      id: 7,
      frame: { height: 450, width: 720, x: 0, y: 0 },
      scale: 2,
      title: "Opensteer",
    },
    ...overrides,
  };
}

describe("computer observation emission", () => {
  it("persists text whose first line is the headline a client titles the step with", () => {
    const content = computerObservationContent(observation(), true, "Mac");
    expect(content.map((block) => block.type)).toEqual(["text", "image"]);
    expect(readComputerUseResultHeadline(normalizeToolOutput(content).text)).toBe(
      "Looked at Slack",
    );
  });

  it("keeps the headline readable when the persisted text is cut", () => {
    const result = computerObservationContent(
      observation({ tree: "界".repeat(50000) }),
      false,
      "Mac",
    );

    const persisted = normalizeToolOutput(result);

    expect(persisted.truncation).not.toBeNull();
    expect(readComputerUseResultHeadline(persisted.text)).toBe("Looked at Slack");
  });
});

/*
 * A phone's result must still be titled by the headline every client reads
 * back, and it must say plainly what blocks the agent — a dark screen, a lock
 * screen, or the owner's prompt, during which nothing of the screen is shared
 * — instead of an empty tree a model would read as a blank app.
 */
describe("phone observation emission", () => {
  function phoneObservation(
    overrides: Partial<AndroidPhoneObservation> = {},
  ): AndroidPhoneObservation {
    return AndroidPhoneObservationSchema.parse({
      capturedAt: "2026-10-11T10:00:00.000Z",
      elementCount: 2,
      foreground: { label: "Messages", packageName: "com.google.android.apps.messaging" },
      geometry: { height: 1200, width: 540 },
      locked: false,
      observationId: "pobs_3",
      rotation: 0,
      screen: "on",
      screenshot: { base64: "AAAA", height: 1200, mime: "image/jpeg", width: 540 },
      screenshotUnavailable: null,
      secureLock: false,
      tree: '[0] window "Messages" (0,0 540×1200)\n  [1] button "Send" (440,1100 80×60)',
      truncated: false,
      ...overrides,
    });
  }
  const hidden = {
    elementCount: 0,
    foreground: null,
    screenshot: null,
    tree: "",
    truncated: false,
  } as const;

  it("refuses an observation that shows the Opensteer app, or hides an ordinary app as if it were", () => {
    expect(() =>
      phoneObservation({ foreground: { label: null, packageName: "com.opensteer.agentphone" } }),
    ).toThrow();
    expect(() => phoneObservation({ ...hidden, screenshotUnavailable: "opensteer-app" })).toThrow();
    expect(() =>
      phoneObservation({
        ...hidden,
        foreground: { label: "Messages", packageName: "com.google.android.apps.messaging" },
        screenshotUnavailable: "opensteer-app",
      }),
    ).toThrow();
  });

  it("reports secure lock facts and keeps a failed screenshot tree usable", () => {
    const { text } = normalizeToolOutput(
      computerObservationContent(
        phoneObservation({
          locked: true,
          screenshot: null,
          screenshotUnavailable: "failed",
          secureLock: true,
        }),
        true,
        "Pixel 8",
      ),
    );
    expect(text).toContain("Locked: yes\nSecure lock: yes");
    expect(text.split("\n").at(-1)).toBe(
      "No screenshot could be captured this time; the tree and its coordinates still apply.",
    );
    expect(text).not.toContain("Tell the person");
    expect(text).not.toContain("cannot unlock");
  });
});
