import type { ReactElement } from "react";
import type { RowMark } from "../ui/integration-icon.js";
import type { SentencePart } from "../ui/sentence-parts.js";
import type { SFSymbolName } from "../ui/symbol.js";

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
      readonly kind: "content";
      readonly key: string;
      readonly label: string;
      readonly content: ReactElement;
    }
  | {
      readonly key: string;
      readonly kind: "chips";
      readonly label: string;
      readonly value: string;
      readonly choices: readonly { readonly value: string; readonly label: string }[];
      readonly onChange: (value: string) => void;
      /** Open as a menu from a row naming the choice, so the label stays beside it. */
      readonly menu?: boolean;
    }
  | {
      /** One of several choices that each need a line of their own, such as a mode. */
      readonly key: string;
      readonly kind: "choice";
      readonly label: string;
      readonly detail?: string;
      readonly selected: boolean;
      /** Several may be chosen at once: a checkbox where the platform draws one. */
      readonly multiple?: boolean;
      readonly disabled?: boolean;
      readonly onPress: () => void;
    }
  | {
      readonly key: string;
      readonly kind: "text";
      readonly label: string;
      /**
       * The label as words and addresses, where it is a sentence holding addresses among its
       * words (`sentenceWith`): each address drawn as one, the sentence read as `label`.
       */
      readonly labelParts?: readonly SentencePart[];
      readonly detail?: string;
      /**
       * Which of its words is an email address, a host or a URL (`isAddress`): the row draws it as
       * one, whole and wrapping only at its joints, and reads it aloud and copies it as it is.
       */
      readonly addressIn?: "label" | "detail";
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
      /**
       * Which of its words is an email address, a host or a URL (`isAddress`): the row draws it as
       * one, whole and wrapping only at its joints, and reads it aloud and copies it as it is.
       */
      readonly addressIn?: "label" | "detail";
      readonly steps?: readonly NativeSettingsStep[];
    }
  | {
      /** The one main action on a screen, drawn as a filled button. */
      readonly key: string;
      readonly kind: "primary";
      readonly label: string;
      readonly disabled?: boolean;
      /** Let a form keep its action visible while the list scrolls above the keyboard. */
      readonly pinned?: boolean;
      readonly onPress: () => void;
    }
  | {
      readonly key: string;
      readonly kind: "button";
      readonly label: string;
      readonly detail?: string;
      /**
       * Which of its words is an email address, a host or a URL (`isAddress`): the row draws it as
       * one, whole and wrapping only at its joints, and reads it aloud and copies it as it is.
       */
      readonly addressIn?: "label" | "detail";
      /** The row opens a page about this thing rather than acting at once. */
      readonly opens?: boolean;
      /** The integration or plugin whose mark leads the row. */
      readonly mark?: RowMark;
      /** The system symbol on a quiet tile that leads the row, where the platform draws one. */
      readonly symbol?: SFSymbolName;
      /** A React Native view that leads the row, such as an agent's mark. */
      readonly lead?: ReactElement;
      readonly disabled?: boolean;
      readonly destructive?: boolean;
      /** Amber detail for a thing that needs the person, such as a Device that is asleep. */
      readonly tone?: "attention";
      readonly onPress: () => void;
      readonly actions?: readonly NativeSettingsAction[];
    }
  | {
      readonly key: string;
      readonly kind: "toggle";
      readonly label: string;
      readonly detail?: string;
      readonly disabled?: boolean;
      /** Null while the value was never loaded: a track with no knob, never "off". */
      readonly value: boolean | null;
      readonly onChange: (value: boolean) => void;
    }
  | {
      /** A row whose content never arrived, drawn still in its real shape. */
      readonly key: string;
      readonly kind: "placeholder";
      /** Read aloud for the still bars. */
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "input";
      readonly label: string;
      readonly secure?: boolean;
      readonly value: string;
      readonly onChange: (value: string) => void;
      /** Return on the keyboard, where the platform reports it. */
      readonly onSubmit?: () => void;
    };
/** A section's last line: a note, or the answer to an action in it, with one link such as Check. */
export interface NativeSettingsFooter {
  readonly text: string;
  readonly tone?: "danger" | undefined;
  readonly link?: { readonly label: string; readonly onPress: () => void } | null | undefined;
}
export interface NativeSettingsSection {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly NativeSettingsRow[];
  readonly collapsed?: boolean;
  /** One sentence under the group; `danger` when it says what went wrong. */
  readonly footer?: NativeSettingsFooter;
}
export interface NativeSettingsPageProps {
  readonly sheet?: { readonly title: string; readonly onClose: () => void };
  readonly sections: readonly NativeSettingsSection[];
  readonly search?: {
    readonly value: string;
    readonly onChange: (value: string) => void;
    /** What the field asks for, and the page's title where the field brings its own bar. */
    readonly prompt?: string;
    readonly title?: string;
  };
}
