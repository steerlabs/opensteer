import { agentWords, type AccessModeOption } from "@opensteer/client/host";
import type { ThreadAccessMode } from "@opensteer/core";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

/** An older Home's consent, which takes no grant: the agent may do everything. */
export const agentAuthorizationFinePrint = agentWords("consent.legacyFinePrint");
export const agentAuthorizationUnverified = agentWords("consent.unverified");
export const agentAuthorizationLabelLimit = 120;

export type AgentAuthorizationFormProps =
  | { readonly kind: "loading" }
  | {
      /** It can't be reviewed: expired, answered elsewhere, or not read. */
      readonly kind: "failed";
      readonly title: string;
      readonly detail: string;
      readonly onRetry: (() => void) | null;
      readonly onClose: () => void;
    }
  | {
      readonly kind: "ready";
      readonly title: string;
      /** Its provider's mark when the Home proved its origin, its initial otherwise; null on an older Home. */
      readonly mark: { readonly providerId: string | null; readonly initial: string } | null;
      readonly destination: string;
      /**
       * Who is asking, in the Home's words: a verified pair or platform, or the name it gave
       * itself ("Says it is …") with its origin or "an app on this computer". The warning is
       * the Home's own line.
       */
      readonly who: {
        readonly heading: string;
        readonly detail: string;
        readonly verified: boolean;
        readonly warning: string | null;
      };
      /**
       * What it can use and its safety mode, as Settings rows. Null on an older Home,
       * which shows the four modes alone.
       */
      readonly sections: readonly NativeSettingsSection[] | null;
      readonly modes: readonly AccessModeOption[];
      readonly mode: ThreadAccessMode;
      readonly onMode: (mode: ThreadAccessMode) => void;
      readonly label: string;
      readonly onLabel: (label: string) => void;
      readonly finePrint: string;
      readonly busy: "allow" | "deny" | null;
      readonly error: string | null;
      readonly onAllow: () => void;
      readonly onDeny: () => void;
    };
