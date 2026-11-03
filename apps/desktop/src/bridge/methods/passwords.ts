import { z } from "zod";
import { DesktopPasswordsStatusSchema } from "@opensteer/protocol/desktop";
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
