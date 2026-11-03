export type NativeSettingsRow =
  | {
      readonly key: string;
      readonly kind: "chips";
      readonly label: string;
      readonly value: string;
      readonly choices: readonly { readonly value: string; readonly label: string }[];
      readonly onChange: (value: string) => void;
    }
  | { readonly key: string; readonly kind: "text"; readonly label: string }
  | {
      readonly key: string;
      readonly kind: "button";
      readonly label: string;
      readonly disabled?: boolean;
      readonly destructive?: boolean;
      readonly onPress: () => void;
    }
  | {
      readonly key: string;
      readonly kind: "toggle";
      readonly label: string;
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
}
export interface NativeSettingsPageProps {
  readonly sections: readonly NativeSettingsSection[];
  readonly search?: { readonly value: string; readonly onChange: (value: string) => void };
}
