import {
  IntegrationCallSubjectSchema,
  type IntegrationCallSubject,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { CallableIntegrationTool, IntegrationPlatformStore } from "@opensteer/database";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import { androidPhoneDefinitionId, type PendingAgentEvent } from "@opensteer/protocol";
import { z } from "zod";
import { computerUseDefinitionId } from "../computer-use/computer-use-service.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";
import { describedOperation, resolveOperation } from "./integration-operation.js";

/** The two gateway tools whose `operation` and `account` name one operation under one grant. */
const addressingTools = new Set(["integration_call", "integration_describe"]);
/** The one Opensteer server, and the retired integrations server a resumed native session still names. */
const gatewayNamespaces = new Set(["opensteer", "opensteer.integrations"]);
const AddressingArgumentsSchema = z.object({
  account: z.string().optional(),
  operation: z.string(),
});

export interface IntegrationCallSubjectSources {
  /** The gateway's own listing, cached per owner and Workspace, so a call is named as it resolves. */
  readonly listCallableTools: IntegrationPlatformService["listCallableTools"];
  readonly getComputerConnectionForCall: IntegrationPlatformStore["getComputerConnectionForCall"];
  /** A lookup that failed; the event is still recorded, without a subject. */
  readonly onError: (error: unknown, event: PendingAgentEvent) => void;
  readonly runRequester: (input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }) => Promise<UserId | null>;
}

/**
 * What a Runner's `tool.started` for an integration gateway call addressed,
 * resolved exactly as the gateway resolves the call — from its cached listing
 * for the Run's owner and the event's Workspace — to that one grant and tool
 * This is the one place the Host names a recorded call's subject.
 *
 * Undefined for every other event, and for an address that names nothing
 * this Run could reach — a hallucinated or revoked operation or another
 * Workspace's account. The record of such a call is the honest one: it
 * addressed nothing, so it names nothing.
 *
 * It runs before the event commits, so a lookup that fails is reported and
 * the event is committed without a subject rather than refused.
 */
export async function integrationCallSubject(
  sources: IntegrationCallSubjectSources,
  event: PendingAgentEvent,
): Promise<IntegrationCallSubject | undefined> {
  if (event.type !== "tool.started") return undefined;
  const { tool } = event.data;
  if (!gatewayNamespaces.has(tool.namespace) || !addressingTools.has(tool.name)) {
    return undefined;
  }
  const call = AddressingArgumentsSchema.safeParse(event.data.arguments);
  if (!call.success) return undefined;
  try {
    const ownerUserId = await sources.runRequester({
      runId: event.runId,
      threadId: event.threadId,
      workspaceId: event.workspaceId,
    });
    if (!ownerUserId) return undefined;
    const resolution = resolveOperation(
      await sources.listCallableTools({
        ownerUserId,
        threadId: event.threadId,
        workspaceId: event.workspaceId,
      }),
      call.data.operation,
      call.data.account,
    );
    const callable =
      tool.name === "integration_describe"
        ? describedOperation(resolution)
        : resolution.kind === "found"
          ? resolution.callable
          : undefined;
    if (!callable) return undefined;
    const computer = await computerSubject(sources, callable, ownerUserId);
    if (computer === undefined) return undefined;
    return IntegrationCallSubjectSchema.parse({
      account: callable.grant.alias,
      computerApp: computer.computerApp,
      effect: integrationToolEffect(callable.tool.annotations),
      integration: callable.installation.title,
      operation: { name: callable.tool.name, title: callable.tool.title },
      ...(computer.phone ? { phone: computer.phone } : {}),
    });
  } catch (error) {
    sources.onError(error, event);
    return undefined;
  }
}

/**
 * The approved app and its Mac for a Computer use tool, or the phone for an
 * Android phone tool, and neither for any other tool. Undefined when the
 * connection no longer names an app on a Mac, or a phone, this owner can use,
 * which the call itself will be refused for.
 */
async function computerSubject(
  sources: Pick<IntegrationCallSubjectSources, "getComputerConnectionForCall">,
  callable: CallableIntegrationTool,
  ownerUserId: UserId,
): Promise<
  | {
      readonly computerApp: IntegrationCallSubject["computerApp"];
      readonly phone: IntegrationCallSubject["phone"];
    }
  | undefined
> {
  const { transport } = callable.server;
  if (
    transport.type !== "computer" ||
    (transport.definitionId !== computerUseDefinitionId &&
      transport.definitionId !== androidPhoneDefinitionId)
  ) {
    return { computerApp: null, phone: undefined };
  }
  const connectionId = callable.grant.connectionId;
  if (!connectionId) return undefined;
  const placement = await sources.getComputerConnectionForCall({ connectionId, ownerUserId });
  if (!placement) return undefined;
  const app = placement.connection.computer?.app ?? null;
  if (transport.definitionId === androidPhoneDefinitionId) {
    return app === null
      ? {
          computerApp: null,
          phone: { computer: placement.runnerName, runnerId: placement.runnerId },
        }
      : undefined;
  }
  if (!app) return undefined;
  return {
    computerApp: {
      app: app.displayName,
      bundleId: app.bundleId,
      computer: placement.runnerName,
      runnerId: placement.runnerId,
    },
    phone: undefined,
  };
}
