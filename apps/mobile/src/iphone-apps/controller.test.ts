import { HostClientRequestError, type HostClient } from "@opensteer/client/host";
import type { HostApiCommandInput } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import { IphoneAppsController, type IphoneAppsTiming } from "./controller.js";
import type { ShownApproval, ShownApprovalsFile } from "./shown-approvals-file.js";
import { createFakeIphoneApps, type FakeIphoneApps } from "./fake-bridge.js";

/*
 * The JS controller over the native iPhone apps bridge. The bridge here is the
 * labelled JS fake: these tests prove the controller's sequencing against the
 * pinned bridge contract, not Swift, iOS prompts or a Host.
 *
 * Failure cases, written before the controller:
 * - J3: a Host without `iphone-apps-v1` is asked to mint an iPhone enrollment;
 * - J4: an iPhone held by another Deployment, or already added here, mints again;
 * - J5: a lost mint answer uses a new idempotency key; an expired or refused
 *   enrollment is retried without retiring it, retried more than three times,
 *   or retried after the Host said it was still usable; a pairing target for
 *   another Deployment is enrolled anyway;
 * - J6: an approval that is not in the iPhone's current list, or that names a
 *   different app or access than the one tapped, is signed;
 * - J7: the approval key is registered more than once per connection, before
 *   the iPhone is online, or for a Deployment other than the one it holds;
 * - J8: an OS prompt happens without a tap, or the signature starts before the
 *   prompt settles; a request is sent or signed after iOS refused the app (a
 *   task's request is then left waiting, not declined);
 * - C5–C8: a lost answer from the Host is taken as "off" or asked again blindly,
 *   rather than read back from the Host's own requests and connections;
 * - C9/C10: an upgrade in flight hides the current access, or outlives a stop;
 * - C12: read-back releases the busy state before it settles, allowing a second
 *   request, or leaves the approving state behind after it succeeds;
 * - C13: changing the attached Deployment strands a superseded change forever;
 * - a late outcome after the iPhone was stopped changes anything, or an
 *   operation started for one Deployment completes against another;
 * - switching the open Deployment stops the iPhone;
 * - a request is auto-shown twice.
 *
 * Location and Photos, written before the controller took them:
 * - B5: iOS is asked, or the Host is sent a request, for an app the attached
 *   Host's catalog doesn't list (an older Host), or while that catalog can't
 *   be read; a missing catalog is taken as "listed";
 * - an installed build that doesn't report an app's permission (an older
 *   build) is prompted, sent a request, signs a task's request or is asked to
 *   choose photos for it, because the Host knows the app;
 * - limited is taken as Location permission, or limited Photos isn't usable;
 * - Choose photos runs without limited access, or closing it reads as denied;
 * - a task's Location request after a temporary permission ended signs
 *   without asking iOS again, or signs after iOS refused;
 * - a lost reply to a signed Photos answer is taken as "off" or signed twice.
 */

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const otherDeploymentId = "dep_0192f4a1-4444-4000-8000-000000000004";
const fast: IphoneAppsTiming = { approvalWaitMs: 50, enrollWaitMs: 50, revokeMs: 50 };
// These cases need pending approvals, even after the calendar date the test was written.
const approvalExpiresAt = new Date(Date.now() + 600_000).toISOString();
const pairing = {
  deploymentId,
  deploymentName: "Mac mini",
  hostInstanceId: "hst_0192f4a1-0000-4000-8000-000000000002",
  hostUrl: "https://mac-mini.example.test",
};

const controllers: IphoneAppsController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
});

