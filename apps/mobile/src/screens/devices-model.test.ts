import type { AuthSessionSummary } from "@opensteer/core";
import type { MachineSummary } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { deviceListSections } from "./devices-model.js";

const home = "rnr_11111111-1111-4111-8111-111111111111";
const phone = "rnr_22222222-2222-4222-8222-222222222222";
const laptop = "rnr_33333333-3333-4333-8333-333333333333";

const machine = (overrides: Partial<MachineSummary>) =>
  ({
    access: null,
    allowedModules: ["browser", "integrations"],
    apps: null,
    computerUse: null,
    device: null,
    expiresAt: null,
    lastSeenAt: null,
    modules: {},
    ownerName: null,
    ownership: "mine",
    status: "online",
    ...overrides,
  }) as MachineSummary;

const machines = [
  machine({
    id: laptop,
    kind: "computer",
    name: "MacBook Pro (2)",
    device: { form: "laptop", platform: "macos" },
  }),
  machine({
    id: phone,
    kind: "phone",
    name: "Alex's iPhone",
    device: { form: "phone", platform: "ios" },
  }),
  machine({
    allowedModules: ["agents", "browser", "shell"],
    device: { form: "compact", platform: "macos" },
    id: home,
    kind: "home",
    name: "Mac mini",
    ownership: "deployment",
  }),
];

const session = (overrides: Partial<Omit<AuthSessionSummary, "id">> & { readonly id?: string }) =>
  ({
    absoluteExpiresAt: "2026-12-12T00:00:00.000Z",
    createdAt: "2026-11-12T00:00:00.000Z",
    current: false,
    deviceId: null,
    deviceLabel: "Chrome on Mac",
    expiresAt: "2026-11-19T00:00:00.000Z",
    form: "computer",
    id: "ses_1",
    lastSeenAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  }) as AuthSessionSummary;

describe("Devices on the phone", () => {
  it("lists this phone and Home first, then other devices, then sessions that run nothing", () => {
    const sections = deviceListSections({
      here: { state: "member", runnerId: phone },
      machines,
      noun: "iPhone",
      sessions: [
        session({
          current: true,
          deviceId: phone,
          id: "ses_here",
          deviceLabel: "Opensteer for iPhone",
        }),
        session({ id: "ses_web" }),
        session({ id: "ses_old", deviceLabel: "Opensteer for iPhone", form: "mobile" }),
      ],
    });
    expect(
      sections.map((section) => ({
        title: section.title,
        rows: section.rows.map(({ title, detail }) => `${title} — ${detail}`),
      })),
    ).toEqual([
      {
        title: "",
        rows: ["Alex's iPhone — This iPhone · Online", "Mac mini — Home · your agent runs here"],
      },
      { title: "Other devices", rows: ["MacBook Pro (2) — Online"] },
      {
        title: "Also signed in",
        rows: ["Chrome on Mac — Signed in", "Opensteer for iPhone — Update to finish setup"],
      },
    ]);
    expect(sections[2]?.footer).toBe("These run nothing. Your agent can't use them.");
    expect(sections[0]?.rows.map(({ symbol }) => symbol)).toEqual(["smartphone", "macmini"]);
  });

  it("offers an explicit move for a phone set up with another Opensteer, never a second device row", () => {
    const sections = deviceListSections({
      here: { state: "elsewhere", deploymentId: "dep_home", deploymentName: "Home" },
      machines: machines.filter(({ id }) => id !== phone),
      noun: "iPhone",
      sessions: [session({ current: true, id: "ses_here", deviceLabel: "Opensteer for iPhone" })],
    });
    expect(sections[0]?.rows[0]).toMatchObject({
      title: "This iPhone",
      detail: "Set up with Home",
      opens: { kind: "use-here", elsewhere: "dep_home", elsewhereName: "Home" },
    });
    // Its own session here is the phone, not something else signed in.
    expect(sections.some((section) => section.key === "signed-in")).toBe(false);
  });

  it("leads a phone not yet set up here back into setup", () => {
    const [first] = deviceListSections({
      here: { state: "needs-setup", deviceName: "Alex's iPhone" },
      machines: machines.filter(({ id }) => id !== phone),
      noun: "iPhone",
      sessions: [],
    });
    expect(first?.rows[0]).toMatchObject({
      detail: "This iPhone · Finish setting up",
      opens: { kind: "set-up" },
    });
  });
});
