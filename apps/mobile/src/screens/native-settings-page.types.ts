/** Meaning colours only: green working, red broken, amber needs you, grey off. */
export type NativeSettingsTone = "neutral" | "good" | "attention" | "bad";

export interface NativeSettingsStep {
  readonly label: string;
  readonly state: "done" | "current" | "pending" | "failed";
}

export interface NativeSettingsAction {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}

export type NativeSettingsRow =
  | {
      readonly key: string;
      readonly kind: "chips";
      readonly label: string;
      readonly value: string;
      readonly choices: readonly { readonly value: string; readonly label: string }[];
      readonly onChange: (value: string) => void;
    }
  | {
      readonly key: string;
      readonly kind: "text";
      readonly label: string;
      readonly detail?: string;
      /** A person's round initial, leading an identity row. */
      readonly initial?: string;
    }
  | {
      readonly key: string;
      readonly kind: "status";
      readonly tone: NativeSettingsTone;
      readonly label: string;
      /** Something to read or copy under the status, such as an address. */
      readonly detail?: string;
      readonly steps?: readonly NativeSettingsStep[];
    }
  | {
      /** The one main action on a screen, drawn as a filled button. */
      readonly key: string;
      readonly kind: "primary";
      readonly label: string;
      readonly disabled?: boolean;
      readonly onPress: () => void;
    }
  | {
      readonly key: string;
      readonly kind: "button";
      readonly label: string;
      readonly detail?: string;
      /** The row opens a page about this thing rather than acting at once. */
      readonly opens?: boolean;
      /** The integration whose mark leads the row. */
      readonly mark?: { readonly definitionId: string; readonly name: string };
      readonly disabled?: boolean;
      readonly destructive?: boolean;
      readonly onPress: () => void;
      readonly actions?: readonly NativeSettingsAction[];
    }
  | {
      readonly key: string;
      readonly kind: "toggle";
      readonly label: string;
      readonly detail?: string;
      readonly disabled?: boolean;
      readonly value: boolean;
      readonly onChange: (value: boolean) => void;
    }
  | {
      readonly key: string;
      readonly kind: "input";
      readonly label: string;
      readonly secure?: boolean;
      readonly value: string;
      readonly onChange: (value: string) => void;
    };
export interface NativeSettingsSection {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly NativeSettingsRow[];
  readonly collapsed?: boolean;
  /** One sentence under the group; `danger` when it says what went wrong. */
  readonly footer?: { readonly text: string; readonly tone?: "danger" };
}
export interface NativeSettingsPageProps {
  readonly sheet?: { readonly title: string; readonly onClose: () => void };
  readonly sections: readonly NativeSettingsSection[];
  readonly search?: { readonly value: string; readonly onChange: (value: string) => void };
}
