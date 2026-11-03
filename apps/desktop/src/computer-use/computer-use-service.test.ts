import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunnerIdSchema, createId, type HostInstanceId } from "@opensteer/core";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import { integrationDefinitions } from "@opensteer/integration-catalog";
import { parseComputerAppConfig } from "@opensteer/integration-core/computer-app";
import { computerAppOperationContract } from "@opensteer/integration-core/computer-app-tools";
import {
  ComputerUseSessionIdSchema,
  IntegrationsModuleEventSchema,
  RunnerAuxiliaryRequestIdSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  computerUseDataApps,
  computerUseHelperProtocolVersion,
  computerUseMaxTimeoutMs,
  type ComputerUseDataAppId,
  type ComputerUseDataGrants,
  type ComputerUsePermissions,
  type ComputerUseResolvedApp,
  type IntegrationsModuleEvent,
} from "@opensteer/protocol";

import type { RunnerModuleStream } from "@opensteer/runner-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
// The Runner's own integrations module and bridge client, so a Host frame
// reaches desktop main exactly as it does in the Runner process.
import { ComputerUseHandler } from "../../../runner/src/computer-apps/computer-use-handler.js";
import { createMacosAppProvider } from "../../../runner/src/computer-apps/macos-app-provider.js";
import { createHelperAppProvider } from "../../../runner/src/computer-apps/helper-app-provider.js";
import { ComputerAppModuleHandler } from "../../../runner/src/computer-apps/module-handler.js";

import { ComputerUseService } from "./computer-use-service.js";
import { computerUseFrameReader, encodeComputerUseFrame } from "./helper-frames.js";
import type { ComputerUseHelperProcess } from "./helper-install.js";
import {
  computerUseHelperAppName,
  computerUseHelperAppPath,
  computerUseHelperExecutablePath,
  computerUseHelperRoot,
  computerUseHelperSocketPath,
} from "./helper-paths.js";

const runnerId = "rnr_5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The service installs and starts its helper under the macOS-only lifecycle
// lock (`O_EXLOCK`), which no other platform has; macOS CI runs these suites.
const onMac = process.platform === "darwin";

// Failure: returning from System Settings leaves Messages reading denied after the helper connection idles out.
// Failure: returning from System Settings leaves computer-use permissions stale after the helper connection idles out.
// Failure: a routine probe wakes an idle or quit helper despite having its last reported permissions or data grants.
// Failure: announcing a grant change installs or launches a helper on a Mac where none is installed.
// Failure: announcing after a data-grant request loses its returned grants or prevents the connected Runner from reading them.

describe.skipIf(!onMac)("approvals on the Mac's own Runner stream", () => {
  const waitLong = { interval: 10, timeout: 10_000 };

  it("reports the person's Stop to the Host even when the helper was unreachable as the Runner connected", async () => {
    // The Runner connects while this Mac has no helper it can read, so its
    // readiness says computer use is not set up — without installing one —
    // and its bridge connection is up before any helper is.
    const harness = await stackHarness({ helperInstallFails: true });
    await vi.waitFor(
      () =>
        expect(
          harness.hostStream.filter(({ type }) => type === "runner.integrations.status"),
        ).toEqual([
          expect.objectContaining({
            apps: [
              expect.objectContaining({
                operations: expect.arrayContaining([
                  expect.objectContaining({ state: "permission-required" }),
                ]),
              }),
            ],
          }),
        ]),
      waitLong,
    );
    expect(harness.helper.methods).toEqual([]);
    harness.helper.state.installFails = false;
    const sessionId = ComputerUseSessionIdSchema.parse(`cus_${globalThis.crypto.randomUUID()}`);

    await harness.observe("observe-1", sessionId);
    await vi.waitFor(
      () => expect(resultOf(harness.hostStream, "observe-1")?.result).toMatchObject({ kind: "ok" }),
      waitLong,
    );
    harness.helper.emit({ event: "session.stopped", params: { reason: "user", sessionId } });

    await vi.waitFor(() =>
      expect(
        harness.hostStream.filter(({ type }) => type === "runner.integrations.computer-use-event"),
      ).toEqual([
        expect.objectContaining({
          event: { event: "session.stopped", params: { reason: "user", sessionId } },
        }),
      ]),
    );
  });
});

