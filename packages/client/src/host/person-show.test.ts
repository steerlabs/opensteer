import {
  PersonShowMessageSchema,
  type PersonShowMessage,
  BrowserSurfaceIdSchema,
  computerAppIdentityKey,
} from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { handlePersonShow, personShowFromCall } from "./person-show.js";
import { placeList } from "./places.js";

describe("person show navigation", () => {
  it.each(["app", "phone"] as const)(
    "resolves a current %s by the delivered Run and exact place",
    (kind) => {
      const client = new MockHostClient();
      try {
        const snapshot = client.getSnapshot();
        const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
        const machine = snapshot.machines.find((machine) =>
          machine.computerUse?.sessions.some((session) => session.display === (kind === "phone")),
        )!;
        expect(machine).toBeDefined();
        const session = machine.computerUse!.sessions.find(
          (session) => session.display === (kind === "phone"),
        )!;
        const place =
          kind === "app"
            ? { kind, machineId: machine.id, appKey: computerAppIdentityKey(session.apps[0]!) }
            : { kind, machineId: machine.id, display: "main" };
        const message = PersonShowMessageSchema.parse({
          type: "host.show",
          workspaceId: source.workspaceId,
          threadId: source.id,
          runId: session.runId,
          target: { place, runId: session.runId },
        });
        const navigate = vi.fn();
        expect(
          handlePersonShow(snapshot, message, { foreground: true, threadId: source.id }, navigate),
        ).toBe(true);
        expect(navigate).toHaveBeenCalledExactlyOnceWith({
          kind: "place",
          destination:
            kind === "app"
              ? {
                  ...place,
                  computerSessionId: session.sessionId,
                  source: { kind: "task-session", sessionId: session.sessionId },
                }
              : { kind, machineId: machine.id },
        });
        navigate.mockClear();
        // An app's session is the Run's own; a phone's tab outlives every Run.
        expect(
          handlePersonShow(
            snapshot,
            { ...message, target: { ...message.target, runId: createId("run") } } as PersonShowMessage,
            { foreground: true, threadId: source.id },
            navigate,
          ),
        ).toBe(kind === "phone");
        navigate.mockClear();
        // A voice call shows a task's place: the call's Run asks, the task's Run is in it.
        const call = {
          threadId: createId("thread"),
          runId: createId("run"),
          workspaceId: source.workspaceId,
        };
        expect(
          handlePersonShow(
            snapshot,
            PersonShowMessageSchema.parse({ ...message, ...call }),
            { foreground: true, threadId: null, call },
            navigate,
          ),
        ).toBe(true);
        expect(navigate).toHaveBeenCalledExactlyOnceWith({
          kind: "place",
          destination:
            kind === "app"
              ? {
                  ...place,
                  computerSessionId: session.sessionId,
                  source: { kind: "task-session", sessionId: session.sessionId },
                }
              : { kind, machineId: machine.id },
        });
      } finally {
        client.dispose();
      }
    },
  );
  it("uses current authorized identities and ignores devices not showing the source conversation", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const source = snapshot.homeThreadId!;
      const target = snapshot.threads.find((thread) => thread.id !== source)!;
      expect(target).toBeDefined();
      const navigate = vi.fn();
      const message = PersonShowMessageSchema.parse({
        type: "host.show" as const,
        runId: createId("run"),
        workspaceId: snapshot.threads.find((thread) => thread.id === source)!.workspaceId,
        threadId: source,
        target: { threadId: target.id },
      });
      for (const view of [
        { foreground: false, threadId: source },
        { foreground: true, threadId: target.id },
        { foreground: true, threadId: null },
      ]) {
        expect(handlePersonShow(snapshot, message, view, navigate)).toBe(false);
      }
      expect(navigate).not.toHaveBeenCalled();
      const place = placeList(snapshot).find(
        (place) => place.destination.kind === "browser" && place.availability !== "unavailable",
      )!;
      expect(place).toBeDefined();
      if (place.destination.kind !== "browser") throw new Error("Expected browser place");
      const tabMessage = PersonShowMessageSchema.parse({
        ...message,
        target: { tabId: place.destination.tabId },
      });
      expect(
        handlePersonShow(snapshot, tabMessage, { foreground: true, threadId: source }, navigate),
      ).toBe(true);
      expect(navigate).toHaveBeenLastCalledWith({ kind: "place", destination: place.destination });
      navigate.mockClear();
      expect(
        handlePersonShow(
          snapshot,
          { ...tabMessage, workspaceId: createId("workspace") },
          { foreground: true, threadId: source },
          navigate,
        ),
      ).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
      const unsubscribe = client.subscribePersonShow((message) =>
        handlePersonShow(
          client.getSnapshot(),
          message,
          { foreground: true, threadId: source },
          navigate,
        ),
      );
      client.receivePersonShow(tabMessage);
      expect(navigate).toHaveBeenCalledOnce();
      unsubscribe();
      navigate.mockClear();
      expect(
        handlePersonShow(snapshot, message, { foreground: true, threadId: source }, navigate),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "thread", threadId: target.id });
      navigate.mockClear();
      for (const target of [{ tabId: BrowserSurfaceIdSchema.parse("closed-tab") }])
        expect(
          handlePersonShow(
            snapshot,
            { ...message, target },
            { foreground: true, threadId: source },
            navigate,
          ),
        ).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("acts for the live voice call on any screen, never for a call it replaced", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const home = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
      const target = snapshot.threads.find((thread) => thread.id !== home.id)!;
      // The call's Thread is hidden: no loaded list or snapshot holds it.
      const call = {
        threadId: createId("thread"),
        runId: createId("run"),
        workspaceId: home.workspaceId,
      };
      expect(snapshot.threads.some((thread) => thread.id === call.threadId)).toBe(false);
      const message = PersonShowMessageSchema.parse({
        type: "host.show",
        ...call,
        target: { threadId: target.id },
      });
      const navigate = vi.fn();
      for (const threadId of [null, home.id, target.id])
        expect(
          handlePersonShow(snapshot, message, { foreground: true, threadId, call }, navigate),
        ).toBe(true);
      expect(navigate).toHaveBeenCalledTimes(3);
      expect(navigate).toHaveBeenLastCalledWith({ kind: "thread", threadId: target.id });
      navigate.mockClear();
      const replaced = { ...call, runId: createId("run") };
      for (const view of [
        { foreground: false, threadId: null, call },
        { foreground: true, threadId: null, call: replaced },
        { foreground: true, threadId: null, call: { ...call, threadId: createId("thread") } },
        { foreground: true, threadId: null, call: { ...call, workspaceId: createId("workspace") } },
        { foreground: true, threadId: null, call: null },
      ])
        expect(handlePersonShow(snapshot, message, view, navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
      expect(personShowFromCall(message, call)).toBe(true);
      expect(personShowFromCall(message, replaced)).toBe(false);
    } finally {
      client.dispose();
    }
  });

  it("navigates to a Host-authorized Thread absent from every loaded list", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
      const threadId = createId("thread");
      const navigate = vi.fn();
      expect(
        handlePersonShow(
          snapshot,
          PersonShowMessageSchema.parse({
            type: "host.show",
            runId: createId("run"),
            workspaceId: source.workspaceId,
            threadId: source.id,
            target: { threadId },
          }),
          { foreground: true, threadId: source.id },
          navigate,
        ),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "thread", threadId });
    } finally {
      client.dispose();
    }
  });

  it("uses the exact browser identity resolved by the Host for the current place", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const source = snapshot.threads.find((thread) => thread.id === snapshot.homeThreadId)!;
      const place = placeList(snapshot).find((place) => place.destination.kind === "browser")!;
      if (place.destination.kind !== "browser") throw new Error("Expected browser place");
      const { tabId, sessionId } = place.destination;
      const navigate = vi.fn();
      const message = PersonShowMessageSchema.parse({
        type: "host.show",
        runId: createId("run"),
        workspaceId: source.workspaceId,
        threadId: source.id,
        target: { place: { kind: "browser", sessionId, surfaceId: tabId }, runId: createId("run") },
      });
      expect(
        handlePersonShow(snapshot, message, { foreground: true, threadId: source.id }, navigate),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        kind: "place",
        destination: { kind: "browser", sessionId, tabId },
      });
    } finally {
      client.dispose();
    }
  });
});
