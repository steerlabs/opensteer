import type { ReactNode } from "react";

/*
 * The native chrome a place's bar is built from, as the DOM tests see it: a
 * glass control is the element inside it, a toolbar button is a button named
 * by its label, and a menu lists its choices as buttons. Animation and gesture
 * modules answer at once, so what a test sees is the end state.
 */

type Children = { readonly children?: ReactNode };

interface MenuChoice {
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly selected?: boolean;
}

export const glass = {
  GlassSurface: (props: Children) => <div>{props.children}</div>,
  useLiquidGlass: () => false,
};

export const toolbar = {
  Toolbar: (props: Children & { readonly testID?: string }) => (
    <div data-testid={props.testID}>{props.children}</div>
  ),
  ToolbarButton: (props: {
    readonly count?: number;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onPress: () => void;
  }) => (
    <button aria-label={props.label} disabled={props.disabled} onClick={props.onPress}>
      {props.count}
    </button>
  ),
  ToolbarCapsule: (props: Children) => <div>{props.children}</div>,
  ToolbarMenu: (props: {
    readonly label: string;
    readonly sections: readonly (readonly MenuChoice[])[];
    readonly title?: string;
  }) => (
    <div aria-label={props.label} data-menu-title={props.title}>
      {props.sections.flat().map((choice) => (
        <button
          aria-pressed={choice.selected}
          disabled={choice.disabled}
          key={choice.id}
          onClick={choice.onPress}
        >
          {choice.label}
        </button>
      ))}
    </div>
  ),
};

export const gestureHandler = {
  GestureDetector: (props: Children) => <>{props.children}</>,
  usePanGesture: () => ({}),
};

export const worklets = {
  scheduleOnRN: <A extends unknown[]>(run: (...args: A) => void, ...args: A) => run(...args),
};

const transition = { duration: () => transition };

export const reanimated = {
  default: {
    View: (props: Children & { readonly testID?: string }) => (
      <div data-testid={props.testID}>{props.children}</div>
    ),
  },
  cancelAnimation: () => undefined,
  Easing: { inOut: () => () => 0, quad: () => 0 },
  FadeIn: transition,
  FadeInDown: transition,
  FadeOut: transition,
  LinearTransition: transition,
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: <T,>(value: T) => ({ value }),
  withRepeat: <T,>(value: T) => value,
  withSpring: <T,>(value: T) => value,
  withTiming: <T,>(value: T) => value,
};