describe.skipIf(!onMac)("an app the helper serves, from the Host to the Mac and back", () => {
  const waitLong = { interval: 10, timeout: 10_000 };

  it("reads Contacts through the helper, carrying the Host's access and contract to it", async () => {
    const harness = await dataHarness();
    await vi.waitFor(
      () =>
        expect(contactsStatus(harness.hostStream)).toEqual([
          { detail: "Ready to read", operation: "search_contacts", remedy: null, state: "ready" },
        ]),
      waitLong,
    );
    harness.helper.state.dataInvoke = () => ({
      value: {
        contacts: [
          {
            birthday: null,
            emails: [],
            id: "c-ada",
            name: "Ada Lovelace",
            organization: null,
            phones: [],
          },
        ],
        nextCursor: null,
      },
    });

    await harness.invoke("contacts-1", { query: "Ada" });

    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "contacts-1")?.result).toEqual({
          kind: "ok",
          value: {
            contacts: [
              {
                birthday: null,
                emails: [],
                id: "c-ada",
                name: "Ada Lovelace",
                organization: null,
                phones: [],
              },
            ],
            nextCursor: null,
          },
        }),
      waitLong,
    );
    // What reached the process holding the grant is what the Host resolved,
    // not what any hop before it assumed.
    expect(harness.helper.invocations).toEqual([
      {
        access: "read",
        arguments: { query: "Ada" },
        contract: searchContactsContract,
        definitionId: "apple-contacts",
        effect: "read",
        operation: "search_contacts",
      },
    ]);
  });

  it("reports a Mac where Contacts was never set up as a grant to allow, installing nothing", async () => {
    const harness = await dataHarness({ installed: false, running: false });
    await vi.waitFor(
      () =>
        expect(contactsStatus(harness.hostStream)).toEqual([
          {
            detail: "Reading Contacts needs macOS access to Contacts for Opensteer Computer Use.",
            operation: "search_contacts",
            remedy: "contacts",
            state: "permission-required",
          },
        ]),
      waitLong,
    );
    expect(harness.helper.commands).not.toContain("/usr/bin/ditto");
    expect(harness.helper.commands).not.toContain("/usr/bin/open");
    expect(harness.helper.methods).toEqual([]);
  });

  it("answers the helper's permission refusal in the grant's words, and looks again", async () => {
    const harness = await dataHarness();
    await vi.waitFor(() => expect(contactsStatus(harness.hostStream)).not.toBeNull(), waitLong);
    // The person turned Contacts off in System Settings since the last look.
    harness.helper.state.dataGrants = { ...harness.helper.state.dataGrants, contacts: "denied" };
    harness.helper.state.dataInvoke = () => ({
      error: { code: "permission-required", message: "Reading Contacts needs macOS access." },
    });

    await harness.invoke("contacts-denied", {});

    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "contacts-denied")?.result).toEqual({
          code: "permission-required",
          kind: "error",
          message: "Reading Contacts needs macOS access to Contacts for Opensteer Computer Use.",
        }),
      waitLong,
    );
    await vi.waitFor(
      () =>
        expect(contactsStatus(harness.hostStream)?.[0]).toMatchObject({
          remedy: "contacts",
          state: "permission-required",
        }),
      waitLong,
    );
  });

  /*
   * How a change to Calendar or Reminders can go wrong between the Host and
   * the process holding the grant, written before the helper served them:
   * - full access not yet allowed reads as the grant to allow, per operation;
   * - a read-only connection's change never reaches the helper;
   * - a change reaches the helper with the Host's access, contract and effect;
   * - a change whose answer is lost — the helper quits, or never answers by
   *   the deadline — may have happened, so it is never repeated or reported
   *   as not done;
   * - a read whose answer is lost changed nothing, so it is a plain failure.
   */
  it("reads Calendar and Reminders as needing full access until it is allowed", async () => {
    const harness = await dataHarness();
    await vi.waitFor(
      () => expect(appStatus(harness.hostStream, "apple-calendar")).not.toBeNull(),
      waitLong,
    );
    for (const [definitionId, remedy, detail] of [
      [
        "apple-calendar",
        "calendars",
        "Calendar needs macOS full access to calendars for Opensteer Computer Use.",
      ],
      [
        "apple-reminders",
        "reminders",
        "Reminders needs macOS full access to reminders for Opensteer Computer Use.",
      ],
    ] as const) {
      const operations = appStatus(harness.hostStream, definitionId);
      expect(operations?.length).toBe(5);
      for (const operation of operations ?? []) {
        expect(operation).toMatchObject({ detail, remedy, state: "permission-required" });
      }
    }
  });

  it("reads Messages as needing the helper's Full Disk Access, and a send as ready while Automation cannot be read", async () => {
    const harness = await dataHarness();
    await vi.waitFor(
      () => expect(appStatus(harness.hostStream, "apple-messages")).not.toBeNull(),
      waitLong,
    );
    expect(appStatus(harness.hostStream, "apple-messages")).toEqual([
      {
        detail: "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.",
        operation: "list_conversations",
        remedy: "full-disk-access",
        state: "permission-required",
      },
      {
        detail: "Reading Messages needs macOS Full Disk Access for Opensteer Computer Use.",
        operation: "read_messages",
        remedy: "full-disk-access",
        state: "permission-required",
      },
      // Messages is not running, so macOS will not say; the helper checks
      // before it sends, without asking.
      { detail: "Ready", operation: "send_message", remedy: null, state: "ready" },
    ]);
  });

  it("reads Messages again after returning from System Settings with an idle helper connection", async () => {
    const harness = await dataHarness({ idleDisconnectMs: 50 });
    await vi.waitFor(
      () =>
        expect(
          appStatus(harness.hostStream, "apple-messages")?.find(
            ({ operation }) => operation === "read_messages",
          ),
        ).toMatchObject({ remedy: "full-disk-access", state: "permission-required" }),
      waitLong,
    );
    await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });
    const hellos = harness.helper.methods.filter((method) => method === "hello").length;
    harness.helper.state.dataGrants = {
      ...harness.helper.state.dataGrants,
      "full-disk-access": "granted",
      contacts: "requestable",
    };

    harness.computerUse.announceGrantsChanged();

    await vi.waitFor(
      () =>
        expect(
          appStatus(harness.hostStream, "apple-messages")?.find(
            ({ operation }) => operation === "read_messages",
          ),
        ).toMatchObject({ remedy: "contacts", state: "permission-required" }),
      { interval: 10, timeout: 2_000 },
    );
    harness.helper.state.dataGrants = { ...harness.helper.state.dataGrants, contacts: "granted" };
    harness.computerUse.announceGrantsChanged();

    await vi.waitFor(
      () =>
        expect(
          appStatus(harness.hostStream, "apple-messages")?.find(
            ({ operation }) => operation === "read_messages",
          ),
        ).toMatchObject({ remedy: null, state: "ready" }),
      { interval: 10, timeout: 2_000 },
    );
    expect(harness.helper.methods.filter((method) => method === "hello")).toHaveLength(hellos + 1);
    expect(harness.helper.commands).not.toContain("/usr/bin/open");
  });

  it("carries a change to the helper with the Host's read-write access, contract and effect", async () => {
    const harness = await dataHarness();
    harness.helper.state.dataGrants = allGranted;
    const created = { event: { id: "E1@1790000000" } };
    harness.helper.state.dataInvoke = () => ({ value: created });
    const args = { end: "2026-10-01T10:00", start: "2026-10-01T09:00", title: "Review" };

    await harness.invokeApp("calendar-create", {
      access: "read-write",
      arguments: args,
      definitionId: "apple-calendar",
      operation: "create_event",
    });

    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "calendar-create")?.result).toEqual({
          kind: "ok",
          value: created,
        }),
      waitLong,
    );
    expect(harness.helper.invocations).toEqual([
      {
        access: "read-write",
        arguments: args,
        contract: contractOf("apple-calendar", "create_event"),
        definitionId: "apple-calendar",
        effect: "write",
        operation: "create_event",
      },
    ]);
  });

  it("never lets a read-only connection's change reach the helper", async () => {
    const harness = await dataHarness();
    await harness.invokeApp("reminder-read-only", {
      access: "read",
      arguments: { title: "Call Ada" },
      definitionId: "apple-reminders",
      operation: "create_reminder",
    });
    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "reminder-read-only")?.result).toEqual({
          code: "failed",
          kind: "error",
          message: "This app is read only.",
        }),
      waitLong,
    );
    expect(harness.helper.invocations).toEqual([]);
  });

  it("reports a change lost when the helper quit as possibly made, and never repeats it", async () => {
    const harness = await dataHarness();
    harness.helper.state.dataGrants = allGranted;
    harness.helper.state.dataInvoke = () => "quits";

    await harness.invokeApp("reminder-lost", {
      access: "read-write",
      arguments: { title: "Call Ada" },
      definitionId: "apple-reminders",
      operation: "create_reminder",
    });

    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "reminder-lost")?.result).toMatchObject({
          code: "outcome-unknown",
          kind: "error",
        }),
      waitLong,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.helper.invocations).toHaveLength(1);
  });

  it("reports a read lost when the helper quit as a plain failure", async () => {
    const harness = await dataHarness();
    harness.helper.state.dataGrants = allGranted;
    harness.helper.state.dataInvoke = () => "quits";

    await harness.invokeApp("events-lost", {
      access: "read",
      arguments: { end: "2026-10-02", start: "2026-10-01" },
      definitionId: "apple-calendar",
      operation: "list_events",
    });

    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "events-lost")?.result).toMatchObject({
          code: "failed",
          kind: "error",
        }),
      waitLong,
    );
  });

  it("reports a change the helper never answered as possibly made once its deadline passes", async () => {
    const harness = await dataHarness();
    harness.helper.state.dataGrants = allGranted;
    harness.helper.state.dataInvoke = () => "never answers";

    await harness.invokeApp("event-silent", {
      access: "read-write",
      arguments: { id: "E1@1790000000" },
      definitionId: "apple-calendar",
      operation: "delete_event",
      // The helper must receive the call before its deadline even under suite load.
      timeoutMs: 2_000,
    });

    await vi.waitFor(
      () =>
        expect(invokeResultOf(harness.hostStream, "event-silent")?.result).toMatchObject({
          code: "outcome-unknown",
          kind: "error",
        }),
      waitLong,
    );
    expect(harness.helper.invocations).toHaveLength(1);
  });

  it("has its Runner look again once the person answers macOS, rather than on its next round", async () => {
    const harness = await dataHarness();
    await vi.waitFor(
      () =>
        expect(appStatus(harness.hostStream, "apple-calendar")?.[0]).toMatchObject({
          state: "permission-required",
        }),
      waitLong,
    );
    // The person allows full access in the dialog macOS shows.
    harness.helper.state.dataGrants = { ...harness.helper.state.dataGrants, calendars: "granted" };
    const probes = harness.helper.methods.filter((method) => method === "data.status").length;

    await expect(harness.computerUse.requestDataGrant("calendars")).resolves.toMatchObject({
      calendars: "granted",
    });

    // The status cadence here is an hour, so only the announcement can do it.
    await vi.waitFor(
      () =>
        expect(appStatus(harness.hostStream, "apple-calendar")?.map(({ state }) => state)).toEqual([
          "ready",
          "ready",
          "ready",
          "ready",
          "ready",
        ]),
      waitLong,
    );
    expect(
      harness.helper.methods.filter((method) => method === "data.status").length,
    ).toBeGreaterThan(probes);
    expect(harness.helper.commands).not.toContain("/usr/bin/open");
  });

  it("refuses a Runner that asks macOS for a grant: only the person at the Mac does", async () => {
    const harness = await lifetimeHarness({});
    await expect(harness.call("data.request", { grant: "contacts" })).resolves.toMatchObject({
      error: { code: "unsupported" },
    });
    expect(harness.helper.methods).not.toContain("data.request");
  });
});