describe("adding this iPhone", () => {
  it("J3: never mints for a Host that does not offer iPhone apps", async () => {
    const { controller, fake } = open();
    const host = fakeHost();

    const outcome = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: false,
      name: "Alex's iPhone",
    });

    expect(outcome).toEqual({ failure: { kind: "host-update" }, kind: "failed" });
    expect(host.commands).toEqual([]);
    expect(fake.device.calls).toEqual([]);
  });

  it("J4: never mints while another Deployment holds this iPhone, or once it is added", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId: otherDeploymentId, name: "Alex's iPhone" });
    const host = fakeHost();

    const elsewhere = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });
    expect(elsewhere).toEqual({ failure: { kind: "enrolled-elsewhere" }, kind: "failed" });

    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const already = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });
    expect(already).toMatchObject({ kind: "added" });
    expect(host.commands).toEqual([]);
    expect(fake.device.calls.filter((call) => call !== "getSnapshot")).toEqual([]);
  });

  it("J5: retries a lost mint answer once with the same key, then enrolls the Host's target", async () => {
    const { controller, fake } = open({ autoConnect: true });
    let lost = true;
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "runner.enrollment.createPhone") return undefined;
        if (lost) {
          lost = false;
          throw new Error("The connection was lost.");
        }
        return mint(command);
      },
    });

    const outcome = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });

    expect(outcome).toMatchObject({ kind: "added" });
    const mints = host.sent.filter(({ type }) => type === "runner.enrollment.createPhone");
    expect(mints).toHaveLength(2);
    expect(mints[0]).toMatchObject({ name: "Alex's iPhone", profile: "iphone" });
    expect(mints[1]?.idempotencyKey).toBe(mints[0]?.idempotencyKey);
    expect(mints[0]?.idempotencyKey).toBe(fake.device.mintKey());
    expect(fake.device.calls).toEqual(["prepare", "enroll"]);
  });

  it("recovers an unminted identity held by another Deployment without disturbing an enrollment", async () => {
    const { controller, fake } = open({ autoConnect: true });
    const refused = fakeHost({
      dispatch: () => {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Turn on remote access first.",
          reason: "personal-remote-access-off",
          status: 409,
        });
      },
    });
    expect(
      await controller.add({
        deploymentId: otherDeploymentId,
        hostClient: refused.client,
        iphoneAppsAvailable: true,
        name: "Alex's iPhone",
      }),
    ).toMatchObject({ kind: "failed" });
    expect(fake.bridge.getSnapshot().enrollment).toBeNull();
    const host = fakeHost({ dispatch: mint });
    expect(
      await controller.add({
        deploymentId,
        hostClient: host.client,
        iphoneAppsAvailable: true,
        name: "Alex's iPhone",
      }),
    ).toMatchObject({ kind: "added" });
    expect(fake.device.calls).toEqual(["prepare", "prepare", "disconnect", "prepare", "enroll"]);
    expect(host.commands).toEqual(["runner.enrollment.createPhone"]);
  });

  it("J5: retires an expired enrollment, rotates the key and tries at most three times", async () => {
    const { controller, fake } = open();
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type === "runner.enrollment.createPhone") return mint(command);
        if (command.type === "runner.enrollment.retire") {
          return { state: "expired", type: "runner.enrollment.retire" };
        }
        return undefined;
      },
    });
    // Every enrollment the iPhone tries runs out before it is redeemed.
    fake.device.onEnroll(() => fake.device.raise("enrollment-expired"));

    const outcome = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });

    expect(outcome).toEqual({ failure: { kind: "too-long" }, kind: "failed" });
    const mints = host.sent.filter(({ type }) => type === "runner.enrollment.createPhone");
    expect(mints).toHaveLength(3);
    expect(new Set(mints.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(3);
    expect(host.commands.filter((type) => type === "runner.enrollment.retire")).toHaveLength(3);
    expect(fake.device.calls).toEqual([
      "prepare",
      "enroll",
      "discardPendingEnrollment",
      "enroll",
      "discardPendingEnrollment",
      "enroll",
      "discardPendingEnrollment",
    ]);
  });

  it("J5: keeps a refused enrollment's identity when the Host says it is still usable", async () => {
    const { controller, fake } = open();
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type === "runner.enrollment.createPhone") return mint(command);
        throw new HostClientRequestError({
          code: "conflict",
          message: "That enrollment is still waiting for its computer.",
          status: 409,
        });
      },
    });
    fake.device.onEnroll(() => fake.device.raise("enrollment-refused"));

    const outcome = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });

    expect(outcome).toEqual({
      failure: { kind: "host-said", message: "That enrollment is still waiting for its computer." },
      kind: "failed",
    });
    expect(fake.device.calls).not.toContain("discardPendingEnrollment");
  });

  it("J5: refuses a pairing target for another Deployment before enrolling", async () => {
    const { controller, fake } = open();
    const host = fakeHost({
      dispatch: (command) =>
        command.type === "runner.enrollment.createPhone"
          ? { ...mint(command), pairing: { ...pairing, deploymentId: otherDeploymentId } }
          : undefined,
    });

    const outcome = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });

    expect(outcome).toEqual({ failure: { kind: "host-mismatch" }, kind: "failed" });
    expect(fake.device.calls).toEqual(["prepare"]);
  });

  it("names a Personal Deployment with remote access off instead of retrying", async () => {
    const { controller } = open();
    const host = fakeHost({
      dispatch: () => {
        throw new HostClientRequestError({
          code: "conflict",
          message: "Turn on remote access first.",
          reason: "personal-remote-access-off",
          status: 409,
        });
      },
    });

    const outcome = await controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });

    expect(outcome).toEqual({ failure: { kind: "remote-access-off" }, kind: "failed" });
    expect(host.commands).toEqual(["runner.enrollment.createPhone"]);
  });

  it("drops a late add outcome once the iPhone was stopped", async () => {
    const { controller, fake } = open();
    const gate = deferred<void>();
    const host = fakeHost({
      dispatch: async (command) => {
        if (command.type !== "runner.enrollment.createPhone") return undefined;
        await gate.promise;
        return mint(command);
      },
    });

    const adding = controller.add({
      deploymentId,
      hostClient: host.client,
      iphoneAppsAvailable: true,
      name: "Alex's iPhone",
    });
    await vi.waitFor(() => expect(host.commands).toEqual(["runner.enrollment.createPhone"]));
    expect(controller.owner.enrolledDeploymentId()).toBe(deploymentId);
    controller.owner.stop();
    gate.resolve();

    expect(await adding).toEqual({ kind: "superseded" });
    expect(fake.device.calls).not.toContain("enroll");
    expect(controller.getState().adding).toBeNull();
  });
});

