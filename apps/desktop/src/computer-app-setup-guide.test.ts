import type { ComputerUseDataGrant, ComputerUseDataGrants } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ComputerAppSetupGuide,
  computerAppSetupAgentQuietMs,
  dataGrantSettingsUrls,
  type ComputerAppSetupGuideOptions,
} from "./computer-app-setup-guide.js";

/**
 * Every way setting up an app the helper serves could leave the person
 * stuck, written before the guide:
 *
 * - a step that fails or runs out of time ends setup, so the one switch
 *   reading needs is never shown (the incident: Automation timed out at
 *   120 s and Full Disk Access never opened);
 * - the same System Settings pane is opened again on every poll, pulling the
 *   person back from wherever they went;
 * - macOS is asked the same question twice;
 * - a grant macOS refused is asked about again instead of switched on in
 *   System Settings;
 * - a helper that is restarting or briefly unreachable ends setup;
 * - two apps fight over one panel, or one app opens twice;
 * - an agent that keeps failing puts the offer up again and again after the
 *   person said not now;
 * - a renderer names what is dragged.
 */

const missing: ComputerUseDataGrants = {
  automation: "requestable",
  calendars: "requestable",
  contacts: "requestable",
  "full-disk-access": "denied",
  reminders: "requestable",
};

function harness(start: Partial<ComputerUseDataGrants> = {}) {
  let grants: ComputerUseDataGrants = { ...missing, ...start };
  let clock = 1_000_000;
  let reachable = true;
  let ownFullDiskAccess = false;
  /** Reads held here wait until the test lets them through. */
  let grantGate: Promise<void> | null = null;
  let ownGate: Promise<void> | null = null;
  const pendingRequests: {
    readonly grant: ComputerUseDataGrant;
    resolve: (value: ComputerUseDataGrants) => void;
    reject: (error: Error) => void;
  }[] = [];
  const options = {
    appIcon: vi.fn(async (bundleId: string) => `icon:${bundleId}`),
    appName: "Opensteer Beta",
    dataGrants: vi.fn(async () => {
      if (grantGate) await grantGate;
      if (!reachable) throw new Error("This Mac's Computer use helper did not answer in time.");
      return grants;
    }),
    helperAppPath:
      "/Users/person/Library/Application Support/Opensteer/Computer Use/Opensteer Computer Use.app",
    log: vi.fn(),
    now: () => clock,
    openSettings: vi.fn(async (_grant: ComputerUseDataGrant) => undefined),
    ownFullDiskAccess: vi.fn(async () => {
      if (ownGate) await ownGate;
      return ownFullDiskAccess;
    }),
    panel: { close: vi.fn(), open: vi.fn(async () => undefined) },
    requestDataGrant: vi.fn(
      (grant: ComputerUseDataGrant) =>
        new Promise<ComputerUseDataGrants>((resolve, reject) => {
          pendingRequests.push({ grant, reject, resolve });
        }),
    ),
  } satisfies ComputerAppSetupGuideOptions;
  const guide = new ComputerAppSetupGuide(options);
  return {
    guide,
    options,
    pendingRequests,
    give(grant: ComputerUseDataGrant, state: ComputerUseDataGrants[ComputerUseDataGrant]) {
      grants = { ...grants, [grant]: state };
    },
    advance(ms: number) {
      clock += ms;
    },
    setReachable(value: boolean) {
      reachable = value;
    },
    setOwnFullDiskAccess(value: boolean) {
      ownFullDiskAccess = value;
    },
    async poll() {
      return (await guide.status()).setup;
    },
    /** Holds every later grant read; the returned function lets them through. */
    holdGrants() {
      let release = (): void => undefined;
      grantGate = new Promise<void>((resolve) => {
        release = () => {
          grantGate = null;
          resolve();
        };
      });
      return release;
    },
    holdOwnFullDiskAccess() {
      let release = (): void => undefined;
      ownGate = new Promise<void>((resolve) => {
        release = () => {
          ownGate = null;
          resolve();
        };
      });
      return release;
    },
  };
}