describe.skipIf(!onMac)("the helper connection's lifetime", () => {
  it("reports a Mac where computer use was never set up without installing or launching anything", async () => {
    const harness = await lifetimeHarness({ installed: false, running: false });

    await expect(harness.probe()).resolves.toEqual({
      permissions: { accessibility: "denied", screenRecording: "denied" },
    });

    harness.computerUse.announceGrantsChanged();

    await expect(harness.probe()).resolves.toEqual({
      permissions: { accessibility: "denied", screenRecording: "denied" },
    });
    await expect(harness.call("data.status", {})).resolves.toEqual({
      grants: {
        automation: "requestable",
        calendars: "requestable",
        contacts: "requestable",
        "full-disk-access": "denied",
        reminders: "requestable",
      },
    });

    expect(harness.helper.commands).not.toContain("/usr/bin/ditto");
    expect(harness.helper.commands).not.toContain("/usr/bin/open");
    expect(harness.helper.methods).toEqual([]);
  });

  it("lets an idle connection go, then answers from the grants the helper last reported", async () => {
    const harness = await lifetimeHarness({ idleDisconnectMs: 50 });
    await expect(harness.probe()).resolves.toMatchObject({
      permissions: { accessibility: "granted", screenRecording: "granted" },
    });
    // Nothing asked of the helper since the probe: the connection is idle, so
    // it goes, and the helper can reach its own idle quit.
    await harness.observe();
    await harness.close();
    await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });

    await harness.helper.offline();
    harness.helper.state.permissions = { accessibility: "denied", screenRecording: "denied" };
    const hellos = harness.helper.methods.filter((method) => method === "hello").length;
    await expect(harness.probe()).resolves.toEqual({
      computerUseVersion: 2,
      permissions: { accessibility: "granted", screenRecording: "granted" },
    });
    // A readiness probe does not bring an asleep helper back.
    expect(harness.helper.methods.filter((method) => method === "hello")).toHaveLength(hellos);
    expect(harness.helper.commands).not.toContain("/usr/bin/open");
  });

  // Failure: a macOS question the person is still answering times out after the
  // default thirty seconds, so the setup step after it never runs.
  it("gives a macOS question the longest deadline the helper takes", async () => {
    const harness = await lifetimeHarness({});
    await harness.computerUse.requestDataGrant("contacts");
    expect(harness.helper.frames).toContainEqual(
      expect.objectContaining({ method: "data.request", timeoutMs: computerUseMaxTimeoutMs }),
    );
  });

  it("answers routine data-grant probes from the last report after the helper idles and quits", async () => {
    const harness = await lifetimeHarness({ idleDisconnectMs: 50 });
    await expect(harness.call("data.status", {})).resolves.toMatchObject({
      grants: { "full-disk-access": "denied" },
    });
    await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });
    await harness.helper.offline();
    harness.helper.state.dataGrants = allGranted;
    const hellos = harness.helper.methods.filter((method) => method === "hello").length;

    await expect(harness.call("data.status", {})).resolves.toMatchObject({
      grants: { "full-disk-access": "denied" },
    });

    expect(harness.helper.methods.filter((method) => method === "hello")).toHaveLength(hellos);
    expect(harness.helper.commands).not.toContain("/usr/bin/open");
  });

  it.each([false, true])(
    "reads changed computer-use permissions after the connection idles (helper quit: %s)",
    async (quit) => {
      const harness = await lifetimeHarness({ idleDisconnectMs: 50 });
      harness.helper.state.permissions = { accessibility: "denied", screenRecording: "denied" };
      await expect(harness.probe()).resolves.toEqual({
        computerUseVersion: 2,
        permissions: { accessibility: "denied", screenRecording: "denied" },
      });
      await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });
      if (quit) await harness.helper.stop();
      const hellos = harness.helper.methods.filter((method) => method === "hello").length;
      harness.helper.state.permissions = { accessibility: "granted", screenRecording: "granted" };

      harness.computerUse.announceGrantsChanged();

      await expect(harness.probe()).resolves.toEqual({
        computerUseVersion: 2,
        permissions: { accessibility: "granted", screenRecording: "granted" },
      });
      expect(harness.helper.methods.filter((method) => method === "hello")).toHaveLength(
        hellos + 1,
      );
      expect(harness.helper.commands.filter((command) => command === "/usr/bin/open")).toHaveLength(
        quit ? 1 : 0,
      );
    },
  );

  // Failure: idle-disconnect removes a negotiated capability or makes a later owner open refuse without reconnecting.
  it("keeps negotiated owner support while idle and wakes the helper on owner open", async () => {
    const harness = await lifetimeHarness({ idleDisconnectMs: 30, ownerViewVersion: 3 });
    await expect(harness.probe()).resolves.toMatchObject({ ownerViewVersion: 3 });
    await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });
    const hellos = harness.helper.methods.filter((method) => method === "hello").length;
    await expect(harness.probe()).resolves.toMatchObject({ ownerViewVersion: 3 });
    expect(harness.helper.methods.filter((method) => method === "hello")).toHaveLength(hellos);
    const authority = {
      viewId: `cvw_${globalThis.crypto.randomUUID()}`,
      generation: 1,
      leaseDurationMs: 600_000,
    };
    await expect(
      harness.call("view.open", { ...authority, target: { kind: "app", app: notesIdentity } }),
    ).resolves.toMatchObject({ state: "ready" });
    expect(harness.helper.methods.filter((method) => method === "hello")).toHaveLength(hellos + 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
    expect(harness.helper.connections()).toBe(1);
    await harness.call("view.close", authority);
    await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });
  });

  it("holds the connection while any session is open, however long it is idle", async () => {
    const harness = await lifetimeHarness({ idleDisconnectMs: 30 });
    await harness.observe();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(harness.helper.connections()).toBe(1);

    await harness.close();
    await vi.waitFor(() => expect(harness.helper.connections()).toBe(0), { timeout: 2_000 });
  });
});

