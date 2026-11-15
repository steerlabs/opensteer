import { PersonShowMessageSchema, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { handlePersonShow, personShowFromCall } from "./person-show.js";

describe("person show navigation", () => {
  it("shows the exact listed tab of any kind and never a closed or unavailable one", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const source = snapshot.threads[0]!.id;
      const message = (target: object) =>
        PersonShowMessageSchema.parse({
          type: "host.show",
          runId: createId("run"),
          deploymentId: snapshot.deploymentId,
          threadId: source,
          target,
        });
      const view = { foreground: true, threadId: source };
      const navigate = vi.fn();
      for (const kind of ["page", "window", "phone", "app"] as const) {
        const tab = [...snapshot.tabs.rows.values()].find(
          (row) => row.kind === kind && row.state !== "unavailable",
        );
        expect(tab, kind).toBeDefined();
        expect(handlePersonShow(snapshot, message({ tabId: tab!.tabId }), view, navigate)).toBe(
          true,
        );
        expect(navigate).toHaveBeenLastCalledWith({
          kind: "place",
          destination: { kind: "tab", tabId: tab!.tabId },
        });
      }
      navigate.mockClear();
      const unavailable = [...snapshot.tabs.rows.values()].find(
        (row) => row.state === "unavailable",
      );
      expect(unavailable).toBeDefined();
      for (const tabId of [unavailable!.tabId, BrowserSurfaceIdSchema.parse("closed-tab")])
        expect(handlePersonShow(snapshot, message({ tabId }), view, navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it("acts only on the device showing the source conversation", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const source = snapshot.threads[0]!.id;
      const target = snapshot.threads.find((thread) => thread.id !== source)!;
      const navigate = vi.fn();
      const message = PersonShowMessageSchema.parse({
        type: "host.show",
        runId: createId("run"),
        deploymentId: snapshot.deploymentId,
        threadId: source,
        target: { taskId: target.id },
      });
      for (const view of [
        { foreground: false, threadId: source },
        { foreground: true, threadId: target.id },
        { foreground: true, threadId: null },
      ])
        expect(handlePersonShow(snapshot, message, view, navigate)).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
      const unsubscribe = client.subscribePersonShow((shown) =>
        handlePersonShow(
          client.getSnapshot(),
          shown,
          { foreground: true, threadId: source },
          navigate,
        ),
      );
      client.receivePersonShow(message);
      unsubscribe();
      expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: "thread", threadId: target.id });
      // A task absent from every loaded list is still the Host's to authorize.
      const hidden = createId("thread");
      expect(
        handlePersonShow(
          snapshot,
          { ...message, target: { taskId: hidden } },
          { foreground: true, threadId: source },
          navigate,
        ),
      ).toBe(true);
      expect(navigate).toHaveBeenLastCalledWith({ kind: "thread", threadId: hidden });
    } finally {
      client.dispose();
    }
  });

  it("acts for the live voice call on any screen, never for a call it replaced", () => {
    const client = new MockHostClient();
    try {
      const snapshot = client.getSnapshot();
      const home = snapshot.threads[0]!;
      const target = snapshot.threads.find((thread) => thread.id !== home.id)!;
      // The call's Thread is hidden: no loaded list or snapshot holds it.
      const call = {
        threadId: createId("thread"),
        runId: createId("run"),
        deploymentId: snapshot.deploymentId,
      };
      expect(snapshot.threads.some((thread) => thread.id === call.threadId)).toBe(false);
      const message = PersonShowMessageSchema.parse({
        type: "host.show",
        ...call,
        target: { taskId: target.id },
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
});
