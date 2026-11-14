import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { color } from "../theme.js";

export type HeaderActionSpec = {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel?: string;
  /** A count drawn on the item; the accessibility label must say it too. */
  readonly badge?: string;
  readonly disabled?: boolean;
  readonly icon?:
    | "arrow.up"
    | "checklist"
    | "clock"
    | "gearshape"
    | "globe"
    | "laptopcomputer"
    | "line.3.horizontal"
    | "plus"
    | "rectangle.on.rectangle"
    | "smartphone"
    | "square.and.pencil"
    | "square.grid.2x2"
    | "xmark";
  readonly label: string;
  readonly onPress: () => void;
  readonly tintColor?: string;
  readonly variant?: "done" | "plain" | "prominent";
};

/** A bar control as iOS draws it: UIKit owns its appearance and accessibility. */
export function nativeHeaderItem(action: HeaderActionSpec): NativeStackHeaderItem {
  return {
    ...(action.accessibilityHint === undefined
      ? {}
      : { accessibilityHint: action.accessibilityHint }),
    accessibilityLabel: action.accessibilityLabel ?? action.label,
    ...(action.badge === undefined
      ? {}
      : {
          badge: {
            style: {
              backgroundColor: action.tintColor ?? color.amber,
              color:
                action.tintColor === undefined || action.tintColor === color.amber
                  ? color.inkOnAmber
                  : color.surfaceElevated,
              fontWeight: "700",
            },
            value: action.badge,
          },
        }),
    ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
    ...(action.icon === undefined
      ? {}
      : { icon: { name: action.icon, type: "sfSymbol" as const } }),
    label: action.label,
    onPress: action.onPress,
    ...(action.tintColor === undefined ? {} : { tintColor: action.tintColor }),
    type: "button",
    variant: action.variant ?? "plain",
  };
}
