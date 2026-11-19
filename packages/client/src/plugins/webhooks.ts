import type { PluginCommand, PluginWebhookSetupView, PluginWebhookView } from "@opensteer/protocol";
import { pluginInputContent, pluginInputForm, type PluginInputForm } from "./input-form.js";

/** A webhook's state as a short line. */
export function pluginWebhookStatusText(webhook: PluginWebhookView): string {
  if (webhook.failure)
    return `Couldn't ${webhook.failure === "register" ? "register with" : "unregister from"} the service`;
  switch (webhook.status) {
    case "active":
      return "Receiving events";
    case "setup-required":
      return "Needs setup at the service";
    case "pending":
      return "Setting up";
    case "stopping":
      return "Waiting for you to remove it at the service";
    case "disabled":
      // Opensteer stopped using it but can't take it off the service: a manual setup, one whose
      // accounts it may no longer use, or one the plugin's active version no longer declares.
      return "Waiting for you to remove it at the service: Opensteer can't remove it there itself";
    default:
      return "Stopped";
  }
}

/**
 * What finishing a manual webhook setup asks of the person: the fields the
 * plugin's state schema declares, and the signing secret. A secret Opensteer
 * generated is shown to copy and never sent back; a secret the service makes
 * must be pasted in.
 */
export interface PluginWebhookSetupForm {
  readonly fields: PluginInputForm;
  readonly secret:
    { readonly kind: "generated"; readonly value: string } | { readonly kind: "provider" } | null;
}

export function pluginWebhookSetupForm(setup: PluginWebhookSetupView): PluginWebhookSetupForm {
  if (setup.step !== "configure") return { fields: { fields: [], unsupported: [] }, secret: null };
  return {
    fields: pluginInputForm(setup.stateSchema ?? {}),
    secret: setup.signingSecret
      ? { kind: "generated", value: setup.signingSecret }
      : { kind: "provider" },
  };
}

type CompleteWebhookSetup = Omit<
  Extract<PluginCommand, { type: "plugins.webhook.setup.complete" }>,
  "type" | "idempotencyKey"
>;

/** The completion to send for what the person entered, or why it can't be sent yet. */
export function pluginWebhookSetupCompletion(
  pluginId: string,
  setup: PluginWebhookSetupView,
  answers: Readonly<Record<string, readonly string[]>>,
  secret: string,
): { readonly command: CompleteWebhookSetup } | { readonly problem: string } {
  if (setup.step !== "configure" || !setup.revision)
    return { problem: "This webhook isn't waiting for setup anymore." };
  const form = pluginWebhookSetupForm(setup);
  const content = pluginInputContent(form.fields, answers);
  if ("problem" in content) return content;
  const pasted = secret.trim();
  if (form.secret?.kind === "provider" && !pasted)
    return { problem: "Paste the signing secret the service shows you." };
  return {
    command: {
      pluginId,
      webhookId: setup.webhook.id,
      revision: setup.revision,
      state: content.content,
      ...(form.secret?.kind === "provider" ? { secret: pasted } : {}),
    },
  };
}
