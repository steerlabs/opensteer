import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AccountCloudComputerClient,
  cloudComputerFailure,
} from "../connections/account-cloud-computers.js";
import { AccountRequestError } from "../connections/account-deployment-directory.js";
import { MockCloudComputerAccount, mockCloudComputerId } from "../mock/mock-cloud-computers.js";
import {
  CloudComputerClient,
  cloudComputerDeleteInput,
  cloudComputerHomeKind,
  cloudComputerPlanView,
  cloudComputerWebsite,
  cloudSuggestionAllowed,
  cloudSuggestionQuietMs,
  type CloudComputerSchedule,
} from "./cloud-computer.js";

function manualSchedule() {
  const pending: { run: () => void; ms: number }[] = [];
  const schedule: CloudComputerSchedule = (run, ms) => {
    const entry = { run, ms };
    pending.push(entry);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  return {
    schedule,
    pending,
    async fire() {
      const next = pending.shift();
      if (!next) throw new Error("nothing scheduled");
      next.run();
      await vi.waitFor(() => undefined);
    },
  };
}

async function started(account: MockCloudComputerAccount, schedule = manualSchedule()) {
  const store = new CloudComputerClient({ account, schedule: schedule.schedule, locale: "en-US" });
  const stop = store.start();
  await vi.waitFor(() => expect(store.getSnapshot().screen.kind).not.toBe("loading"));
  return { store, stop, schedule };
}

describe("Cloud Computer plan", () => {
  it("prices from the Account's plan in its own currency, never a constant", () => {
    expect(
      cloudComputerPlanView(
        { name: "Cloud", currency: "usd", amountMinor: 2000, interval: "month" },
        "en-US",
      ),
    ).toMatchObject({ price: "$20.00", line: "$20.00 a month" });
    expect(
      cloudComputerPlanView(
        { name: "Cloud", currency: "jpy", amountMinor: 3000, interval: "year" },
        "en-US",
      ).line,
    ).toBe("¥3,000 a year");
    expect(
      cloudComputerPlanView({ name: "Cloud", currency: "eur", amountMinor: 1999 }, "en-US").line,
    ).toBe("€19.99");
  });
});

describe("Cloud Computer screen", () => {
  it("offers one with its price when there is none", async () => {
    const { store, stop } = await started(new MockCloudComputerAccount("none"));
    expect(store.getSnapshot().screen).toMatchObject({
      kind: "offer",
      waiting: false,
      plan: { line: "$20.00 a month" },
    });
    stop();
  });

  it("watches after checkout until the computer it created is ready, then stops", async () => {
    const { store, stop, schedule } = await started(new MockCloudComputerAccount("checkout"));
    expect(schedule.pending).toHaveLength(0);
    store.checkoutOpened();
    await vi.waitFor(() =>
      expect(store.getSnapshot().screen).toMatchObject({ kind: "offer", waiting: true }),
    );
    await vi.waitFor(() => expect(schedule.pending).toHaveLength(1));
    await schedule.fire();
    await vi.waitFor(() => expect(store.getSnapshot().screen.kind).toBe("preparing"));
    expect(store.getSnapshot().screen).toMatchObject({
      computer: { status: { label: "Setting up" }, browserIp: { label: "Being set up" } },
    });
    for (let i = 0; i < 3; i++) await schedule.fire();
    await vi.waitFor(() => expect(store.getSnapshot().screen.kind).toBe("computer"));
    expect(store.getSnapshot().screen).toMatchObject({
      computer: {
        status: { label: "Running", tone: "good" },
        host: "k7q2.cloud.opensteer.example",
        canSuspend: true,
      },
    });
    expect(schedule.pending).toHaveLength(0);
    stop();
  });

  it("reads again on return without depending on a redirect", async () => {
    const account = new MockCloudComputerAccount("none");
    const read = vi.spyOn(account, "read");
    const { store, stop } = await started(account);
    await store.refresh();
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops re-reading when nobody is looking", async () => {
    const { stop, schedule } = await started(new MockCloudComputerAccount("preparing"));
    expect(schedule.pending).toHaveLength(1);
    stop();
    expect(schedule.pending).toHaveLength(0);
  });

  it("shows needs attention and suspended with the Account's own reason, and what can be done", async () => {
    const attention = await started(new MockCloudComputerAccount("attention"));
    expect(attention.store.getSnapshot().screen).toMatchObject({
      kind: "computer",
      computer: {
        status: {
          label: "Needs attention",
          tone: "attention",
          reason: "The computer didn’t start in time. Opensteer is trying again.",
        },
        browserIp: { label: "Browsing paused", tone: "bad" },
        address: null,
        canSuspend: true,
        canResume: false,
      },
    });
    attention.stop();
    const suspended = await started(new MockCloudComputerAccount("suspended"));
    expect(suspended.store.getSnapshot().screen).toMatchObject({
      computer: {
        status: { label: "Suspended", reason: "Suspended by you." },
        canSuspend: false,
        canResume: true,
      },
    });
    suspended.stop();
  });

  it("never draws a fact the Account doesn't report", async () => {
    const { store, stop } = await started(new MockCloudComputerAccount("ready"));
    const screen = store.getSnapshot().screen;
    if (screen.kind !== "computer") throw new Error("not ready");
    expect(screen.computer.unreported).toEqual({
      region: null,
      browserIpAddress: null,
      lastBackupAt: null,
      renewsAt: null,
    });
    stop();
  });

  it("says signed out, unreachable and unavailable as failures, never as an empty offer", async () => {
    for (const scene of ["signed-out", "unreachable", "unavailable"] as const) {
      const { store, stop } = await started(new MockCloudComputerAccount(scene));
      expect(store.getSnapshot().screen).toMatchObject({
        kind: "failed",
        failure: { kind: scene },
      });
      stop();
    }
  });
});

describe("Cloud Computer actions", () => {
  it("suspends, resumes and deletes with the typed confirmation", async () => {
    const { store, stop } = await started(new MockCloudComputerAccount("ready"));
    expect(await store.act({ action: "suspend", id: mockCloudComputerId })).toBe(true);
    expect(store.getSnapshot().screen).toMatchObject({
      computer: { status: { label: "Suspended" } },
    });
    expect(await store.act({ action: "resume", id: mockCloudComputerId })).toBe(true);
    expect(cloudComputerDeleteInput(mockCloudComputerId, "nope")).toBeNull();
    const remove = cloudComputerDeleteInput(mockCloudComputerId, " Delete ");
    expect(remove).toEqual({
      action: "delete",
      id: mockCloudComputerId,
      confirmation: `DELETE:${mockCloudComputerId}`,
    });
    expect(await store.act(remove!)).toBe(true);
    await vi.waitFor(() =>
      expect(store.getSnapshot().screen).toMatchObject({ kind: "offer", deleted: true }),
    );
    stop();
  });

  it("shows the Account's refusal as it is", async () => {
    const { store, stop } = await started(new MockCloudComputerAccount("refused"));
    expect(await store.act({ action: "suspend", id: mockCloudComputerId })).toBe(false);
    expect(store.getSnapshot()).toMatchObject({
      pending: null,
      actionFailure: "Cloud Computers can’t be changed right now. Try again later.",
    });
    store.dismissFailure();
    expect(store.getSnapshot().actionFailure).toBeNull();
    stop();
  });
});

describe("Cloud Computer Account client", () => {
  const id = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-0000000000aa");
  it("calls the Account's paths over the app's one Account client", async () => {
    const accountRequest = vi.fn(async (path: string) =>
      path.endsWith("/cloud-computers")
        ? {
            computers: [],
            plan: { name: "Cloud", currency: "usd", amountMinor: 2000, interval: "month" },
          }
        : { id, egress: "assigned", status: "suspended", reason: "Suspended by you." },
    );
    const client = new AccountCloudComputerClient({ transport: { accountRequest } });
    expect((await client.read()).ok).toBe(true);
    await client.act({ action: "suspend", id });
    await client.act({ action: "delete", id, confirmation: `DELETE:${id}` });
    expect(accountRequest.mock.calls).toEqual([
      ["/v1/account/cloud-computers", { method: "GET" }],
      [`/v1/account/cloud-computers/${id}/suspend`, { method: "POST", body: "{}" }],
      [
        `/v1/account/cloud-computers/${id}`,
        { method: "DELETE", body: JSON.stringify({ confirmation: `DELETE:${id}` }) },
      ],
    ]);
  });

  it("reads a failure as signed out, unreachable or the Account's own refusal", () => {
    expect(
      cloudComputerFailure(
        new AccountRequestError({ code: "unauthorized", status: 401, message: "x" }),
      ).kind,
    ).toBe("signed-out");
    expect(
      cloudComputerFailure(new AccountRequestError({ code: null, status: 503, message: "x" })).kind,
    ).toBe("unreachable");
    expect(
      cloudComputerFailure(
        new AccountRequestError({
          code: "conflict",
          status: 409,
          message: "No Cloud Computers are available right now.",
        }),
      ),
    ).toEqual({
      kind: "refused",
      message: "No Cloud Computers are available right now.",
    });
    expect(cloudComputerFailure(new TypeError("fetch failed")).kind).toBe("unreachable");
    expect(cloudComputerFailure(new Error("Opensteer Account isn't available yet.")).kind).toBe(
      "unavailable",
    );
  });

  it("has no Account to ask in a build without one", async () => {
    expect(await new AccountCloudComputerClient({ transport: null }).read()).toMatchObject({
      ok: false,
      failure: { kind: "unavailable" },
    });
  });
});

describe("where a Cloud Computer is offered", () => {
  it("tells a Mac Home from a server and from the person's Cloud Computer", () => {
    expect(
      cloudComputerHomeKind({
        exposure: "loopback",
        publicOrigin: "http://127.0.0.1:4310",
        cloudAddresses: [],
      }),
    ).toBe("mac");
    expect(
      cloudComputerHomeKind({
        exposure: "networked",
        publicOrigin: "https://home.example",
        cloudAddresses: [],
      }),
    ).toBe("server");
    expect(
      cloudComputerHomeKind({
        exposure: "networked",
        publicOrigin: "https://k7q2.cloud.opensteer.example/",
        cloudAddresses: ["https://k7q2.cloud.opensteer.example"],
      }),
    ).toBe("cloud");
  });

  it("sends checkout and billing to the Opensteer website", () => {
    expect(cloudComputerWebsite("https://app.opensteer.com", "checkout")).toBe(
      "https://app.opensteer.com/cloud-computer/checkout",
    );
    expect(cloudComputerWebsite("https://app.opensteer.com", "billing")).toBe(
      "https://app.opensteer.com/cloud-computer/billing",
    );
  });

  it("suggests again only two weeks after Not now", () => {
    expect(cloudSuggestionAllowed(null, 0)).toBe(true);
    expect(cloudSuggestionAllowed(1_000, 1_000 + cloudSuggestionQuietMs - 1)).toBe(false);
    expect(cloudSuggestionAllowed(1_000, 1_000 + cloudSuggestionQuietMs)).toBe(true);
  });
});
