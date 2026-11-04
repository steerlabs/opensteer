import { Button, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityLabel,
  background,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color, deploymentPaint } from "../theme.js";
import type { DeploymentMark } from "../threads/deployment-identity.js";
import type { SFSymbolName } from "../ui/symbol.js";
import { type SettingsActionModel } from "./settings-model.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const footnote = font({ textStyle: "footnote" });
const error = foregroundStyle(color.red);
const markSize = 30;
const tileShape = shapes.roundedRectangle({ cornerRadius: 7, roundedCornerStyle: "continuous" });

/** A name and the line under it, the shape every row in Settings shares. */
export function Lines(props: {
  readonly detail: string | null;
  readonly title: string;
}): ReactNode {
  return (
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
        {props.title}
      </Text>
      {props.detail === null ? null : <Text modifiers={[secondary, footnote]}>{props.detail}</Text>}
    </VStack>
  );
}

/** A row's glyph on a quiet tile, so the list is scanned by shape before it is read. */
export function Tile(props: { readonly symbol: SFSymbolName }): ReactNode {
  return (
    <Image
      color={color.textSoft}
      modifiers={[
        accessibilityHidden(true),
        frame({ height: markSize, width: markSize }),
        background(color.surfaceRaised, tileShape),
      ]}
      size={15}
      systemName={props.symbol}
    />
  );
}

/**
 * Whose phone this is and where it is pointed, as a face: the deployment's
 * coloured mark, the person's round initial.
 */
export function IdentityMark(props: {
  /** An account is a person, and a person's avatar is round. */
  readonly circular?: boolean;
  readonly initial?: string | null;
  readonly mark?: DeploymentMark | null;
}): ReactNode {
  const mark = props.mark ?? null;
  const initial = mark?.initial ?? props.initial ?? null;
  if (initial === null) return null;
  const palette = mark === null ? null : deploymentPaint[mark.tone];
  return (
    <Text
      modifiers={[
        font({ size: 13, weight: "bold" }),
        foregroundStyle(palette?.ink ?? color.textSoft),
        frame({ height: markSize, width: markSize }),
        background(
          palette?.fill ?? color.surfaceRaised,
          props.circular === true ? shapes.circle() : tileShape,
        ),
        // The name is on the line beside it, so a mark announced as a
        // letter would be that name's first letter read out twice.
        accessibilityHidden(true),
      ]}
    >
      {initial}
    </Text>
  );
}

/** A row that opens a page or sheet about one thing. */
export function LinkRow(props: {
  readonly detail: string;
  readonly onPress: () => void;
  readonly symbol: SFSymbolName;
  readonly title: string;
}): ReactNode {
  return (
    <Button
      modifiers={[accessibilityLabel(`${props.title}, ${props.detail}`)]}
      onPress={props.onPress}
    >
      <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
        <Tile symbol={props.symbol} />
        <Lines detail={props.detail} title={props.title} />
        <Spacer />
        <Chevron />
      </HStack>
    </Button>
  );
}

export function Chevron(): ReactNode {
  return (
    <Image
      color={color.muted}
      modifiers={[accessibilityHidden(true)]}
      size={13}
      systemName="chevron.right"
    />
  );
}

export function Footer(props: { readonly text: string }): ReactNode {
  return <Text modifiers={[secondary, footnote]}>{props.text}</Text>;
}

export function ActionButton(props: {
  readonly action: SettingsActionModel | null;
  readonly onPress: () => void;
}): ReactNode {
  const action = props.action;
  return action === null ? null : (
    <Button
      label={action.label}
      modifiers={[disabled(action.disabled)]}
      onPress={props.onPress}
      role={action.destructive === true ? "destructive" : "default"}
    />
  );
}

export function ErrorText(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <Text
      modifiers={[
        footnote,
        error,
        accessibilityLabel(`Error: ${props.detail}`),
        accessibilityAddTraits(["isSummaryElement"]),
      ]}
    >
      {props.detail}
    </Text>
  );
}