describe("the steps", () => {
  it("reads first, then changes, skipping what macOS already gives", async () => {
    const both = harness();
    await both.guide.open({ access: "read-write", definitionId: "apple-messages" });
    expect((await both.poll())?.steps.map(({ grant, kind }) => [grant, kind])).toEqual([
      ["full-disk-access", "settings"],
      ["automation", "ask"],
    ]);

    const sendingOnly = harness({ "full-disk-access": "granted" });
    await sendingOnly.guide.open({ access: "read-write", definitionId: "apple-messages" });
    expect((await sendingOnly.poll())?.steps.map(({ grant }) => grant)).toEqual(["automation"]);

    const readOnly = harness();
    await readOnly.guide.open({ access: "read", definitionId: "apple-messages" });
    expect((await readOnly.poll())?.steps.map(({ grant }) => grant)).toEqual(["full-disk-access"]);
  });

  it("opens nothing when macOS already gives everything", async () => {
    const h = harness({ automation: "granted", "full-disk-access": "granted" });
    expect(await h.guide.open({ access: "read-write", definitionId: "apple-messages" })).toEqual({
      opened: false,
    });
    expect(h.options.panel.open).not.toHaveBeenCalled();
    expect(await h.poll()).toBeNull();
  });

  it("opens a step's System Settings pane once, and again only when the person asks", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    for (let poll = 0; poll < 5; poll += 1) await h.poll();
    expect(h.options.openSettings.mock.calls).toEqual([["full-disk-access"]]);

    await h.guide.openSettings();
    expect(h.options.openSettings.mock.calls).toEqual([["full-disk-access"], ["full-disk-access"]]);
  });

  it("moves on when the grant arrives, and asks macOS the next question once", async () => {
    const h = harness();
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    await h.poll();
    h.give("full-disk-access", "granted");
    const setup = await h.poll();
    expect(setup?.steps.map(({ state }) => state)).toEqual(["done", "current"]);
    for (let poll = 0; poll < 5; poll += 1) await h.poll();
    expect(h.options.requestDataGrant.mock.calls).toEqual([["automation"]]);
  });

  /** The incident: the person answered 35 s after the old flow gave up. */
  it("keeps waiting when macOS's question outlives the helper's deadline", async () => {
    const h = harness({ "full-disk-access": "granted" });
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    await h.poll();
    h.pendingRequests[0]?.reject(
      new Error("This Mac's Computer use helper did not answer in time."),
    );
    h.advance(150_000);
    const waiting = await h.poll();
    expect(waiting?.phase).toBe("steps");
    expect(waiting?.steps).toEqual([{ grant: "automation", kind: "ask", state: "current" }]);

    h.give("automation", "granted");
    expect((await h.poll())?.phase).toBe("done");
  });

  it("turns a refused question into its System Settings switch", async () => {
    const h = harness({ "full-disk-access": "granted" });
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    await h.poll();
    h.give("automation", "denied");
    h.pendingRequests[0]?.resolve({
      ...missing,
      automation: "denied",
      "full-disk-access": "granted",
    });
    await Promise.resolve();
    const setup = await h.poll();
    expect(setup?.steps).toEqual([{ grant: "automation", kind: "settings", state: "current" }]);
    expect(h.options.openSettings.mock.calls).toEqual([["automation"]]);
  });

  /**
   * `unknown` after asking is ambiguous — Messages may not have started, or
   * macOS held the answer for another question — so it is never success: the
   * step stays, and the person's retry asks again.
   */
  it("keeps an unsettled answer as the step, and asks again when the person retries", async () => {
    const h = harness({ "full-disk-access": "granted" });
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    await h.poll();
    h.give("automation", "unknown");
    h.pendingRequests[0]?.resolve({
      ...missing,
      automation: "unknown",
      "full-disk-access": "granted",
    });
    await Promise.resolve();
    const unsettled = await h.poll();
    expect(unsettled?.phase).toBe("steps");
    expect(unsettled?.steps).toEqual([{ grant: "automation", kind: "ask", state: "current" }]);

    await h.guide.openSettings();
    expect(h.options.requestDataGrant.mock.calls).toEqual([["automation"], ["automation"]]);
  });

  /**
   * macOS gives Full Disk Access to a process from its next launch. Whatever
   * the helper's own check says, a helper that still cannot read is asked to
   * look again with a fresh process while the person is on this step.
   */
  it("asks the helper to look again with a fresh process every 10 s while Full Disk Access is the step", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.poll();
    expect(h.options.requestDataGrant).not.toHaveBeenCalled();
    h.advance(5_000);
    await h.poll();
    expect(h.options.requestDataGrant).not.toHaveBeenCalled();
    h.advance(5_100);
    await h.poll();
    await h.poll();
    expect(h.options.requestDataGrant.mock.calls).toEqual([["full-disk-access"]]);
    h.advance(10_100);
    await h.poll();
    expect(h.options.requestDataGrant.mock.calls).toEqual([
      ["full-disk-access"],
      ["full-disk-access"],
    ]);
  });

  /** A restarting helper is gone for a moment; only a longer gap is shown. */
  it("rides out a moment without the helper, says so after 3 s, and carries on when it is back", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.poll();
    h.setReachable(false);
    const blip = await h.poll();
    expect(blip?.helperReachable).toBe(true);
    h.advance(3_100);
    const away = await h.poll();
    expect(away?.helperReachable).toBe(false);
    expect(away?.steps).toEqual([
      { grant: "full-disk-access", kind: "settings", state: "current" },
    ]);
    h.setReachable(true);
    h.give("full-disk-access", "granted");
    const back = await h.poll();
    expect(back?.helperReachable).toBe(true);
    expect(back?.phase).toBe("done");
  });

  it("shows the target app's own icon, asked of the helper once", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.poll();
    const setup = await h.poll();
    expect(setup?.appIconPng).toBe("icon:com.apple.MobileSMS");
    expect(h.options.appIcon).toHaveBeenCalledOnce();
  });
});

