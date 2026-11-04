import { useEffect, type ReactNode } from "react";

/*
 * React Native as the settings screens' DOM tests see it: a pressable is a
 * button named by its label, a switch is a checkbox named by its label, a
 * native menu lists its choices as buttons, and an alert waits in `native`
 * until a test presses one of its buttons. Navigation is recorded, not done.
 */

type Children = { readonly children?: ReactNode };

interface AlertButton {
  readonly onPress?: () => void;
  readonly style?: string;
  readonly text: string;
}

export const native = {
  alert: null as null | { readonly buttons: readonly AlertButton[]; readonly title: string },
  navigate: [] as { readonly name: string; readonly params?: unknown }[],
  shared: [] as string[],
  reset(): void {
    native.alert = null;
    native.navigate = [];
    native.shared = [];
  },
};

const Box = (props: Children & { readonly accessibilityLabel?: string }) => (
  <div aria-label={props.accessibilityLabel}>{props.children}</div>
);

export const reactNative = {
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  ActivityIndicator: () => <span role="progressbar" />,
  Alert: {
    alert: (title: string, _message: string, buttons: readonly AlertButton[]) => {
      native.alert = { buttons, title };
    },
  },
  Modal: (props: Children & { readonly visible?: boolean }) =>
    props.visible ? <div role="dialog">{props.children}</div> : null,
  Platform: { OS: "ios", select: (choices: { ios?: unknown }) => choices.ios },
  Pressable: (
    props: Children & {
      readonly accessibilityLabel?: string;
      readonly disabled?: boolean;
      readonly onPress?: () => void;
      readonly style?: unknown;
    },
  ) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {typeof props.children === "function" ? null : props.children}
    </button>
  ),
  ScrollView: Box,
  Share: {
    share: async ({ message }: { readonly message: string }) => {
      native.shared.push(message);
      return { action: "sharedAction" };
    },
  },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: ({ children }: Children) => <span>{children}</span>,
  View: Box,
};

export const primitives = {
  AppText: ({ children }: Children) => <span>{children}</span>,
  CodeBlock: (props: { readonly label?: string; readonly text: string }) => (
    <pre aria-label={props.label}>{props.text}</pre>
  ),
  Field: (props: {
    readonly input: {
      readonly onChangeText?: (text: string) => void;
      readonly placeholder?: string;
      readonly value?: string;
    };
    readonly label: string;
  }) => (
    <input
      aria-label={props.label}
      onChange={(event) => props.input.onChangeText?.(event.currentTarget.value)}
      placeholder={props.input.placeholder}
      value={props.input.value}
    />
  ),
  monoFontFamily: "monospace",
  Notice: (props: {
    readonly action?: { readonly label: string; readonly onPress: () => void };
    readonly detail: string;
    readonly title: string;
  }) => (
    <div role="note">
      <strong>{props.title}</strong>
      <p>{props.detail}</p>
      {props.action ? <button onClick={props.action.onPress}>{props.action.label}</button> : null}
    </div>
  ),
  PrimaryButton: (props: {
    readonly busy?: boolean;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button disabled={props.disabled || props.busy} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  RowGroup: ({ children }: Children) => <div>{children}</div>,
  SecondaryButton: (props: {
    readonly busy?: boolean;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button disabled={props.disabled || props.busy} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  SectionLabel: ({ children }: Children) => <h2>{children}</h2>,
  Toggle: (props: {
    readonly accessibilityLabel: string;
    readonly disabled?: boolean;
    readonly onChange: (value: boolean) => void;
    readonly value: boolean;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      checked={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
      role="switch"
      type="checkbox"
    />
  ),
};

export const choiceMenu = {
  ChoiceMenu: (props: {
    readonly accessibilityLabel: string;
    readonly busy?: boolean;
    readonly choices: readonly { readonly id: string; readonly title: string }[];
    readonly disabled?: boolean;
    readonly label: string;
    readonly onChoose: (id: string) => void;
  }) => (
    <div aria-label={props.accessibilityLabel} data-menu={props.label} role="group">
      {props.choices.map((choice) => (
        <button
          disabled={props.disabled || props.busy}
          key={choice.id}
          onClick={() => props.onChoose(choice.id)}
        >
          {choice.title}
        </button>
      ))}
    </div>
  ),
};

export const screen = {
  Screen: ({ children }: Children) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
};

export const navigation = {
  useFocusEffect: (effect: () => void | (() => void)) =>
    useEffect(() => effect() ?? undefined, [effect]),
  useNavigation: () => ({
    navigate: (name: string, params?: unknown) => native.navigate.push({ name, params }),
    setOptions: () => undefined,
  }),
};
