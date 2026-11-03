import { z } from "zod";
import { PluginTargetSchema, SettingsPluginPlacementCommandSchema } from "@opensteer/protocol";
import { unwrapRpcResult, type HostClient } from "../host/index.js";
export const PluginAddConsentSchema = z.strictObject({
  target: PluginTargetSchema,
  everywhere: z.boolean(),
  places: z.array(z.string()).max(2000),
  access: z.enum(["read", "read-write"]),
  idempotencyKey: z.string().min(1),
  command: SettingsPluginPlacementCommandSchema.nullable(),
  connectionId: z.string().min(1).optional(),
});
export type PluginAddConsent = z.infer<typeof PluginAddConsentSchema>;

export async function completePluginConsent(
  client: HostClient,
  consent: PluginAddConsent,
  connectionId: string,
  remember: (consent: PluginAddConsent) => void,
) {
  let command = consent.command;
  if (consent.connectionId && consent.connectionId !== connectionId)
    throw new Error("This placement belongs to a different connection. Review placement again.");
  if (!command) {
    const detail = unwrapRpcResult(
      await client.rpc["plugins.detail.get"]({ target: consent.target }),
    );
    const account = detail.accounts.find((account) => account.connectionId === connectionId);
    if (!account)
      throw new Error("The connected account is not available. Review its placement in Plugins.");
    const accounts = [{ connectionId: account.connectionId, access: consent.access }];
    command = SettingsPluginPlacementCommandSchema.parse({
      type: "settings.plugin.placement.set",
      idempotencyKey: consent.idempotencyKey,
      target: consent.target,
      expectedRevision: detail.row.placement.revision,
      mainIncluded:
        consent.everywhere ||
        detail.places.some(
          (place) => place.kind === "main" && consent.places.includes(place.workspaceId),
        ),
      projects: detail.places
        .filter(
          (place) =>
            place.kind !== "main" &&
            (consent.everywhere || consent.places.includes(place.workspaceId)),
        )
        .map((place) => ({ workspaceId: place.workspaceId, accounts })),
      personalEverywhere: consent.everywhere ? { accounts } : null,
    });
    remember({ ...consent, command, connectionId });
  }
  try {
    await client.dispatch(command);
  } catch (reason) {
    try {
      await client.rpc["plugins.detail.get"]({ target: consent.target }).then(unwrapRpcResult);
    } catch {
      /* Retain the original command until the outcome can be reconciled. */
    }
    throw reason;
  }
}