describe("the wrong app", () => {
  it("reports whether this app itself has Full Disk Access, checked at most every 3 s", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    expect((await h.poll())?.thisAppHasFullDiskAccess).toBe(false);
    h.setOwnFullDiskAccess(true);
    expect((await h.poll())?.thisAppHasFullDiskAccess).toBe(false);
    h.advance(3_100);
    expect((await h.poll())?.thisAppHasFullDiskAccess).toBe(true);
    expect(h.options.ownFullDiskAccess).toHaveBeenCalledTimes(2);
  });
});

describe("one panel, one app at a time", () => {
  it("queues a second app and opens it when the first is closed; never queues one twice", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    expect((await h.poll())?.definitionId).toBe("apple-messages");

    await h.guide.dismiss({ definitionId: "apple-messages" });
    expect((await h.poll())?.definitionId).toBe("apple-contacts");
    await h.guide.dismiss({ definitionId: "apple-contacts" });
    expect(await h.poll()).toBeNull();
    expect(h.options.panel.close).toHaveBeenCalled();
  });

  it("merges a request for more access into the setup already showing or queued", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    expect((await h.poll())?.steps.map(({ grant }) => grant)).toEqual([
      "full-disk-access",
      "automation",
    ]);

    const queued = harness();
    await queued.guide.open({ access: "read", definitionId: "apple-contacts" });
    queued.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    await vi.waitFor(() => expect(queued.options.dataGrants).toHaveBeenCalledTimes(2));
    await queued.guide.open({ access: "read-write", definitionId: "apple-messages" });
    await queued.guide.dismiss({ definitionId: "apple-contacts" });
    const next = await queued.poll();
    expect(next?.definitionId).toBe("apple-messages");
    expect(next?.phase).toBe("steps");
    expect(next?.steps.map(({ grant }) => grant)).toEqual(["full-disk-access", "automation"]);
  });

  it("skips a queued app whose grants were given meanwhile", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    h.give("contacts", "granted");
    await h.guide.dismiss({ definitionId: "apple-messages" });
    expect(await h.poll()).toBeNull();
  });

  it("closes everything when Opensteer quits", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    h.guide.close();
    expect(await h.poll()).toBeNull();
    expect(h.options.panel.close).toHaveBeenCalled();
    expect(await h.guide.open({ access: "read", definitionId: "apple-messages" })).toEqual({
      opened: false,
    });
  });
});

