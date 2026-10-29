import { Button, Host } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  dynamicTypeSize,
  frame,
  foregroundStyle,
  labelStyle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color, touchTarget } from "../theme.js";
import type { ComposerActionProps } from "./composer-action.types.js";

/** SwiftUI owns the hit region, SF Symbol, disabled state and pressed treatment. */
export function ComposerAction(props: ComposerActionProps): ReactNode {
  return (
    <Host
      colorScheme="dark"
      ignoreSafeArea="all"
      // Icon-only actions keep the same 44-point hit region as native toolbar
      // items. Message text and settings labels still follow Dynamic Type.
      modifiers={[dynamicTypeSize("large")]}
      style={{ width: touchTarget, height: touchTarget }}
    >
      <Button
        label={props.label}
        onPress={props.onPress}
        systemImage={props.kind === "send" ? "arrow.up" : "stop.fill"}
        modifiers={[
          labelStyle("iconOnly"),
          buttonStyle("borderedProminent"),
          buttonBorderShape("circle"),
          // Small draws the circle at composer scale — the bar is 44 points
          // tall and a regular-sized circle fills it edge to edge — while the
          // frame below keeps the region a finger lands on at the full 44.
          controlSize("small"),
          tint(props.kind === "send" ? color.ember : color.red),
          foregroundStyle(color.inkOnEmber),
          frame({ minWidth: touchTarget, minHeight: touchTarget }),
          disabled(props.disabled || props.busy),
          accessibilityLabel(props.label),
        ]}
      />
    </Host>
  );
}
