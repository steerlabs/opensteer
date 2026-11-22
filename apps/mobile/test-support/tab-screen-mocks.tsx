import type { ReactNode } from "react";

/*
 * DOM stand-ins for the native pieces the tab and app screens draw, for
 * `vi.mock(path, () => import(...))`. They keep labels, disabled states and
 * presses, which is all these journeys read.
 */

type Children = { readonly children?: ReactNode };
type Pressing = Children & {
  readonly accessibilityLabel?: string;
  readonly accessibilityState?: { readonly disabled?: boolean; readonly selected?: boolean };
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly testID?: string;
};
type Listing<T> = {
  readonly data: readonly T[];
  readonly keyExtractor: (item: T) => string;
  readonly renderItem: (info: { readonly item: T; readonly index: number }) => ReactNode;
  readonly ListEmptyComponent?: ReactNode;
  readonly ListHeaderComponent?: ReactNode;
};

export const reactNative = {
  ActivityIndicator: () => <i role="progressbar" />,
  // The window as a phone at the default text size reports it.
  useWindowDimensions: () => ({ fontScale: 1, height: 844, scale: 3, width: 390 }),
  FlatList: <T,>(props: Listing<T>) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.length === 0
        ? props.ListEmptyComponent
        : props.data.map((item, index) => (
            <div key={props.keyExtractor(item)}>{props.renderItem({ index, item })}</div>
          ))}
    </div>
  ),
  Platform: { OS: "ios", Version: "18.0", select: (choices: { ios?: unknown }) => choices.ios },
  Pressable: (props: Pressing) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-selected={props.accessibilityState?.selected}
      data-testid={props.testID}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {typeof props.children === "function" ? null : props.children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: Children) => <div>{children}</div>,
};

const anything = new Proxy({}, { get: () => "#000" });
export const theme = {
  color: anything,
  radius: new Proxy({}, { get: () => 4 }),
  space: new Proxy({}, { get: () => 8 }),
  touchTarget: 44,
};

export const primitives = {
  AppText: ({ children }: Children) => <span>{children}</span>,
  Field: (props: {
    readonly label: string;
    readonly input: {
      readonly value?: string;
      readonly onChangeText?: (text: string) => void;
      readonly onSubmitEditing?: () => void;
    };
  }) => (
    <input
      aria-label={props.label}
      onChange={(event) => props.input.onChangeText?.(event.currentTarget.value)}
      value={props.input.value}
    />
  ),
  Notice: (props: {
    readonly action?: { readonly label: string; readonly onPress: () => void };
    readonly detail: string;
    readonly title: string;
  }) => (
    <div role="alert">
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
      {props.action ? <button onClick={props.action.onPress}>{props.action.label}</button> : null}
    </div>
  ),
  SecondaryButton: (props: {
    readonly accessibilityLabel?: string;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
};

interface MenuChoice {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: string;
  readonly onPress: () => void;
}
export const composerMenu = {
  NativeMenu: (props: {
    readonly accessibilityLabel: string;
    readonly disabledReason?: string | null;
    readonly options: readonly (MenuChoice | readonly MenuChoice[])[];
  }) => (
    <div aria-label={props.accessibilityLabel} data-menu>
      {props.options.flat().map((option) => (
        <button
          disabled={option.disabled === true || (props.disabledReason ?? null) !== null}
          key={option.id}
          onClick={option.onPress}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
};

type Line = { readonly text: string } | null;
/** An action's line as words a journey reads, in place of the subtitle it stands in for. */
export const actionLine = {
  ActionLine: (props: { readonly line: { readonly text: string } }) => (
    <p role="status">{props.line.text}</p>
  ),
  RowSubtitle: (props: { readonly line: Line; readonly subtitle: ReactNode }) =>
    props.line === null ? <span>{props.subtitle}</span> : <p role="status">{props.line.text}</p>,
};
/** The gate draws only that it is there; the content behind it waits for it to go. */
export const connectionGate = {
  Gated: (props: Children & { readonly gate: ReactNode }) => props.gate ?? props.children,
};
export const routeGate = {
  ConnectionRouteGate: () => <p data-gate="connection">Connection gate</p>,
};
export const placeholder = {
  PlaceholderRows: () => <p aria-label="Not loaded yet" />,
};
