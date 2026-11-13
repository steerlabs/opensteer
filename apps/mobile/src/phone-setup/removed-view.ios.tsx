import { Button, ContentUnavailableView, Host, Text, VStack } from "@expo/ui/swift-ui";
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  padding,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color } from "../theme.js";
import type { RemovedViewProps } from "./removed-copy.js";

/** The Host removed this phone: iOS's own empty state, then the two ways on. */
export function RemovedView(props: RemovedViewProps): ReactNode {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <VStack modifiers={[padding({ horizontal: 20, bottom: 24 })]} spacing={12}>
        <ContentUnavailableView
          description={props.body}
          systemImage="iphone.slash"
          title={props.title}
        />
        <Button
          modifiers={[
            buttonStyle("borderedProminent"),
            buttonBorderShape("capsule"),
            controlSize("large"),
            tint(color.ember),
          ]}
          onPress={props.onSetUpAgain}
        >
          <Text
            modifiers={[
              font({ textStyle: "headline" }),
              foregroundStyle(color.inkOnEmber),
              frame({ maxWidth: Infinity }),
            ]}
          >
            Set up again
          </Text>
        </Button>
        <Button
          modifiers={[controlSize("large"), tint(color.ember), frame({ minHeight: 44 })]}
          onPress={props.onNotNow}
        >
          <Text modifiers={[frame({ maxWidth: Infinity })]}>Not now</Text>
        </Button>
      </VStack>
    </Host>
  );
}
