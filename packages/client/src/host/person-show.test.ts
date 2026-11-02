import { PersonShowMessageSchema, BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { handlePersonShow } from "./person-show.js";
import { placeList } from "./places.js";

describe("person show navigation", () => {
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
      for (const target of [
        { threadId: createId("thread") },
        { tabId: BrowserSurfaceIdSchema.parse("closed-tab") },
      ])
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
});
