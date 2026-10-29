import { z } from "zod";
import {
  DesktopPasswordsSignInCardInputSchema,
  DesktopPasswordsSignInApproveInputSchema,
  DesktopPasswordsSignInApproveResultSchema,
  DesktopPasswordsSignInCardStateSchema,
  DesktopPasswordsStatusSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
  trackRenderer,
} from "../context.js";

export const handleGetPasswordsStatus = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  passwordsHandler(async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackRenderer(context.passwordsSenders, event.sender);
    return DesktopPasswordsStatusSchema.parse(await context.options.passwords.status());
  });

export const handleOpenPasswords = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  passwordsHandler(async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.passwords.open();
  });

export const handleGetPasswordsSignIn = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  passwordsHandler((event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const { operationId } = DesktopPasswordsSignInCardInputSchema.parse(envelope.input);
    let operations = context.passwordsSignInCards.get(event.sender);
    if (!operations) {
      operations = new Set();
      context.passwordsSignInCards.set(event.sender, operations);
      event.sender.once("destroyed", () => context.passwordsSignInCards.delete(event.sender));
    }
    operations.add(operationId);
    return DesktopPasswordsSignInCardStateSchema.parse(
      context.options.passwords.signIns.get(operationId),
    );
  });

export const handleApprovePasswordsSignIn = (context: DesktopBridgeContext): DesktopBridgeHandler =>
  passwordsHandler(async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopPasswordsSignInApproveInputSchema.parse(envelope.input);
    assertCardSender(context, event.sender, input.operationId);
    return DesktopPasswordsSignInApproveResultSchema.parse(
      await context.options.passwords.signIns.approve(input),
    );
  });

function assertCardSender(
  context: DesktopBridgeContext,
  sender: import("electron").WebContents,
  operationId: string,
): void {
  if (!context.passwordsSignInCards.get(sender)?.has(operationId))
    throw new Error("Read this sign-in card before responding to it.");
}

/** Electron decorates thrown IPC errors; the renderer receives only a structured answer. */
function passwordsHandler(handler: DesktopBridgeHandler): DesktopBridgeHandler {
  return async (event, envelope) => {
    try {
      return { ok: true, value: (await handler(event, envelope)) ?? null };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof z.ZodError
            ? "Opensteer could not read that Passwords request or answer."
            : error instanceof Error && error.message.trim()
              ? error.message
              : "Opensteer could not finish that Passwords action.",
      };
    }
  };
}
