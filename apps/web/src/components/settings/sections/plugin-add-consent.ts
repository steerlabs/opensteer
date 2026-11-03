import { PluginAddConsentSchema, type PluginAddConsent } from "@opensteer/client/settings";
export { completePluginConsent, type PluginAddConsent } from "@opensteer/client/settings";
// Main's identity and the viewer fence a draft to this Deployment and signed-in person.
export function pluginConsentKey(mainId: string, userId: string, attemptId: string) {
  return `opensteer:plugin-consent:${mainId}:${userId}:${attemptId}`;
}
export function readPluginConsent(key: string): PluginAddConsent | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = PluginAddConsentSchema.safeParse(JSON.parse(raw));
  if (!parsed.success)
    throw new Error("Plugin consent could not be restored. Review its placement in Plugins.");
  return parsed.data;
}
export function storePluginConsent(key: string, consent: PluginAddConsent) {
  // Only the opaque attempt, public account/Workspace identities and reviewed access are retained.
  sessionStorage.setItem(key, JSON.stringify(PluginAddConsentSchema.parse(consent)));
}