describe("approvals on this iPhone", () => {
  it("J6: never signs an approval the iPhone does not currently list", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.listApprovals([approval("req-listed", "apple-calendar", "read")]);

    const unlisted = await controller.answer({ decision: "allow", setupRequestId: "req-gone" });

    expect(unlisted.kind).toBe("unavailable");
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
  });

  it("J6: never signs when the listed request differs from what was tapped", async () => {
    const { controller, fake } = open({ autoConnect: true });
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        // The Host's request for this scope already exists at wider access.
        fake.device.listApprovals([approval("req-1", "apple-calendar", "read-write")]);
        return { request: { id: "req-1" }, type: "integration.computer.setup.request" };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    fake.device.setPermission("apple-calendar", "granted");

    expect(
      await controller.allow({ access: "read", app: "apple-calendar", hostClient: host.client }),
    ).toMatchObject({ kind: "not-allowed" });
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
  });

  it("J8: asks iOS only after the tap, and signs only after iOS answered", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-1", "apple-calendar", "read")]);
        return { request: { id: "req-1" }, type: "integration.computer.setup.request" };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    fake.device.connect();
    // Nothing on screen asked: no prompt from attaching, connecting or listing.
    fake.device.listApprovals([approval("req-0", "apple-reminders", "read")]);
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^requestPermission/u));

    const answer = deferred<"denied">();
    fake.device.answerPermissionWith("apple-calendar", answer.promise);
    const allowing = controller.allow({
      access: "read",
      app: "apple-calendar",
      hostClient: host.client,
    });
    await vi.waitFor(() => expect(fake.device.calls).toContain("requestPermission:apple-calendar"));
    // Going online registered the approval key; nothing about this app was sent.
    expect(host.commands).not.toContain("integration.computer.setup.request");
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));

    // iOS said no: nothing is requested or signed, and the outcome says iOS stopped it.
    answer.resolve("denied");
    expect(await allowing).toEqual({ kind: "blocked", permission: "denied" });
    expect(host.commands).not.toContain("integration.computer.setup.request");
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
    expect(controller.getState().changes).toEqual({});
  });

  it("J8: a task's ask prompts iOS only when Allow is tapped", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.listApprovals([approval("req-1", "apple-contacts", "read")]);
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^requestPermission/u));

    const declined = await controller.answer({ decision: "deny", setupRequestId: "req-1" });
    expect(declined).toEqual({ kind: "declined" });
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^requestPermission/u));

    fake.device.listApprovals([approval("req-2", "apple-contacts", "read")]);
    await controller.answer({ decision: "allow", setupRequestId: "req-2" });
    expect(fake.device.calls.slice(-2)).toEqual([
      "requestPermission:apple-contacts",
      "answerApproval:req-2:allow:apple-contacts:read",
    ]);
  });

  it("C4: a task's ask is not signed after iOS denies it, and keeps waiting", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.listApprovals([approval("req-1", "apple-reminders", "read")]);
    fake.device.answerPermissionWith("apple-reminders", "denied");

    const outcome = await controller.answer({ decision: "allow", setupRequestId: "req-1" });

    expect(outcome).toEqual({ kind: "blocked", permission: "denied" });
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
    // Not declined: it can still be allowed after Settings changes, or declined.
    expect(
      controller.getState().snapshot.approvals.map(({ setupRequestId }) => setupRequestId),
    ).toEqual(["req-1"]);
  });

  it("auto-shows each request once, oldest first, even after a restart", async () => {
    const shown = memoryShownFile();
    const first = open({ shown });
    first.fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    await first.controller.load();
    first.fake.device.listApprovals([
      approval("req-new", "apple-calendar", "read", "2026-10-26T12:05:00.000Z"),
      approval("req-old", "apple-reminders", "read", "2026-10-26T12:00:00.000Z"),
    ]);

    expect(first.controller.getState().prompt?.setupRequestId).toBe("req-old");
    first.controller.markShown("req-old");
    expect(first.controller.getState().prompt?.setupRequestId).toBe("req-new");
    first.controller.markShown("req-new");
    expect(first.controller.getState().prompt).toBeNull();
    await vi.waitFor(() => expect(shown.ids()).toEqual(["req-new", "req-old"]));
    expect(shown.entries().map(({ expiresAt }) => expiresAt)).toEqual([
      approvalExpiresAt,
      approvalExpiresAt,
    ]);

    const relaunched = open({ shown });
    relaunched.fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    relaunched.fake.device.listApprovals([
      approval("req-old", "apple-reminders", "read", "2026-10-26T12:00:00.000Z"),
    ]);
    await relaunched.controller.load();
    expect(relaunched.controller.getState().prompt).toBeNull();
    // It stays answerable on the Computer page.
    expect(relaunched.controller.getState().snapshot.approvals).toHaveLength(1);
  });
});