describe.skipIf(!onMac)("one deadline from the bridge frame to the helper frame", () => {
  it("forwards only what is left after a slow installation", async () => {
    const harness = await lifetimeHarness({ running: false });
    const install = gate();
    harness.helper.state.installGate = install.waiting;

    const opened = harness.call(
      "session.open",
      { sessionId: harness.sessionId, threadTitle: null },
      5_000,
    );
    await vi.waitFor(() => expect(harness.helper.commands).toContain("/usr/bin/plutil"));
    // Installing took 1.2 s of the Runner's five.
    harness.clock.at += 1_200;
    install.release();

    await expect(opened).resolves.toEqual({ sessionId: harness.sessionId });
    expect(harness.helper.frames).toEqual([
      expect.objectContaining({ method: "hello", timeoutMs: 3_800 }),
      expect.objectContaining({ method: "session.open", timeoutMs: 3_800 }),
    ]);
  });

  it("writes nothing to the helper when installing outlasts the deadline", async () => {
    const harness = await lifetimeHarness({ running: false });
    const install = gate();
    harness.helper.state.installGate = install.waiting;

    const opened = harness.call(
      "session.open",
      { sessionId: harness.sessionId, threadTitle: null },
      5_000,
    );
    await vi.waitFor(() => expect(harness.helper.commands).toContain("/usr/bin/plutil"));
    harness.clock.at += 6_000;
    install.release();

    // Not done, and said so: the session was never opened on the Mac.
    await expect(opened).resolves.toMatchObject({
      error: { code: "failed", message: "The request ran out of time before it reached the Mac." },
    });
    expect(harness.helper.methods).toEqual([]);
    expect(harness.helper.commands).not.toContain("/usr/bin/open");

    // The session is not held for a Run that never got it: the next open,
    // with time to spare, goes through.
    harness.helper.state.installGate = null;
    await expect(
      harness.call("session.open", { sessionId: harness.sessionId, threadTitle: null }, 5_000),
    ).resolves.toEqual({ sessionId: harness.sessionId });
  });
});

