import { createId, type Thread } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import {
  createBrowserSessionId,
  ComputerViewIdSchema,
  computerAppIdentityKey,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { ScreenPresentationService } from "./screen-presentation-service.js";

function fixture() {
  const owner = createId("user");
  const threadId = createId("thread");
  const otherThreadId = createId("thread");
  const machineId = createId("runner");
  const app = { bundleId: "com.example.App", displayName: "App", teamId: null };
  const thread = {
    id: threadId,
    workspaceId: createId("workspace"),
    status: "running",
  } as unknown as Thread;
  const session = {
    sessionId: "cus_00000000-0000-4000-8000-000000000001",
    threadId,
    display: false,
    apps: [app],
  };
  const store = {
    findMainWorkspaceForOwner: vi.fn(),
    getThreadForOwner: vi.fn(async (id) => (id === threadId ? thread : null)),
    getBrowserSessionForOwner: vi.fn(async () => ({ state: "ready" })),
    browserSurfaceBelongsToThread: vi.fn(async () => false),
  } as unknown as OpensteerStore;
  const native = {
    presentableSurfaces: vi.fn(async () => []),
    sessionsForRunner: vi.fn(() => [session]),
    authorizeDisplay: vi.fn(async () => machineId),
  };
  const views = { authorizePresentation: vi.fn(async () => undefined) };
  const places = { assertUsable: vi.fn(async () => undefined) };
  const browser = { readTabCatalog: vi.fn(async () => ({ tabs: [{ id: "tab_one" }] })) };
  const service = new ScreenPresentationService({
    store,
    computerUse: native as never,
    computerViews: views,
    places,
    browser: browser as never,
  });
  return {
    service,
    store,
    native,
    views,
    places,
    owner,
    threadId,
    otherThreadId,
    machineId,
    app,
    browser,
  };
}
describe("presentation target authorization", () => {
  it("requires the exact existing native session, app, and conversation together", async () => {
    const f = fixture();
    const surface = {
      kind: "app" as const,
      machineId: f.machineId,
      appKey: computerAppIdentityKey(f.app),
      source: {
        kind: "task-session" as const,
        sessionId: "cus_00000000-0000-4000-8000-000000000001",
      },
    };
    try {
      await expect(
        f.service.authorizeTarget(f.owner, { conversationId: f.threadId, surface }),
      ).resolves.toBeUndefined();
      expect(f.native.authorizeDisplay).toHaveBeenCalledWith(
        "cus_00000000-0000-4000-8000-000000000001",
        f.owner,
        computerAppIdentityKey(f.app),
      );
      await expect(
        f.service.authorizeTarget(f.owner, {
          surface: {
            ...surface,
            source: { ...surface.source, sessionId: "cus_00000000-0000-4000-8000-000000000002" },
          },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        f.service.authorizeTarget(f.owner, { surface: { ...surface, appKey: "different-app" } }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        f.service.authorizeTarget(f.owner, { conversationId: f.otherThreadId, surface }),
      ).rejects.toMatchObject({ code: "forbidden" });
      f.places.assertUsable.mockRejectedValueOnce(new Error("Approval revoked"));
      await expect(f.service.authorizeTarget(f.owner, { surface })).rejects.toThrow(
        "Approval revoked",
      );
      expect(f.views.authorizePresentation).not.toHaveBeenCalled();
    } finally {
      f.service.close();
    }
  });
  it("authorizes the exact browser tab and requires its conversation usage, not just session usage", async () => {
    const f = fixture();
    const surface = {
      kind: "browser" as const,
      sessionId: createBrowserSessionId(),
      tabId: "tab_one" as import("@opensteer/core").BrowserSurfaceId,
    };
    try {
      await expect(f.service.authorizeTarget(f.owner, { surface })).resolves.toBeUndefined();
      await expect(
        f.service.authorizeTarget(f.owner, { conversationId: f.threadId, surface }),
      ).rejects.toMatchObject({ code: "forbidden" });
      vi.mocked(f.store.browserSurfaceBelongsToThread).mockResolvedValueOnce(true);
      await expect(
        f.service.authorizeTarget(f.owner, { conversationId: f.threadId, surface }),
      ).resolves.toBeUndefined();
      await expect(
        f.service.authorizeTarget(f.owner, {
          surface: { ...surface, tabId: "tab_closed" as typeof surface.tabId },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      f.service.close();
    }
  });
  it("never associates an owner view with a conversation from descriptive input context", async () => {
    const f = fixture();
    const surface = {
      kind: "phone" as const,
      machineId: f.machineId,
      display: "main",
      source: {
        kind: "owner-view" as const,
        viewId: ComputerViewIdSchema.parse("cvw_00000000-0000-4000-8000-000000000001"),
        generation: 1,
      },
    };
    try {
      await expect(
        f.service.authorizeTarget(f.owner, { conversationId: f.threadId, surface }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(f.views.authorizePresentation).not.toHaveBeenCalled();
      await expect(f.service.authorizeTarget(f.owner, { surface })).resolves.toBeUndefined();
      expect(f.views.authorizePresentation).toHaveBeenCalledWith(f.owner, surface);
    } finally {
      f.service.close();
    }
  });
});

it("omits unreadable descriptive context and lets committed work survive an ended endpoint", async () => {
  const f = fixture();
  const session = {
    id: createId("authSession"),
    user: { id: f.owner },
  } as import("@opensteer/core").AuthenticatedSession;
  vi.mocked(f.store.findMainWorkspaceForOwner).mockResolvedValue({
    id: createId("workspace"),
    homeThreadId: f.threadId,
  } as import("@opensteer/core").Workspace);
  const endpoint = f.service.registry.open({
    ownerId: f.owner,
    sessionId: session.id,
    sink: { id: "origin", close: () => undefined, send: async () => undefined },
  });
  const context = {
    endpointRef: endpoint.ready.endpointRef,
    voiceSessionId: "00000000-0000-4000-8000-000000000001",
    utteranceSequence: 1,
    interactionRevision: 1,
    currentThreadId: f.otherThreadId,
  };
  try {
    await expect(
      f.service.prepareInput({ ...session, id: createId("authSession") }, f.threadId, context),
    ).resolves.toBeUndefined();
    const onCommitted = await f.service.prepareInput(session, f.threadId, context);
    if (!onCommitted) throw new Error("The live originating endpoint was not eligible");
    const messageId = createId("message");
    const committed = {
      wasDuplicate: false,
      input: { state: "pending" },
      message: { id: messageId, author: { kind: "human" } },
    } as unknown as import("@opensteer/database").EnqueuedThreadInput;
    onCommitted(committed);
    expect(f.service.contextFor(messageId)).toEqual({});
    const later = await f.service.prepareInput(session, f.threadId, context);
    if (!later) throw new Error("The live originating endpoint was not eligible");
    endpoint.close();
    const laterId = createId("message");
    expect(() =>
      later({ ...committed, message: { ...committed.message, id: laterId } }),
    ).not.toThrow();
    expect(f.service.contextFor(laterId)).toBeUndefined();
    await expect(f.service.prepareInput(session, f.threadId, context)).resolves.toBeUndefined();
  } finally {
    f.service.close();
  }
});