describe("turning an app on from this iPhone", () => {
  it("C2: never prompts, requests or signs while iOS already refuses the app", async () => {
    for (const permission of ["denied", "restricted"] as const) {
      const { controller, fake } = open();
      fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
      fake.device.setPermission("apple-calendar", permission);
      const host = fakeHost();
      controller.attachHost({ deploymentId, hostClient: host.client });

      const outcome = await controller.allow({
        access: "read",
        app: "apple-calendar",
        hostClient: host.client,
      });

      expect(outcome).toEqual({ kind: "blocked", permission });
      expect(host.commands).not.toContain("integration.computer.setup.request");
      expect(fake.device.calls).toEqual([]);
    }
  });

  it("C1: Calendar's add-only access is not enough to read, so it stops there", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-calendar", "write-only");
    fake.device.answerPermissionWith("apple-calendar", "write-only");
    const host = fakeHost();
    controller.attachHost({ deploymentId, hostClient: host.client });

    const outcome = await controller.allow({
      access: "read-write",
      app: "apple-calendar",
      hostClient: host.client,
    });

    expect(outcome).toEqual({ kind: "blocked", permission: "write-only" });
    expect(fake.device.calls).toEqual(["requestPermission:apple-calendar"]);
    expect(host.commands).not.toContain("integration.computer.setup.request");
  });

  it("C3: limited Contacts is enough, and goes on to approve", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-contacts", "limited");
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-1", "apple-contacts", "read")]);
        return { request: { id: "req-1" }, type: "integration.computer.setup.request" };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });

    const outcome = await controller.allow({
      access: "read",
      app: "apple-contacts",
      hostClient: host.client,
    });

    expect(outcome).toEqual({ kind: "allowed" });
    expect(fake.device.calls).toEqual(["answerApproval:req-1:allow:apple-contacts:read"]);
  });

  it("C5: a lost request answer is read back, and the same request is approved once", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-reminders", "granted");
    const runnerId = fake.device.runnerId();
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        // The Host committed it, and its answer was lost on the way back.
        fake.device.listApprovals([approval("req-landed", "apple-reminders", "read")]);
        throw new Error("The connection was lost.");
      },
      record: () => ({
        connections: [],
        requests: [hostRequest("req-landed", runnerId, "apple-reminders", "read")],
      }),
    });
    controller.attachHost({ deploymentId, hostClient: host.client });

    const outcome = await controller.allow({
      access: "read",
      app: "apple-reminders",
      hostClient: host.client,
    });

    expect(outcome).toEqual({ kind: "allowed" });
    expect(
      host.commands.filter((type) => type === "integration.computer.setup.request"),
    ).toHaveLength(1);
    expect(host.reads).toEqual(
      expect.arrayContaining(["integration.computer.setup.list", "integrations.get"]),
    );
    expect(fake.device.calls).toEqual(["answerApproval:req-landed:allow:apple-reminders:read"]);
  });

  it("C12: a lost reply stays busy until read-back and approval both settle", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-reminders", "granted");
    const runnerId = fake.device.runnerId();
    const record = deferred<HostRecord>();
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-read-back", "apple-reminders", "read")]);
        throw new Error("The reply was lost.");
      },
      record: () => record.promise,
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    const input = { access: "read", app: "apple-reminders", hostClient: host.client } as const;
    const allowing = controller.allow(input);
    await settle();
    expect(controller.getState().changes["apple-reminders"]?.phase).toBe("checking");
    expect(await controller.allow(input)).toEqual({ kind: "busy" });

    record.resolve({
      connections: [],
      requests: [hostRequest("req-read-back", runnerId, "apple-reminders", "read")],
    });
    expect(await allowing).toEqual({ kind: "allowed" });
    expect(controller.getState().changes).toEqual({});
    expect(
      host.commands.filter((type) => type === "integration.computer.setup.request"),
    ).toHaveLength(1);
    expect(fake.device.calls).toEqual(["answerApproval:req-read-back:allow:apple-reminders:read"]);
  });

  it("C13: reattaching reads a superseded change without sending or signing again", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-calendar", "granted");
    const sent = deferred<unknown>();
    const host = fakeHost({
      dispatch: (command) =>
        command.type === "integration.computer.setup.request" ? sent.promise : undefined,
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    const allowing = controller.allow({
      access: "read",
      app: "apple-calendar",
      hostClient: host.client,
    });
    await settle();
    expect(controller.getState().changes["apple-calendar"]?.phase).toBe("sending");

    controller.attachHost({ deploymentId: otherDeploymentId, hostClient: fakeHost().client });
    expect(controller.getState().changes["apple-calendar"]?.phase).toBe("unknown");
    controller.attachHost({ deploymentId, hostClient: host.client });
    await settle();
    expect(controller.getState().changes).toEqual({});
    sent.resolve({ request: { id: "req-late" }, type: "integration.computer.setup.request" });
    expect(await allowing).toEqual({ kind: "superseded" });
    expect(controller.getState().changes).toEqual({});
    expect(host.reads).toEqual(
      expect.arrayContaining(["integration.computer.setup.list", "integrations.get"]),
    );
    expect(
      host.commands.filter((type) => type === "integration.computer.setup.request"),
    ).toHaveLength(1);
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
  });

  it("C6: when nothing can be read back it stays unknown, and checking never asks again", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-reminders", "granted");
    let reachable = false;
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type === "integration.computer.setup.request") {
          throw new Error("The connection was lost.");
        }
        return undefined;
      },
      record: () => {
        if (!reachable) throw new Error("Still unreachable.");
        return { connections: [], requests: [] };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });

    const outcome = await controller.allow({
      access: "read",
      app: "apple-reminders",
      hostClient: host.client,
    });

    expect(outcome).toEqual({ kind: "unknown" });
    expect(controller.getState().changes["apple-reminders"]).toMatchObject({
      access: "read",
      phase: "unknown",
    });

    reachable = true;
    const checked = await controller.check({ app: "apple-reminders", hostClient: host.client });
    // Absence proves only that it is no longer waiting, not that it never landed.
    expect(checked).toEqual({
      kind: "not-allowed",
      message: "That request is no longer waiting. Review the current access before trying again.",
    });
    expect(controller.getState().changes).toEqual({});
    expect(
      host.commands.filter((type) => type === "integration.computer.setup.request"),
    ).toHaveLength(1);
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
  });

  it("C11: reconnecting reads an unknown change back once, and never signs or asks again", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-reminders", "granted");
    const runnerId = fake.device.runnerId();
    let reachable = false;
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type === "integration.computer.setup.request") {
          throw new Error("The connection was lost.");
        }
        return undefined;
      },
      record: () => {
        if (!reachable) throw new Error("Still unreachable.");
        return {
          connections: [],
          requests: [hostRequest("req-1", runnerId, "apple-reminders", "read")],
        };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    expect(
      await controller.allow({ access: "read", app: "apple-reminders", hostClient: host.client }),
    ).toEqual({ kind: "unknown" });
    const readsBefore = host.reads.length;

    reachable = true;
    fake.device.raise("host-unreachable");
    fake.device.reconnect();
    // The request is waiting at the Host: it is left for the person to approve here.
    await vi.waitFor(() => expect(controller.getState().changes).toEqual({}));
    expect(host.reads.length).toBeGreaterThan(readsBefore);
    fake.device.reconnect();
    await settle();
    expect(
      host.commands.filter((type) => type === "integration.computer.setup.request"),
    ).toHaveLength(1);
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
  });

  it("C7: a signed answer whose reply was lost is allowed when the Host holds the access", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-calendar", "granted");
    const runnerId = fake.device.runnerId();
    let committed = false;
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-1", "apple-calendar", "read-write")]);
        return { request: { id: "req-1" }, type: "integration.computer.setup.request" };
      },
      record: () => ({
        connections: committed ? [hostConnection(runnerId, "apple-calendar", "read-write")] : [],
        requests: committed ? [] : [hostRequest("req-1", runnerId, "apple-calendar", "read-write")],
      }),
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    vi.spyOn(fake.bridge, "answerApproval").mockImplementation(async () => {
      committed = true;
      return { kind: "unavailable", message: "Opensteer did not answer in time." };
    });

    const outcome = await controller.allow({
      access: "read-write",
      app: "apple-calendar",
      hostClient: host.client,
    });

    expect(outcome).toEqual({ kind: "allowed" });
    expect(fake.bridge.answerApproval).toHaveBeenCalledOnce();
  });

  it("C8: an answer that never landed leaves the current access and says it was not allowed", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-calendar", "granted");
    const runnerId = fake.device.runnerId();
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-1", "apple-calendar", "read-write")]);
        return { request: { id: "req-1" }, type: "integration.computer.setup.request" };
      },
      // The request expired at the Host; the read grant from before is untouched.
      record: () => ({
        connections: [hostConnection(runnerId, "apple-calendar", "read")],
        requests: [],
      }),
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    vi.spyOn(fake.bridge, "answerApproval").mockResolvedValue({
      kind: "unavailable",
      message: "This iPhone is no longer connected.",
    });

    const outcome = await controller.allow({
      access: "read-write",
      app: "apple-calendar",
      hostClient: host.client,
    });

    expect(outcome).toMatchObject({ kind: "not-allowed" });
    expect(fake.bridge.answerApproval).toHaveBeenCalledOnce();
    expect(controller.getState().changes).toEqual({});
  });

  it("C10: an upgrade in flight is a change beside the current access, never instead of it", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("apple-calendar", "granted");
    const sent = deferred<unknown>();
    const host = fakeHost({
      dispatch: (command) =>
        command.type === "integration.computer.setup.request" ? sent.promise : undefined,
    });
    controller.attachHost({ deploymentId, hostClient: host.client });

    const allowing = controller.allow({
      access: "read-write",
      app: "apple-calendar",
      hostClient: host.client,
    });
    await vi.waitFor(() =>
      expect(controller.getState().changes["apple-calendar"]).toMatchObject({
        access: "read-write",
        phase: "sending",
      }),
    );

    // C9: stopping the iPhone mid-change clears it, and the late answer changes nothing.
    controller.owner.stop();
    expect(controller.getState().changes).toEqual({});
    sent.resolve({ request: { id: "req-late" }, type: "integration.computer.setup.request" });
    expect(await allowing).toEqual({ kind: "superseded" });
    expect(controller.getState().changes).toEqual({});
    expect(fake.device.calls).not.toContainEqual(expect.stringMatching(/^answerApproval/u));
  });
});