function gate(): { readonly release: () => void; readonly waiting: Promise<void> } {
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  return { release, waiting };
}

/**
 * Desktop main's service with a fake helper, and one Runner's raw bridge
 * socket, for what the helper connection does between requests.
 */
async function lifetimeHarness(options: {
  readonly idleDisconnectMs?: number;
  readonly ownerViewVersion?: number;
  readonly installed?: boolean;
  readonly running?: boolean;
}) {
  // A Unix socket path must stay under about a hundred bytes.
  const home = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oscu-"));
  cleanups.push(async () => rm(home, { force: true, recursive: true }));
  const helper = await fakeHelper(home, {
    ...(options.ownerViewVersion === undefined
      ? {}
      : { ownerViewVersion: options.ownerViewVersion }),
    ...(options.installed === undefined ? {} : { installed: options.installed }),
    ...(options.running === undefined ? {} : { running: options.running }),
  });
  cleanups.push(async () => helper.stop());
  // Desktop main's clock, still unless a test moves it, so every deadline and
  // every `timeoutMs` a helper frame carries is exact.
  const clock = { at: 1_000 };
  const computerUse = new ComputerUseService({
    appBundleId: "com.opensteer.desktop",
    appVersion: "0.0.0",
    bundledHelperPath: () => helper.bundledAppPath,
    homeDirectory: home,
    ...(options.idleDisconnectMs === undefined
      ? {}
      : { idleDisconnectMs: options.idleDisconnectMs }),
    now: () => clock.at,
    platform: "darwin",
    run: helper.run,
    teamId: null,
  });
  cleanups.push(async () => computerUse.stop());
  const bridge = await computerUse.startForSlot("dep_2f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071");
  if (!bridge) throw new Error("The bridge did not start");
  const socket = new WebSocket(bridge.url, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  cleanups.push(async () => {
    socket.close();
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.once("open", resolvePromise);
    socket.once("error", rejectPromise);
  });
  let nextId = 1;
  const call = async (method: string, params: unknown, timeoutMs = 5_000): Promise<unknown> => {
    const id = nextId++;
    return await new Promise<unknown>((resolvePromise) => {
      const onMessage = (data: Buffer): void => {
        const answer = JSON.parse(data.toString("utf8")) as {
          readonly id?: number;
          readonly error?: unknown;
          readonly result?: unknown;
        };
        if (answer.id !== id) return;
        socket.off("message", onMessage);
        resolvePromise(answer.error ? answer : answer.result);
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ id, kind: "request", method, params, timeoutMs }));
    });
  };
  const sessionId = ComputerUseSessionIdSchema.parse(`cus_${globalThis.crypto.randomUUID()}`);
  return {
    call,
    clock,
    computerUse,
    close: async () => await call("session.close", { sessionId }),
    helper,
    sessionId,
    observe: async () => {
      await call("session.open", { sessionId, threadTitle: null });
      return await call("session.observe", {
        app: { access: "read", identity: notesIdentity },
        includeScreenshot: true,
        window: "window-1",
        sessionId,
      });
    },
    probe: async () => await call("permissions.get", {}),
  };
}

function deployment(name: string, canonicalOrigin: string) {
  const now = "2026-08-11T10:00:00.000Z";
  return DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin,
      deploymentId: createId("deployment"),
      deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" as const },
      hostInstanceId: createId("hostInstance") as HostInstanceId,
      hostKey: { algorithm: "Ed25519" },
    }),
    bootstrapMethods: ["password"],
    createdAt: now,
    endpoints: [{ kind: "canonical", origin: canonicalOrigin, verifiedAt: now }],
    kind: "self-hosted",
    lastUsedAt: null,
    name,
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

const notesIdentity = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null } as const;
const notesIcon = "iVBORw0KGgo=";
const observation = {
  app: notesIdentity,
  capturedAt: "2026-09-21T12:00:00.000Z",
  elementCount: 1,
  focusChanged: false,
  geometry: { height: 600, width: 900 },
  snapshot: "obs-1",
  screenshot: null,
  tree: '[0] window "Notes" (0,0 900x600)',
  truncated: false,
  window: {
    ref: "window-1",
    id: 42,
    title: "Notes",
    frame: { x: 0, y: 0, width: 900, height: 600 },
    scale: 1,
  },
  windows: [],
  blockedBy: [],
  alone: false,
} as const;

