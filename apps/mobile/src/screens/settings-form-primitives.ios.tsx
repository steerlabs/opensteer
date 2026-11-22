import { Button, Capsule, HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityLabel,
  background,
  buttonStyle,
  contentShape,
  disabled,
  font,
  foregroundStyle,
  frame,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { color, deploymentPaint } from "../theme.js";
import { addressWords, isAddress } from "../ui/address-words.js";
import { plainSentence, type SentencePart } from "../ui/sentence-parts.js";
import type { DeploymentMark } from "../threads/deployment-identity.js";
import type { SFSymbolName } from "../ui/symbol.js";
import type { NativeSettingsFooter } from "./native-settings-page.types.js";
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
  readonly detailColor?: string;
  /**
   * Which line is an email address, a host or a URL (`isAddress`): drawn as one (`address-text.tsx`),
   * whole and wrapping only at its joints, and read aloud as it is.
   */
  readonly addressIn?: "title" | "detail" | undefined;
  /** The title as a sentence holding addresses among its words: each drawn as one. */
  readonly titleParts?: readonly SentencePart[] | undefined;
}): ReactNode {
  const words = (value: string, place: "title" | "detail") =>
    props.addressIn === place
      ? { modifiers: [accessibilityLabel(value)], text: addressWords(value) }
      : { modifiers: [], text: value };
  const title = props.titleParts
    ? {
        modifiers: [accessibilityLabel(plainSentence(props.titleParts))],
        text: drawnSentence(props.titleParts),
      }
    : words(props.title, "title");
  const detail = props.detail === null ? null : words(props.detail, "detail");
  return (
    <VStack alignment="leading" spacing={2}>
      <Text
        modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text), ...title.modifiers]}
      >
        {title.text}
      </Text>
      {/* Inside a Button, hierarchical secondary would take the button's tint. */}
      {detail === null ? null : (
        <Text
          modifiers={[
            foregroundStyle(props.detailColor ?? color.muted),
            footnote,
            ...detail.modifiers,
          ]}
        >
          {detail.text}
        </Text>
      )}
    </VStack>
  );
}

/** A sentence as drawn: its words as words, each address in the characters that keep it whole. */
export function drawnSentence(parts: readonly SentencePart[]): string {
  return parts
    .map((part) =>
      typeof part === "string"
        ? part
        : isAddress(part.address)
          ? addressWords(part.address)
          : part.address,
    )
    .join("");
}

/** A row's `addressIn` as `Lines` names its lines. */
export function linesAddress(addressIn: "label" | "detail" | undefined): {
  readonly addressIn?: "title" | "detail";
} {
  return addressIn === undefined ? {} : { addressIn: addressIn === "label" ? "title" : "detail" };
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

/** A row that opens a page, drawn as iOS Settings draws one: its name and a chevron. */
export function NavRow(props: { readonly onPress: () => void; readonly title: string }): ReactNode {
  return (
    <Button modifiers={[accessibilityLabel(props.title)]} onPress={props.onPress}>
      <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
        <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
          {props.title}
        </Text>
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

/** Two still bars in a row's shape: never a shimmer, which reads as loading forever. */
export function PlaceholderRow({ label }: { readonly label: string }) {
  return (
    <VStack
      alignment="leading"
      spacing={8}
      modifiers={[accessibilityLabel(label), frame({ maxWidth: Infinity, alignment: "leading" })]}
    >
      <Capsule
        modifiers={[foregroundStyle(color.surfaceRaised), frame({ width: 160, height: 10 })]}
      />
      <Capsule
        modifiers={[foregroundStyle(color.surfaceRaised), frame({ width: 96, height: 10 })]}
      />
    </VStack>
  );
}

/** A section's last line, with its one link, such as Try again or Check. */
export function LineFooter({ footer }: { readonly footer: NativeSettingsFooter }): ReactNode {
  const link = footer.link ?? null;
  const text = (
    <Text
      modifiers={[
        footnote,
        footer.tone === "danger"
          ? foregroundStyle(color.red)
          : foregroundStyle({ type: "hierarchical", style: "secondary" }),
      ]}
    >
      {footer.text}
    </Text>
  );
  if (link === null) return text;
  return (
    <HStack alignment="firstTextBaseline" spacing={6}>
      {text}
      <Button onPress={link.onPress} modifiers={[buttonStyle("plain")]}>
        <Text
          modifiers={[
            font({ textStyle: "footnote", weight: "semibold" }),
            foregroundStyle(color.ember),
          ]}
        >
          {link.label}
        </Text>
      </Button>
    </HStack>
  );
}
