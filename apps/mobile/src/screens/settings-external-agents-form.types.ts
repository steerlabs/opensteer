import type { ExternalAgentGuide } from "@opensteer/client/host";
import type { NativeSettingsFooter } from "./native-settings-page.types.js";

export interface ExternalAgentsFormProps {
  readonly connections: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly removing: boolean;
  }[];
  /** The list never arrived: its rows are drawn as placeholders. */
  readonly loading: boolean;
  /** Why the list is missing, or how the last removal went. */
  readonly line: NativeSettingsFooter | null;
  readonly guides: readonly ExternalAgentGuide[];
  /** Setup needs the loaded list as its baseline and a reachable address. */
  readonly addDisabled: boolean;
  /** One removal at a time: the client ignores a second while the first is pending. */
  readonly removeDisabled: boolean;
  /** Why agents cannot be added yet, and the way to fix it; null when they can. */
  readonly notice: {
    readonly title: string;
    readonly detail: string;
    readonly action: { readonly label: string; readonly onPress: () => void } | null;
  } | null;
  readonly footnote: string | null;
  readonly onAdd: (guide: ExternalAgentGuide) => void;
  readonly onRemove: (connectionId: string) => void;
}