/**
 * `Opensteer Computer Use` as desktop main meets it: an installed bundle whose
 * signature `codesign` reports, an executable that answers the peer check, and
 * the helper's Unix socket speaking the framed IPC protocol. Only the macOS
 * tools are stood in for; the client, its lock, its peer check and its framing
 * are the real ones.
 */
async function fakeHelper(
  home: string,
  options: {
    readonly installed?: boolean;
    readonly running?: boolean;
    readonly ownerViewVersion?: number;
  } = {},
) {
  const bundledAppPath = path.join(home, "bundle", computerUseHelperAppName);
  const installedAppPath = computerUseHelperAppPath(home);
  const apps = options.installed === false ? [bundledAppPath] : [bundledAppPath, installedAppPath];
  for (const app of apps) {
    await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
    await writeFile(path.join(app, "Contents", "Info.plist"), "{}");
  }
  await mkdir(computerUseHelperRoot(home), { recursive: true });
  await chmod(computerUseHelperRoot(home), 0o700);
  // The bundled copy's `--verify-peer` is the one desktop main runs.
  for (const app of apps) {
    const executable = computerUseHelperExecutablePath(app);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
  }
  const socketPath = computerUseHelperSocketPath(home);
  const state = {
    installFails: false,
    /** While set, reading a bundle's version — the start of installing — waits for it. */
    installGate: null as Promise<void> | null,
    launchFails: false,
    permissions: {
      accessibility: "granted",
      screenRecording: "granted",
    } as ComputerUsePermissions,
    resolved: {
      allowed: true,
      identity: notesIdentity,
      path: "/System/Applications/Notes.app",
      reason: null,
      risk: "standard",
      running: false,
    } as ComputerUseResolvedApp,
    /** The data grants this Mac's person has allowed. */
    dataGrants: {
      automation: "unknown",
      calendars: "requestable",
      contacts: "granted",
      "full-disk-access": "denied",
      reminders: "requestable",
    } as ComputerUseDataGrants,
    /**
     * How the helper answers one `data.invoke`: a value, its own refusal, no
     * answer at all, or by quitting mid-call.
     */
    dataInvoke: (
      _params: Record<string, unknown>,
    ):
      | { readonly value: unknown }
      | { readonly error: { readonly code: string; readonly message: string } }
      | "never answers"
      | "quits" => ({
      value: { contacts: [], nextCursor: null },
    }),
  };
  const methods: string[] = [];
  /** Every `data.invoke` the helper read, exactly as it arrived. */
  const invocations: Record<string, unknown>[] = [];
  const frames: { readonly method: string; readonly timeoutMs?: number }[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const answer = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "hello":
        return {
          helperVersion: "1",
          ...(options.ownerViewVersion === undefined
            ? {}
            : { ownerViewVersion: options.ownerViewVersion }),
          minProtocolVersion: 10,
          routes: { windowLocation: true, windowGroups: true },
          permissions: state.permissions,
          protocolVersion: computerUseHelperProtocolVersion,
        };
      case "view.open":
      case "view.renew":
        return {
          viewId: params.viewId,
          generation: params.generation,
          state: "ready",
          captureTargetId: "window-1",
        };
      case "view.close":
        return {
          viewId: params.viewId,
          generation: params.generation,
          state: "closed",
          captureTargetId: null,
        };
      case "permissions.get":
        return { permissions: state.permissions };
      case "app.resolve":
        return { app: state.resolved };
      case "apps.installed":
        return {
          apps: [
            {
              identity: notesIdentity,
              running: false,
              ...(params.icons ? { iconPng: notesIcon } : {}),
            },
          ],
          total: 1,
        };
      case "session.open":
        return { sessionId: params.sessionId };
      case "session.observe":
        return { observation };
      case "session.close":
        return {};
      case "data.status":
      case "data.request":
        return { grants: state.dataGrants };
      default:
        throw new Error(`The fake helper has no ${method}`);
    }
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A client that hangs up before its answer ends the connection, as it
    // would a real helper's; any other socket fault still fails the run.
    socket.on("error", (error) => {
      if (!clientHungUp(error)) throw error;
      socket.destroy();
    });
    const reader = computerUseFrameReader();
    socket.on("data", (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        const { id, method, params } = frame as {
          readonly id: number;
          readonly method: string;
          readonly params: Record<string, unknown>;
        };
        methods.push(method);
        frames.push(frame as { readonly method: string; readonly timeoutMs?: number });
        if (method === "data.invoke") {
          invocations.push(params);
          const outcome = state.dataInvoke(params);
          if (outcome === "never answers") continue;
          if (outcome === "quits") {
            socket.destroy();
            continue;
          }
          writeToClient(
            socket,
            "error" in outcome ? { error: outcome.error, id } : { id, result: outcome },
          );
          continue;
        }
        writeToClient(socket, { id, result: answer(method, params) });
      }
    });
  });
  const listen = async () =>
    new Promise<void>((resolvePromise) => server.listen(socketPath, resolvePromise));
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  };
  const run: ComputerUseHelperProcess = async (file, arguments_) => {
    commands.push(file);
    if (file === "/usr/bin/plutil") {
      await state.installGate;
      if (state.installFails) throw new Error("plutil could not read the bundle");
      return JSON.stringify({ CFBundleVersion: "1" });
    }
    if (file === "/usr/bin/codesign") {
      return arguments_[0] === "-dv"
        ? "Identifier=com.opensteer.computer-use\nSignature=adhoc\nCDHash=abc123\n"
        : "";
    }
    if (file === "/usr/bin/open") {
      if (state.launchFails) throw new Error("LSOpenURLsWithRole() failed");
      await listen();
      return "";
    }
    throw new Error(`unexpected command ${file}`);
  };
  if (options.running !== false) await listen();
  return {
    bundledAppPath,
    /** Every program desktop main ran for the helper, in order. */
    commands,
    /** Connections the helper holds open right now. */
    connections: () => sockets.size,
    /** Every method the helper was asked, in order. */
    methods,
    invocations,
    /** Every frame the helper read, with the time it said it had left. */
    frames,
    run,
    /** Emits one helper event to every connected client. */
    emit: (event: unknown) => {
      for (const socket of sockets) writeToClient(socket, event);
    },
    /** The helper quits and cannot be launched again until `start`. */
    offline: async () => {
      state.launchFails = true;
      await stop();
    },
    start: async () => {
      state.launchFails = false;
      if (!server.listening) await listen();
    },
    state,
    stop,
  };
}