describe("apps the Host or this iPhone build may not offer", () => {
  it("a pending request after a Host rollback does not prompt for an absent app", async () => {
    for (const app of ["iphone-location", "iphone-photos"] as const) {
      const { controller, fake } = open();
      fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
      const host = fakeHost({ catalog: baseIphoneApps });
      controller.attachHost({ deploymentId, hostClient: host.client });
      fake.device.listApprovals([approval("req-rollback", app, "read")]);

      expect(
        await controller.answer({ decision: "allow", setupRequestId: "req-rollback" }),
      ).toEqual({ by: "host", kind: "not-offered" });
      expect(fake.device.calls).toEqual([]);
      expect(controller.getState().snapshot.approvals).toHaveLength(1);
      expect(await controller.answer({ decision: "deny", setupRequestId: "req-rollback" })).toEqual(
        { kind: "declined" },
      );
    }
  });

  it("keeps listed task approvals usable across Deployments or an unreadable catalog", async () => {
    for (const elsewhere of [false, true]) {
      const { controller, fake } = open();
      fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
      const host = fakeHost({ catalog: elsewhere ? baseIphoneApps : "unreachable" });
      controller.attachHost({
        deploymentId: elsewhere ? "dep-elsewhere" : deploymentId,
        hostClient: host.client,
      });
      fake.device.listApprovals([approval("req-listed", "iphone-photos", "read")]);
      expect(await controller.answer({ decision: "allow", setupRequestId: "req-listed" })).toEqual({
        kind: "allowed",
      });
      expect(fake.device.calls).toEqual([
        "requestPermission:iphone-photos",
        "answerApproval:req-listed:allow:iphone-photos:read",
      ]);
      expect(host.reads.filter((read) => read === "integration.platform.get")).toHaveLength(
        elsewhere ? 0 : 1,
      );
    }
  });

  it("B5: an older Host's catalog stops Location and Photos before iOS or the Host is asked", async () => {
    for (const app of ["iphone-location", "iphone-photos"] as const) {
      const { controller, fake } = open();
      fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
      const host = fakeHost({ catalog: baseIphoneApps });
      controller.attachHost({ deploymentId, hostClient: host.client });

      const outcome = await controller.allow({ access: "read", app, hostClient: host.client });

      expect(outcome).toEqual({ by: "host", kind: "not-offered" });
      expect(fake.device.calls).toEqual([]);
      // Registering the approval key on attach is the only command.
      expect(host.commands).toEqual(["integration.computer.approval-key.set"]);
      expect(controller.getState().changes).toEqual({});
    }
  });

  it("B5: a catalog that can't be read asks nothing, rather than counting as listed", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const host = fakeHost({ catalog: "unreachable" });
    controller.attachHost({ deploymentId, hostClient: host.client });

    const outcome = await controller.allow({
      access: "read",
      app: "iphone-photos",
      hostClient: host.client,
    });

    expect(outcome).toMatchObject({ kind: "not-allowed" });
    expect(fake.device.calls).toEqual([]);
    // Registering the approval key on attach is the only command.
    expect(host.commands).toEqual(["integration.computer.approval-key.set"]);
  });

  it("an older build is never prompted, asked or signed for an app it doesn't report", async () => {
    const { controller, fake } = open({ offers: baseIphoneApps });
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const host = fakeHost();
    controller.attachHost({ deploymentId, hostClient: host.client });

    expect(
      await controller.allow({ access: "read", app: "iphone-location", hostClient: host.client }),
    ).toEqual({ by: "iphone", kind: "not-offered" });
    expect(await controller.requestPermission("iphone-location")).toBeNull();
    expect(await controller.choosePhotos()).toBeNull();
    // Even a listed request is not answered by a build without the app.
    fake.device.listApprovals([approval("req-old", "iphone-photos", "read")]);
    expect(await controller.answer({ decision: "allow", setupRequestId: "req-old" })).toEqual({
      by: "iphone",
      kind: "not-offered",
    });

    expect(fake.device.calls).toEqual([]);
    // Registering the approval key on attach is the only command.
    expect(host.commands).toEqual(["integration.computer.approval-key.set"]);
  });

  it("limited is not Location permission; an approximate Location is usable", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("iphone-location", "limited");
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-loc", "iphone-location", "read")]);
        return { request: { id: "req-loc" }, type: "integration.computer.setup.request" };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    const input = { access: "read", app: "iphone-location", hostClient: host.client } as const;

    expect(await controller.allow(input)).toEqual({ kind: "blocked", permission: "limited" });
    // Registering the approval key on attach is the only command.
    expect(host.commands).toEqual(["integration.computer.approval-key.set"]);

    fake.device.setPermission("iphone-location", "granted");
    fake.device.setLocationAccuracy("approximate");
    expect(await controller.allow(input)).toEqual({ kind: "allowed" });
    expect(fake.device.calls).toEqual(["answerApproval:req-loc:allow:iphone-location:read"]);
  });

  it("limited Photos is usable; Choose photos runs only then, and closing it is no refusal", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("iphone-photos", "limited");
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-photos", "iphone-photos", "read")]);
        return { request: { id: "req-photos" }, type: "integration.computer.setup.request" };
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });

    expect(
      await controller.allow({ access: "read", app: "iphone-photos", hostClient: host.client }),
    ).toEqual({ kind: "allowed" });
    // The picker closed with nothing new chosen: still limited, never denied.
    expect(await controller.choosePhotos()).toBe("limited");

    fake.device.setPermission("iphone-photos", "granted");
    expect(await controller.choosePhotos()).toBe("granted");
    expect(fake.device.calls).toEqual([
      "answerApproval:req-photos:allow:iphone-photos:read",
      "choosePhotos",
    ]);
  });

  it("a task's Location request after a temporary permission ended asks iOS again, only on Allow", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("iphone-location", "granted");
    // Allow Once ended: iOS reads as never asked again.
    fake.device.setPermission("iphone-location", "not-determined");
    fake.device.listApprovals([
      approval("req-a", "iphone-location", "read"),
      approval("req-b", "iphone-location", "read", "2026-10-26T12:01:00.000Z"),
    ]);
    fake.device.answerPermissionWith("iphone-location", "denied");

    expect(await controller.answer({ decision: "allow", setupRequestId: "req-a" })).toEqual({
      kind: "blocked",
      permission: "denied",
    });
    expect(fake.device.calls).toEqual(["requestPermission:iphone-location"]);
    expect(controller.getState().snapshot.approvals).toHaveLength(2);

    fake.device.setPermission("iphone-location", "not-determined");
    expect(await controller.answer({ decision: "allow", setupRequestId: "req-b" })).toEqual({
      kind: "allowed",
    });
    expect(fake.device.calls.slice(1)).toEqual([
      "requestPermission:iphone-location",
      "answerApproval:req-b:allow:iphone-location:read",
    ]);
  });

  it("a signed Photos answer whose reply was lost is read back once, not signed again", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    fake.device.setPermission("iphone-photos", "granted");
    const runnerId = fake.device.runnerId();
    let committed = false;
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type !== "integration.computer.setup.request") return undefined;
        fake.device.listApprovals([approval("req-1", "iphone-photos", "read")]);
        return { request: { id: "req-1" }, type: "integration.computer.setup.request" };
      },
      record: () => ({
        connections: committed ? [hostConnection(runnerId, "iphone-photos", "read")] : [],
        requests: committed ? [] : [hostRequest("req-1", runnerId, "iphone-photos", "read")],
      }),
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    vi.spyOn(fake.bridge, "answerApproval").mockImplementation(async () => {
      committed = true;
      return { kind: "unavailable", message: "Opensteer did not answer in time." };
    });

    expect(
      await controller.allow({ access: "read", app: "iphone-photos", hostClient: host.client }),
    ).toEqual({ kind: "allowed" });
    expect(fake.bridge.answerApproval).toHaveBeenCalledOnce();
    expect(host.reads).toEqual(
      expect.arrayContaining(["integration.computer.setup.list", "integrations.get"]),
    );
  });
});

