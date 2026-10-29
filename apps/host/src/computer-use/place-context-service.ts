import {
  OpensteerError,
  type ContentPart,
  type PlaceContentPart,
  type Thread,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { IntegrationStore, OpensteerStore } from "@opensteer/database";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core";
import type { BrowserService } from "../browser/browser-service.js";
import type { IntegrationPlatformService } from "../integrations/integration-platform-service.js";
import type { ComputerUseService } from "./computer-use-service.js";

type ComputerUseInventory = Awaited<ReturnType<ComputerUseService["eligibleInventory"]>>;

interface PlaceContextDependencies {
  readonly browser: Pick<BrowserService, "assertPagesUsable">;
  readonly computerUse: Pick<ComputerUseService, "eligibleInventory" | "sessionsForRunner">;
  readonly connections: Pick<IntegrationStore, "listConnections">;
  readonly integrations: Pick<IntegrationPlatformService, "listCallableTools">;
  readonly store: Pick<OpensteerStore, "hasHumanIncludedPlace">;
}

/** References are checked against current authority, without opening or borrowing a session. */
export class PlaceContextService {
  readonly #dependencies: PlaceContextDependencies;
  constructor(dependencies: PlaceContextDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * A person's message names its Mac apps and phones; it never uses them. So
   * the sender must own each computer, and nothing about its use is asked:
   * the conversation's agent asks for access, or finds the computer offline
   * or the phone busy, when it acts. A refusal here would drop the whole
   * message for a place the person only pointed at.
   */
  async assertIncludable(input: {
    readonly ownerId: UserId;
    readonly parts: readonly ContentPart[];
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }): Promise<void> {
    const pages = input.parts.filter((part) => part.type === "browser-page");
    if (pages.length) await this.#dependencies.browser.assertPagesUsable({ ...input, pages });
    const native = input.parts.filter(
      (part) => part.type === "computer-app" || part.type === "phone",
    );
    if (!native.length) return;
    const inventory = await this.#dependencies.computerUse.eligibleInventory(input.ownerId);
    for (const part of native) this.#assertNamed(inventory, part);
  }

  /** What a forwarded place must prove: its target may use it now, as a call would. */
  async assertUsable(input: {
    readonly ownerId: UserId;
    readonly parts: readonly ContentPart[];
    /** For a new child, its parent's ID supplies the child's unchanged Main lineage. */
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
    /** Null for a new child: its parent's phone holding is not the child's. */
    readonly busyThreadId?: ThreadId | null;
  }): Promise<void> {
    const pages = input.parts.filter((part) => part.type === "browser-page");
    if (pages.length) await this.#dependencies.browser.assertPagesUsable({ ...input, pages });
    const native = input.parts.filter(
      (part) => part.type === "computer-app" || part.type === "phone",
    );
    if (!native.length) return;
    const inventory = await this.#dependencies.computerUse.eligibleInventory(input.ownerId);
    const connections = await this.#dependencies.connections.listConnections(input.ownerId);
    // This uses the target Workspace's grants and the target Thread's Main lineage.
    const tools = await this.#dependencies.integrations.listCallableTools({
      ownerUserId: input.ownerId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    });
    for (const part of native) {
      const machine = this.#assertNamed(inventory, part);
      if (!machine.ready)
        throw new OpensteerError({
          code: "conflict",
          message: `The included computer is ${machine.state}.`,
        });
      if (part.type === "phone") {
        const allowedThread =
          input.busyThreadId === undefined ? input.threadId : input.busyThreadId;
        const held = this.#dependencies.computerUse
          .sessionsForRunner(part.machineId)
          .some((session) => session.display && session.threadId !== allowedThread);
        if (held)
          throw new OpensteerError({
            code: "conflict",
            message:
              "The included phone is busy with another task. Release it there before forwarding or including it here.",
          });
      }
      const connection = connections.find(
        (candidate) =>
          candidate.status === "connected" &&
          candidate.computer?.runnerId === part.machineId &&
          !candidate.computer.blockedAt &&
          (part.type === "computer-app"
            ? candidate.definitionId === "macos-app" &&
              candidate.computer.app !== null &&
              computerAppIdentitiesEqual(candidate.computer.app, part.app)
            : candidate.definitionId === "android-phone" && candidate.computer.app === null),
      );
      if (
        !connection ||
        !tools.some(
          (tool) => tool.grant.connectionId === connection.id && tool.tool.name === "observe",
        )
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message:
            "This conversation's Workspace cannot see the included app or phone. Its task must obtain access through its own explicit request before it can use this reference.",
        });
      }
    }
  }

  #assertNamed(
    inventory: ComputerUseInventory,
    part: Extract<ContentPart, { readonly type: "computer-app" | "phone" }>,
  ): ComputerUseInventory["machines"][number] {
    const machine = (part.type === "phone" ? inventory.phones : inventory.machines).find(
      (candidate) => candidate.runnerId === part.machineId,
    );
    if (!machine)
      throw new OpensteerError({
        code: "forbidden",
        message: "The included computer is unavailable to you.",
      });
    if (part.type === "phone" && part.display !== "main") {
      throw new OpensteerError({
        code: "bad_request",
        message: "This phone does not offer the included display.",
      });
    }
    return machine;
  }

  async assertDelegated(input: {
    readonly ownerId: UserId;
    readonly parent: Thread;
    readonly parts: readonly PlaceContentPart[];
    readonly targetThread?: Thread;
    readonly workspaceId: WorkspaceId;
  }): Promise<void> {
    for (const part of input.parts) {
      if (await this.#dependencies.store.hasHumanIncludedPlace(input.parent.id, part)) continue;
      // An agent may also forward a place its own Run may use, never an arbitrary address.
      await this.assertUsable({
        ownerId: input.ownerId,
        parts: [part],
        threadId: input.parent.id,
        workspaceId: input.parent.workspaceId,
      });
    }
    await this.assertUsable({
      ownerId: input.ownerId,
      parts: input.parts,
      threadId: input.targetThread?.id ?? input.parent.id,
      busyThreadId: input.targetThread?.id ?? null,
      workspaceId: input.workspaceId,
    });
  }
}
