import { z } from "zod";
import { PluginTargetSchema, SettingsPluginPlacementCommandSchema } from "@opensteer/protocol";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";

const consentSchema = z.strictObject({
  target: PluginTargetSchema,
  everywhere: z.boolean(),
  places: z.array(z.string()).max(2000),
  access: z.enum(["read", "read-write"]),
  idempotencyKey: z.string().min(1),
  command: SettingsPluginPlacementCommandSchema.nullable(),
});
export type PluginAddConsent = z.infer<typeof consentSchema>;

// Main's identity and the viewer fence a draft to this Deployment and signed-in person.
export function pluginConsentKey(mainId: string, userId: string, attemptId: string) {
  return `opensteer:plugin-consent:${mainId}:${userId}:${attemptId}`;
}
export function readPluginConsent(key: string): PluginAddConsent | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = consentSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error("Plugin consent could not be restored. Review its placement in Plugins.");
  return parsed.data;
}
export function storePluginConsent(key: string, consent: PluginAddConsent) {
  // Only the opaque attempt, public account/Workspace identities and reviewed access are retained.
  sessionStorage.setItem(key, JSON.stringify(consentSchema.parse(consent)));
}
export async function completePluginConsent(
  client: HostClient,
  consent: PluginAddConsent,
  connectionId: string,
  remember: (consent: PluginAddConsent) => void,
) {
  let command = consent.command;
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
    remember({ ...consent, command });
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
