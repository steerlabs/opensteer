import {
  OpensteerError,
  type AuthenticatedSession,
  type MessageId,
  type ScreenShowTarget,
  type ScreenSurface,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore, EnqueuedThreadInput } from "@opensteer/database";
import {
  ComputerUseSessionIdSchema,
  computerAppIdentityKey,
  type ScreenPresentationInput,
} from "@opensteer/protocol";
import type { BrowserService } from "../browser/browser-service.js";
import type { ComputerUseService } from "../computer-use/computer-use-service.js";
import type { ComputerViewService } from "../computer-use/computer-view-service.js";
import type { PlaceContextService } from "../computer-use/place-context-service.js";
import { ScreenPresentationRegistry } from "./screen-presentation-registry.js";

const forbidden = () =>
  new OpensteerError({ code: "forbidden", message: "Presentation is unavailable to this input." });
export class ScreenPresentationService {
  readonly registry: ScreenPresentationRegistry;
  readonly #store: OpensteerStore;
  readonly #browser: Pick<BrowserService, "readTabCatalog">;
  readonly #computerUse: Pick<
    ComputerUseService,
    "presentableSurfaces" | "sessionsForRunner" | "authorizeDisplay"
  >;
  readonly #computerViews: Pick<ComputerViewService, "authorizePresentation">;
  readonly #places: Pick<PlaceContextService, "assertUsable">;
  constructor(options: {
    readonly registry?: ScreenPresentationRegistry;
    readonly store: OpensteerStore;
    readonly browser: Pick<BrowserService, "readTabCatalog">;
    readonly computerUse: Pick<
      ComputerUseService,
      "presentableSurfaces" | "sessionsForRunner" | "authorizeDisplay"
    >;
    readonly computerViews: Pick<ComputerViewService, "authorizePresentation">;
    readonly places: Pick<PlaceContextService, "assertUsable">;
  }) {
    this.registry = options.registry ?? new ScreenPresentationRegistry();
    this.#store = options.store;
    this.#browser = options.browser;
    this.#computerUse = options.computerUse;
    this.#computerViews = options.computerViews;
    this.#places = options.places;
  }
  async subscriptionAllowed(
    owner: UserId,
    workspaceId: import("@opensteer/core").WorkspaceId,
  ): Promise<boolean> {
    return (await this.#store.findMainWorkspaceForOwner(owner))?.id === workspaceId;
  }
  async prepareInput(
    session: AuthenticatedSession,
    threadId: ThreadId,
    context: ScreenPresentationInput,
  ): Promise<(result: EnqueuedThreadInput) => void> {
    if (!this.registry.hasEndpoint(context.endpointRef, session.user.id, session.id))
      throw forbidden();
    const main = await this.#store.findMainWorkspaceForOwner(session.user.id);
    if (!main || main.homeThreadId !== threadId) throw forbidden();
    // Descriptive context reveals nothing about a conversation the sender cannot read.
    const current = context.currentThreadId
      ? await this.#store.getThreadForOwner(context.currentThreadId, session.user.id)
      : null;
    const normalized: ScreenPresentationInput = {
      endpointRef: context.endpointRef,
      voiceSessionId: context.voiceSessionId,
      utteranceSequence: context.utteranceSequence,
      interactionRevision: context.interactionRevision,
      ...(current ? { currentThreadId: current.id } : {}),
    };
    return (result) => {
      if (
        !result.wasDuplicate &&
        result.message.author.kind === "human" &&
        !result.message.quote &&
        result.input.state !== "cancelled"
      )
        this.registry.register({
          ownerId: session.user.id,
          sessionId: session.id,
          threadId,
          messageId: result.message.id,
          context: normalized,
        });
    };
  }
  async authorizeTarget(owner: UserId, target: ScreenShowTarget): Promise<void> {
    const conversation = target.conversationId
      ? await this.#store.getThreadForOwner(target.conversationId, owner)
      : null;
    if (target.conversationId && (!conversation || conversation.status === "archived"))
      throw forbidden();
    const surface = target.surface;
    if (!surface) return;
    if (surface.kind === "browser") {
      const record = await this.#store.getBrowserSessionForOwner(surface.sessionId, owner);
      if (!record || record.state !== "ready") throw forbidden();
      if (
        !(await this.#browser.readTabCatalog(owner, surface.sessionId)).tabs.some(
          (tab) => tab.id === surface.tabId,
        )
      )
        throw forbidden();
      if (conversation) {
        if (
          !(await this.#store.browserSurfaceBelongsToThread({
            sessionId: surface.sessionId,
            tabId: surface.tabId,
            threadId: conversation.id,
          }))
        )
          throw forbidden();
      }
      return;
    }
    if (surface.source.kind === "owner-view") {
      // Owner leases carry no conversation authority and are never inferred from a task.
      if (conversation) throw forbidden();
      await this.#computerViews.authorizePresentation(owner, surface);
      return;
    }
    const sessionId = ComputerUseSessionIdSchema.parse(surface.source.sessionId);
    const session = this.#computerUse
      .sessionsForRunner(surface.machineId)
      .find((entry) => entry.sessionId === sessionId);
    if (!session || (conversation && session.threadId !== conversation.id)) throw forbidden();
    const thread = conversation ?? (await this.#store.getThreadForOwner(session.threadId, owner));
    if (!thread || thread.status === "archived") throw forbidden();
    const app =
      surface.kind === "app"
        ? session.apps.find((entry) => computerAppIdentityKey(entry) === surface.appKey)
        : null;
    if (
      (surface.kind === "app" && !app) ||
      (surface.kind === "phone" && (!session.display || surface.display !== "main"))
    )
      throw forbidden();
    await this.#computerUse.authorizeDisplay(
      sessionId,
      owner,
      surface.kind === "app" ? surface.appKey : undefined,
    );
    await this.#places.assertUsable({
      ownerId: owner,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      parts:
        surface.kind === "app" && app
          ? [{ type: "computer-app", machineId: surface.machineId, app, name: "App" }]
          : [
              {
                type: "phone",
                machineId: surface.machineId,
                display: surface.kind === "phone" ? surface.display : "main",
                name: "Phone",
              },
            ],
    });
  }
  async presentableSurfaces(owner: UserId, threadId: ThreadId): Promise<ScreenSurface[]> {
    const surfaces = await this.#computerUse.presentableSurfaces(owner, threadId);
    const result: ScreenSurface[] = [];
    for (const surface of surfaces) {
      try {
        await this.authorizeTarget(owner, { conversationId: threadId, surface });
        result.push(surface);
      } catch {
        /* A revoked source is omitted. */
      }
    }
    return result;
  }
  contextFor(messageId: MessageId) {
    return this.registry.contextFor(messageId);
  }
  close(): void {
    this.registry.close();
  }
}