describe("the approval key", () => {
  it("J7: registers once per connection, only when online and attached to its Deployment", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone", connection: "connecting" });
    const other = fakeHost();
    const host = fakeHost();

    controller.attachHost({ deploymentId: otherDeploymentId, hostClient: other.client });
    fake.device.connect();
    controller.attachHost({ deploymentId, hostClient: host.client });
    await vi.waitFor(() =>
      expect(host.commands).toContain("integration.computer.approval-key.set"),
    );
    expect(other.commands).toEqual([]);
    expect(
      host.sent.find(({ type }) => type === "integration.computer.approval-key.set"),
    ).toMatchObject({
      input: { publicKey: fake.device.publicKey(), runnerId: fake.device.runnerId() },
    });

    // More snapshots in the same connection register nothing again.
    fake.device.listApprovals([approval("req-1", "apple-calendar", "read")]);
    fake.device.listApprovals([]);
    await settle();
    expect(
      host.commands.filter((type) => type === "integration.computer.approval-key.set"),
    ).toHaveLength(1);

    // A new connection may try once more.
    fake.device.reconnect();
    await vi.waitFor(() =>
      expect(
        host.commands.filter((type) => type === "integration.computer.approval-key.set"),
      ).toHaveLength(2),
    );
    fake.device.registerKey();
    fake.device.reconnect();
    await settle();
    expect(
      host.commands.filter((type) => type === "integration.computer.approval-key.set"),
    ).toHaveLength(2);
  });

  it("says when registration failed, and tries again only when tapped", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone", connection: "connecting" });
    const host = fakeHost({
      dispatch: (command) => {
        if (command.type === "integration.computer.approval-key.set") throw new Error("Refused.");
        return undefined;
      },
    });
    controller.attachHost({ deploymentId, hostClient: host.client });
    fake.device.connect();
    await vi.waitFor(() => expect(controller.getState().approvalKey).toBe("failed"));
    await settle();
    expect(host.commands).toEqual(["integration.computer.approval-key.set"]);

    controller.retryApprovalKey();
    await vi.waitFor(() =>
      expect(
        host.commands.filter((type) => type === "integration.computer.approval-key.set"),
      ).toHaveLength(2),
    );
  });
});

