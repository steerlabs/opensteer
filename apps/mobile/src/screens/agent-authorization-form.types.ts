import type { AccessModeOption } from "@opensteer/client/host";
import type { ThreadAccessMode } from "@opensteer/core";

export const agentAuthorizationFinePrint =
  "It can’t approve requests, see passwords or give anyone access. This lasts 30 days, and you can remove it in Settings → External agents.";
export const agentAuthorizationUnverified =
  "App names aren’t verified. Allow only an agent you just started connecting.";
export const agentAuthorizationEverything = "Everything I can access";
export const agentAuthorizationLabelLimit = 120;

export type AgentAuthorizationFormProps =
  | { readonly kind: "loading" }
  | {
      readonly kind: "failed";
      readonly detail: string;
      readonly onRetry: (() => void) | null;
      readonly onClose: () => void;
    }
  | {
      readonly kind: "ready";
      readonly title: string;
      readonly destination: string;
      readonly modes: readonly AccessModeOption[];
      readonly mode: ThreadAccessMode;
      readonly onMode: (mode: ThreadAccessMode) => void;
      /** The person's Workspaces, then "user" for everything they can access. */
      readonly reaches: readonly { readonly id: string; readonly name: string }[];
      readonly reach: string;
      readonly onReach: (reach: string) => void;
      readonly label: string;
      readonly onLabel: (label: string) => void;
      readonly busy: "allow" | "deny" | null;
      readonly error: string | null;
      readonly onAllow: () => void;
      readonly onDeny: () => void;
    };