/** A helper writes only to a client still connected to read it. */
function writeToClient(socket: Socket, frame: unknown): void {
  if (socket.writable) socket.write(encodeComputerUseFrame(frame));
}

/** The client closed its end, so the helper's write or read on it failed. */
function clientHungUp(error: Error): boolean {
  const code = nodeErrorCode(error);
  return code === "EPIPE" || code === "ECONNRESET";
}

/** Electron's window, as the panel drives it: destroying one emits `closed`. */

/** An IPC call from the panel's own page, which the bridge's sender check admits. */

/** An IPC call from a page of the app's own origin that is not the panel. */

const runnerFence = {
  auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(
    "rax_00000000-0000-4000-8000-000000000001",
  ),
  bootId: RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-000000000002"),
  connectionGeneration: 1,
  connectionId: RunnerConnectionIdSchema.parse("rcn_00000000-0000-4000-8000-000000000003"),
  connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(
    "rls_00000000-0000-4000-8000-000000000004",
  ),
  module: "integrations" as const,
  runnerId: RunnerIdSchema.parse(runnerId),
};

/**
 * Desktop main as `main.ts` wires it — the service, a real helper client, the
 * approval service with an approval key, the real approval panel — and the
 * Runner process's integrations module on the other end of the slot's bridge,
 * whose Host stream the test plays. There is no Host session anywhere: the
 * Host reaches this Mac only through the Runner. The person is whoever calls
 * the panel's two bridge methods.
 */
const searchContactsContract = contractOf("apple-contacts", "search_contacts");

const allGranted: ComputerUseDataGrants = {
  automation: "granted",
  calendars: "granted",
  contacts: "granted",
  "full-disk-access": "granted",
  reminders: "granted",
};

/** The newest status the Runner reported for Contacts, or null before one. */
function contactsStatus(events: readonly IntegrationsModuleEvent[]) {
  return appStatus(events, "apple-contacts");
}

/** The newest status the Runner reported for one app, or null before one. */
function appStatus(events: readonly IntegrationsModuleEvent[], definitionId: string) {
  const statuses = events.filter(
    (event): event is Extract<IntegrationsModuleEvent, { type: "runner.integrations.status" }> =>
      event.type === "runner.integrations.status",
  );
  const entry = statuses.at(-1)?.apps.find((app) => app.definitionId === definitionId);
  return entry?.operations ?? null;
}

/**
 * Desktop main's service and a fake helper, and one Runner's integrations
 * module serving Contacts through them: every hop an app the helper serves
 * crosses, from the Host's invoke frame to the helper's socket and back.
 */
async function dataHarness(
  options: {
    readonly idleDisconnectMs?: number;
    readonly installed?: boolean;
    readonly running?: boolean;
    readonly ownerViewVersion?: number;
  } = {},
) {
  const home = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oscu-"));
  cleanups.push(async () => rm(home, { force: true, recursive: true }));
  const helper = await fakeHelper(home, options);
  cleanups.push(async () => helper.stop());
  const computerUse = new ComputerUseService({
    appBundleId: "com.opensteer.desktop",
    appVersion: "0.0.0",
    bundledHelperPath: () => helper.bundledAppPath,
    homeDirectory: home,
    ...(options.idleDisconnectMs === undefined
      ? {}
      : { idleDisconnectMs: options.idleDisconnectMs }),
    platform: "darwin",
    run: helper.run,
    teamId: null,
  });
  cleanups.push(async () => computerUse.stop());
  const bridge = await computerUse.startForSlot("dep_2f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071");
  if (!bridge) throw new Error("The bridge did not start");
  const runnerComputerUse = new ComputerUseHandler({ bridge });
  const module = new ComputerAppModuleHandler({
    computerUse: runnerComputerUse,
    logger: { error: () => undefined, info: () => undefined },
    providers: Object.keys(computerUseDataApps).map((definitionId) =>
      createHelperAppProvider(definitionId as ComputerUseDataAppId, runnerComputerUse),
    ),
    statusIntervalMs: 3_600_000,
  });
  cleanups.push(async () => {
    module.detach();
    runnerComputerUse.close();
  });
  const hostStream: IntegrationsModuleEvent[] = [];
  module.attach({
    browserAttachPublicKeys: undefined,
    fence: runnerFence,
    send: async (payload: Buffer | string) => {
      hostStream.push(IntegrationsModuleEventSchema.parse(JSON.parse(payload.toString())));
    },
  } satisfies RunnerModuleStream);
  return {
    computerUse,
    helper,
    hostStream,
    /** The Host's invoke of Contacts' one operation, with read access. */
    invoke: async (requestId: string, args: Readonly<Record<string, unknown>>) =>
      invokeApp(module, requestId, {
        access: "read",
        arguments: args,
        definitionId: "apple-contacts",
        operation: "search_contacts",
      }),
    /** The Host's invoke of any operation of any app the helper serves. */
    invokeApp: async (requestId: string, call: AppCall) => invokeApp(module, requestId, call),
  };
}