describe("the iPhone's owner", () => {
  it("is not stopped or moved by switching the open Deployment", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    controller.attachHost({ deploymentId: otherDeploymentId, hostClient: fakeHost().client });
    controller.attachHost(null);
    controller.attachHost({ deploymentId, hostClient: fakeHost().client });
    await settle();
    expect(fake.device.calls).not.toContain("disconnect");
    expect(controller.owner.enrolledDeploymentId()).toBe(deploymentId);
  });

  it("moves the iPhone to the Deployment's current address on attach, and only there", async () => {
    const { controller, fake } = open();
    fake.device.enrolledTo({
      deploymentId,
      name: "Alex's iPhone",
      hostUrl: "https://old.example.test",
    });
    const host = fakeHost({ target: pairing });

    controller.attachHost({ deploymentId, hostClient: host.client });

    await vi.waitFor(() => expect(fake.device.calls).toContain("retarget"));
    expect(fake.device.lastRetarget()).toEqual(pairing);
  });

  it.each(["retired", "consumed", "expired"] as const)(
    "retires a pending enrollment (%s) without sending it as a Runner ID",
    async (state) => {
      const { controller, fake } = open();
      const host = fakeHost({
        dispatch: (command) => {
          if (command.type === "runner.enrollment.createPhone") return mint(command);
          if (command.type === "runner.enrollment.retire") return { type: command.type, state };
          if (command.type === "machine.revoke")
            throw new Error("The real Host requires a Runner ID");
          return undefined;
        },
      });
      fake.device.onEnroll(() => fake.device.raise("host-unreachable"));
      await controller.add({
        deploymentId,
        hostClient: host.client,
        iphoneAppsAvailable: true,
        name: "Alex's iPhone",
      });
      const pending = fake.bridge.getSnapshot().enrollment;
      expect(pending?.state).toBe("pending");
      await controller.remove({ hostClient: host.client });
      expect(host.sent.at(-1)).toMatchObject({
        type: "runner.enrollment.retire",
        enrollmentId: pending?.enrollmentId,
      });
      expect(host.commands).not.toContain("machine.revoke");
      expect(controller.getState().notice).toBeNull();
      expect(fake.bridge.getSnapshot().enrollment).toBeNull();
    },
  );

  it("stops synchronously and tells the Host, bounded, without ever undoing the stop", async () => {
    vi.useFakeTimers();
    const { controller, fake } = open();
    fake.device.enrolledTo({ deploymentId, name: "Alex's iPhone" });
    const runnerId = fake.device.runnerId();

    const stopped = controller.owner.stop();
    expect(stopped).toEqual({
      deploymentId,
      deploymentName: "Mac mini",
      enrollmentId: null,
      machineId: runnerId,
      name: "Alex's iPhone",
    });
    expect(fake.device.calls.at(-1)).toBe("disconnect");
    expect(controller.owner.enrolledDeploymentId()).toBeNull();

    const never = vi.fn(() => new Promise<never>(() => undefined));
    const telling = controller.owner.tellHost(stopped!, never as unknown as HostClient["dispatch"]);
    await vi.advanceTimersByTimeAsync(fast.revokeMs + 1);
    await telling;
    expect(never).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: runnerId, type: "machine.revoke" }),
    );
    expect(controller.getState().notice).toEqual({
      deploymentId,
      deploymentName: "Mac mini",
      kind: "not-told",
      name: "Alex's iPhone",
    });
    expect(controller.owner.enrolledDeploymentId()).toBeNull();
  });
});