describe("when an agent finds a grant missing", () => {
  it("offers setup once; Set up starts the steps", async () => {
    const h = harness();
    h.guide.offerForAgent({ access: "read-write", definitionId: "apple-messages" });
    h.guide.offerForAgent({ access: "read-write", definitionId: "apple-messages" });
    await vi.waitFor(() => expect(h.options.panel.open).toHaveBeenCalledOnce());
    const offer = await h.poll();
    expect(offer?.phase).toBe("offer");
    expect(h.options.openSettings).not.toHaveBeenCalled();

    await h.guide.begin();
    const steps = await h.poll();
    expect(steps?.phase).toBe("steps");
    expect(h.options.openSettings.mock.calls).toEqual([["full-disk-access"]]);
  });

  it("stays quiet for that app for 30 minutes after Not now, but not for another app", async () => {
    const h = harness();
    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    await vi.waitFor(() => expect(h.options.panel.open).toHaveBeenCalledOnce());
    await h.guide.dismiss({ definitionId: "apple-messages" });

    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    h.guide.offerForAgent({ access: "read", definitionId: "apple-contacts" });
    await vi.waitFor(async () => expect((await h.poll())?.definitionId).toBe("apple-contacts"));
    await h.guide.dismiss({ definitionId: "apple-contacts" });

    h.advance(computerAppSetupAgentQuietMs + 1);
    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    await vi.waitFor(async () => expect((await h.poll())?.definitionId).toBe("apple-messages"));
  });

  it("starts the steps when the person asks for the app the offer is already showing", async () => {
    const h = harness();
    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    await vi.waitFor(() => expect(h.options.panel.open).toHaveBeenCalledOnce());
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    expect((await h.poll())?.phase).toBe("steps");
  });
});

/**
 * Every await is a moment the person or another caller can change what is
 * showing: written before the guide re-checked after each one.
 */
