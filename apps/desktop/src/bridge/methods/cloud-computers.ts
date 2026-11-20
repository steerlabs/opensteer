import type { CloudComputerAccount } from "@opensteer/client/connections";
import {
  DesktopCloudComputerActInputSchema,
  type DesktopCloudComputerActResult,
  type DesktopCloudComputerReadResult,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

const unavailable = {
  ok: false,
  failure: { kind: "unavailable", message: "This build of Opensteer has no Opensteer Account." },
} as const;

function account(context: DesktopBridgeContext, event: Parameters<DesktopBridgeHandler>[0]) {
  if (!context.options.isWorkspaceContents?.(event.sender))
    throw new Error("Only the application window may manage a Cloud Computer.");
  return context.options.cloudComputers ?? null;
}

/** The person's Cloud Computers, read with the Account session main holds. */
export const handleCloudComputerRead =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope): Promise<DesktopCloudComputerReadResult> => {
    assertAuthorizedRenderer(context, event, envelope);
    const client: CloudComputerAccount | null = account(context, event);
    return client ? client.read() : unavailable;
  };

/** Suspend, resume or delete one; the Account decides and its refusal is passed on as said. */
export const handleCloudComputerAct =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope): Promise<DesktopCloudComputerActResult> => {
    assertAuthorizedRenderer(context, event, envelope);
    const client = account(context, event);
    const input = DesktopCloudComputerActInputSchema.parse(envelope.input);
    return client ? client.act(input) : unavailable;
  };