interface AppCall {
  readonly access: "read" | "read-write";
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly definitionId: ComputerUseDataAppId;
  readonly operation: string;
  readonly timeoutMs?: number;
}

/** The Host's invoke frame, carrying the contract it computes from the catalog. */
async function invokeApp(module: ComputerAppModuleHandler, requestId: string, call: AppCall) {
  await module.handleFrame(
    Buffer.from(
      JSON.stringify({
        ...runnerFence,
        access: call.access,
        arguments: call.arguments,
        contract: contractOf(call.definitionId, call.operation),
        definitionId: call.definitionId,
        operation: call.operation,
        requestId: RunnerAuxiliaryRequestIdSchema.parse(requestId),
        timeoutMs: call.timeoutMs ?? 30_000,
        type: "host.integrations.invoke",
      }),
    ),
    false,
  );
}

function contractOf(definitionId: string, name: string): string {
  const definition = integrationDefinitions.find(({ id }) => id === definitionId);
  const operation =
    definition && parseComputerAppConfig(definition).operations.find((op) => op.name === name);
  if (!operation) throw new Error(`The catalog must define ${definitionId}.${name}`);
  return computerAppOperationContract(operation);
}

async function stackHarness(options: { readonly helperInstallFails?: boolean } = {}) {
  // The helper's socket lives under this home, and a Unix socket path must
  // stay under about a hundred bytes, which the platform temp root can exceed.
  const home = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "oscu-"));
  cleanups.push(async () => rm(home, { force: true, recursive: true }));
  const helper = await fakeHelper(home);
  cleanups.push(async () => helper.stop());
  helper.state.installFails = options.helperInstallFails ?? false;
  const log = vi.fn((_event: string, _fields?: Readonly<Record<string, string>>) => undefined);
  const computerUse = new ComputerUseService({
    appBundleId: "com.opensteer.desktop",
    appVersion: "0.0.0",
    bundledHelperPath: () => helper.bundledAppPath,
    homeDirectory: home,
    log,
    platform: "darwin",
    run: helper.run,
    teamId: null,
  });
  cleanups.push(async () => computerUse.stop());
  const homeConnection = deployment("Home", "https://home.opensteer.test");

  const homeId = homeConnection.authority.document.deploymentId;

  const bridge = await computerUse.startForSlot(homeId);
  if (!bridge) throw new Error("The bridge did not start");

  // The Runner process: its bridge client, its status provider and its
  // integrations module, attached to a stream whose frames the Host reads.
  const runnerComputerUse = new ComputerUseHandler({ bridge });
  const module = new ComputerAppModuleHandler({
    computerUse: runnerComputerUse,
    logger: { error: () => undefined, info: () => undefined },
    providers: [
      createMacosAppProvider({
        permissions: () => runnerComputerUse.permissions(),
      }),
    ],
    statusIntervalMs: 3_600_000,
  });
  cleanups.push(async () => {
    module.detach();
    runnerComputerUse.close();
  });
  const attach = (): IntegrationsModuleEvent[] => {
    const received: IntegrationsModuleEvent[] = [];
    module.attach({
      browserAttachPublicKeys: undefined,
      fence: runnerFence,
      send: async (payload: Buffer | string) => {
        received.push(IntegrationsModuleEventSchema.parse(JSON.parse(payload.toString())));
      },
    } satisfies RunnerModuleStream);
    return received;
  };
  let hostStream = attach();
  const hostFrame = async (frame: Readonly<Record<string, unknown>>) =>
    module.handleFrame(Buffer.from(JSON.stringify({ ...runnerFence, ...frame })), false);
  const send = async (requestId: string, fields: Readonly<Record<string, unknown>>) =>
    hostFrame({
      access: null,
      app: null,
      params: {},
      requestId: RunnerAuxiliaryRequestIdSchema.parse(requestId),
      runId: createId("run"),
      sessionId: ComputerUseSessionIdSchema.parse(`cus_${globalThis.crypto.randomUUID()}`),
      threadTitle: null,
      timeoutMs: 30_000,
      type: "host.integrations.computer-use",
      ...fields,
    });

  return {
    computerUse,
    /** The Runner's Host connection drops. */
    detach: () => module.detach(),
    helper,
    get hostStream() {
      return hostStream;
    },
    homeId,
    idle: async () => {
      for (let tick = 0; tick < 50; tick += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      }
    },
    log,
    /** An agent's observe of Notes, as the Host sends it. */
    observe: async (requestId: string, sessionId: string) =>
      send(requestId, {
        access: "read",
        app: notesIdentity,
        operation: "observe",
        params: { window: "window-1", includeScreenshot: true },
        sessionId,
        threadTitle: "Plan the offsite",
      }),
    /** The Runner's Host connection comes back without advancing its readiness cache. */
    reattach: () => {
      module.detach();
      hostStream = attach();
    },
  };
}

/** The Runner's answer to one app invoke, as the Host reads it. */
function invokeResultOf(events: readonly IntegrationsModuleEvent[], requestId: string) {
  return events.find(
    (event): event is Extract<IntegrationsModuleEvent, { type: "runner.integrations.result" }> =>
      event.type === "runner.integrations.result" && event.requestId === requestId,
  );
}

function resultOf(events: readonly IntegrationsModuleEvent[], requestId: string) {
  for (const event of events) {
    if (event.type === "runner.integrations.computer-use-result" && event.requestId === requestId) {
      return event;
    }
  }
  return undefined;
}