describe("races", () => {
  it("asks nothing for a setup dismissed while its grants were being read", async () => {
    const h = harness();
    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    await vi.waitFor(() => expect(h.options.panel.open).toHaveBeenCalledOnce());
    const release = h.holdGrants();
    const beginning = h.guide.begin();
    await h.guide.dismiss({ definitionId: "apple-messages" });
    release();
    await beginning;
    expect(h.options.openSettings).not.toHaveBeenCalled();
    expect(h.options.requestDataGrant).not.toHaveBeenCalled();
  });

  it("answers a status read for the setup showing when it returns, not the one it began with", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    const release = h.holdOwnFullDiskAccess();
    const reading = h.guide.status();
    await vi.waitFor(() => expect(h.options.ownFullDiskAccess).toHaveBeenCalledOnce());
    await h.guide.dismiss({ definitionId: "apple-messages" });
    release();
    expect((await reading).setup?.definitionId).toBe("apple-contacts");
  });

  it("closes only the setup the panel names, never the one that replaced it", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    await h.guide.dismiss({ definitionId: "apple-messages" });
    await h.guide.dismiss({ definitionId: "apple-messages" });
    expect((await h.poll())?.definitionId).toBe("apple-contacts");
  });

  it("begins nothing when Set up answers an offer another app already replaced", async () => {
    const h = harness();
    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    await vi.waitFor(() => expect(h.options.panel.open).toHaveBeenCalledOnce());
    h.guide.offerForAgent({ access: "read", definitionId: "apple-contacts" });
    await vi.waitFor(() => expect(h.options.dataGrants).toHaveBeenCalledTimes(2));
    await h.guide.dismiss({ definitionId: "apple-messages" });
    await h.guide.begin({ definitionId: "apple-messages" });
    const setup = await h.poll();
    expect(setup?.definitionId).toBe("apple-contacts");
    expect(setup?.phase).toBe("offer");
    expect(h.options.openSettings).not.toHaveBeenCalled();
  });

  it("starts one setup when two callers open the same app at once", async () => {
    const h = harness();
    const release = h.holdGrants();
    const first = h.guide.open({ access: "read", definitionId: "apple-messages" });
    const second = h.guide.open({ access: "read", definitionId: "apple-messages" });
    release();
    await Promise.all([first, second]);
    await h.guide.dismiss({ definitionId: "apple-messages" });
    expect(await h.poll()).toBeNull();
  });

  it("widens the showing setup when an agent needs more of it", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    h.guide.offerForAgent({ access: "read-write", definitionId: "apple-messages" });
    await vi.waitFor(async () =>
      expect((await h.poll())?.steps.map(({ grant }) => grant)).toEqual([
        "full-disk-access",
        "automation",
      ]),
    );
  });

  it("gives the person the steps when they ask for the app an offer is still starting", async () => {
    const h = harness();
    const release = h.holdGrants();
    h.guide.offerForAgent({ access: "read", definitionId: "apple-messages" });
    const opening = h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    release();
    await opening;
    await vi.waitFor(() => expect(h.options.panel.open).toHaveBeenCalled());
    const setup = await h.poll();
    expect(setup?.phase).toBe("steps");
    expect(setup?.steps.map(({ grant }) => grant)).toEqual(["full-disk-access", "automation"]);
  });

  it("keeps a wider request to try again when the read for it failed", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    h.setReachable(false);
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    h.setReachable(true);
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    expect((await h.poll())?.steps.map(({ grant }) => grant)).toEqual([
      "full-disk-access",
      "automation",
    ]);
  });

  it("opens nothing more once Opensteer quits, even for a read still on its way", async () => {
    const h = harness();
    await h.guide.open({ access: "read", definitionId: "apple-messages" });
    await h.guide.open({ access: "read", definitionId: "apple-contacts" });
    const release = h.holdGrants();
    const moving = h.guide.dismiss({ definitionId: "apple-messages" });
    h.guide.close();
    release();
    await moving;
    expect(h.options.panel.open).toHaveBeenCalledOnce();
    expect(await h.poll()).toBeNull();
  });
});

describe("dragging the helper into the list", () => {
  it("drags the installed helper, only while the Full Disk Access switch is the step", async () => {
    const h = harness({ "full-disk-access": "granted" });
    await h.guide.open({ access: "read-write", definitionId: "apple-messages" });
    await h.poll();
    expect(h.guide.dragItem()).toBeNull();

    const reading = harness();
    await reading.guide.open({ access: "read", definitionId: "apple-messages" });
    await reading.poll();
    expect(reading.guide.dragItem()).toEqual({ file: reading.options.helperAppPath });
  });
});

describe("System Settings", () => {
  it("opens each grant's own Privacy pane, named as macOS names it", () => {
    const pane = (name: string) =>
      `x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_${name}`;
    expect(dataGrantSettingsUrls).toEqual({
      automation: pane("Automation"),
      calendars: pane("Calendars"),
      contacts: pane("Contacts"),
      "full-disk-access": pane("AllFiles"),
      reminders: pane("Reminders"),
    });
  });
});