function open(
  options: {
    readonly autoConnect?: boolean;
    readonly offers?: readonly IphoneAppId[];
    readonly shown?: MemoryShownFile;
  } = {},
) {
  const fake = createFakeIphoneApps({
    autoConnect: options.autoConnect ?? false,
    deviceName: "Alex's iPhone",
    ...(options.offers === undefined ? {} : { offers: options.offers }),
  });
  const controller = new IphoneAppsController({
    bridge: fake.bridge,
    shownApprovals: options.shown ?? memoryShownFile(),
    timing: fast,
  });
  controllers.push(controller);
  return { controller, fake };
}

type Sent = HostApiCommandInput & { readonly [key: string]: unknown };

interface HostRecord {
  readonly connections: readonly unknown[];
  readonly requests: readonly unknown[];
}

const allIphoneApps: readonly IphoneAppId[] = [
  "apple-calendar",
  "apple-contacts",
  "apple-reminders",
  "iphone-location",
  "iphone-photos",
];
const baseIphoneApps = allIphoneApps.slice(0, 3);

function fakeHost(
  options: {
    /** The iPhone definitions the Host's catalog lists, or that it can't be read. */
    readonly catalog?: readonly IphoneAppId[] | "unreachable";
    readonly dispatch?: (command: Sent) => unknown;
    /** The Host's own record, read back after an answer was lost; throws when unreachable. */
    readonly record?: () => HostRecord | Promise<HostRecord>;
    readonly target?: typeof pairing;
  } = {},
) {
  const sent: Sent[] = [];
  const commands: string[] = [];
  const reads: string[] = [];
  const record = options.record ?? (() => ({ connections: [], requests: [] }));
  const client = {
    dispatch: async (command: Sent) => {
      sent.push(command);
      commands.push(command.type);
      const answer = await options.dispatch?.(command);
      return answer ?? { type: command.type };
    },
    rpc: {
      "agentPhone.target.get": async () => {
        reads.push("agentPhone.target.get");
        return { data: options.target ?? pairing, ok: true };
      },
      "integration.platform.get": async () => {
        reads.push("integration.platform.get");
        const catalog = options.catalog ?? allIphoneApps;
        if (catalog === "unreachable") throw new Error("The Host could not be reached.");
        return {
          data: {
            catalog: catalog.map((id) => ({
              definition: { computerApp: { platforms: ["ios"] }, id },
            })),
          },
          ok: true,
        };
      },
      "integration.computer.setup.list": async () => {
        reads.push("integration.computer.setup.list");
        return { data: { requests: (await record()).requests }, ok: true };
      },
      "integrations.get": async () => {
        reads.push("integrations.get");
        return { data: { connections: (await record()).connections }, ok: true };
      },
    },
  } as unknown as HostClient;
  return { client, commands, reads, sent };
}

function mint(command: Sent) {
  return {
    enrollmentId: `ren_${String(command.idempotencyKey).slice(-12)}`,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    pairing,
    token: `enrollment-token-${"t".repeat(40)}`,
    type: "runner.enrollment.createPhone",
  };
}

/** The Host's own pending request, as `integration.computer.setup.list` reads it. */
function hostRequest(
  id: string,
  runnerId: string,
  definitionId: IphoneAppId,
  access: "read" | "read-write",
) {
  return { access, app: null, definitionId, id, kind: "app", runnerId };
}

/** The Host's connection for one of this iPhone's apps, as `integrations.get` reads it. */
function hostConnection(
  runnerId: string,
  definitionId: IphoneAppId,
  access: "read" | "read-write",
) {
  return {
    computer: { access, runnerId },
    definitionId,
    id: `con_${definitionId}`,
    status: "active",
  };
}

function approval(
  setupRequestId: string,
  definitionId: IphoneAppId,
  access: "read" | "read-write",
  createdAt = "2026-10-26T12:00:00.000Z",
) {
  return {
    access,
    createdAt,
    definitionId,
    expiresAt: approvalExpiresAt,
    reason: null,
    setupRequestId,
    threadTitle: null,
    workspaceName: "Main",
  };
}

interface MemoryShownFile extends ShownApprovalsFile {
  entries(): readonly ShownApproval[];
  ids(): readonly string[];
}

function memoryShownFile(): MemoryShownFile {
  let stored: readonly ShownApproval[] = [];
  return {
    entries: () => stored,
    ids: () => stored.map(({ id }) => id),
    read: async () => stored,
    write: async (entries) => {
      stored = [...entries].sort((left, right) => left.id.localeCompare(right.id));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((done) => setTimeout(done, 0));
}

export type { FakeIphoneApps };
