import {
  Button,
  ContentUnavailableView,
  HStack,
  Host,
  Image,
  List,
  Section,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHint,
  accessibilityHidden,
  accessibilityLabel,
  background,
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  listStyle,
  monospacedDigit,
  opacity,
  refreshable,
  shapes,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { View } from "react-native";
import { color } from "../theme.js";
import {
  sectionNote,
  type AutomationListProps,
  type AutomationRowLook,
  type AutomationRowModel,
} from "./automation-row.js";

// A Button tints its label, so a row names its colours rather than taking hierarchical ones.
const secondary = foregroundStyle(color.muted);
const footnote = font({ textStyle: "footnote" });
const tileSize = 30;
const tileShape = shapes.roundedRectangle({ cornerRadius: 7, roundedCornerStyle: "continuous" });

const tileFill: Record<AutomationRowLook, string> = {
  attention: color.redWash,
  once: color.emberWash,
  paused: color.surfaceRaised,
  plain: color.surfaceRaised,
  system: color.surfaceRaised,
};

const tileTint: Record<AutomationRowLook, string> = {
  attention: color.red,
  once: color.ember,
  paused: color.textSoft,
  plain: color.textSoft,
  system: color.muted,
};

/**
 * Automations as iOS draws a list: SwiftUI's inset grouped List, with section
 * headers and footers, Dynamic Type, the system's pull to refresh and its
 * empty-state view. Android draws `automation-list.tsx`.
 */
export function AutomationList(props: AutomationListProps): ReactNode {
  const last = props.sections.length - 1;
  return (
    <View style={{ flex: 1 }}>
      {props.banner}
      <Host style={{ flex: 1 }} useViewportSizeMeasurement>
        {props.sections.length === 0 ? (
          <ContentUnavailableView
            description="Ask in Chat for something to happen on its own — “every weekday at 8, sum up my email” — and it shows up here."
            systemImage="clock"
            title="No automations yet"
          />
        ) : (
          <List modifiers={[listStyle("insetGrouped"), refreshable(props.onRefresh)]}>
            {props.sections.map((section, index) => {
              const note = [
                sectionNote(section.id),
                index === last && props.capped ? "Showing the first 100 automations." : null,
              ]
                .filter((line) => line !== null)
                .join("\n");
              return (
                <Section
                  footer={
                    note === "" ? undefined : <Text modifiers={[footnote, secondary]}>{note}</Text>
                  }
                  header={
                    <Text
                      modifiers={[
                        accessibilityLabel(`${section.title}, ${section.rows.length}`),
                        ...(section.id === "attention" ? [foregroundStyle(color.red)] : []),
                      ]}
                    >
                      {section.title}
                    </Text>
                  }
                  key={section.id}
                >
                  {section.rows.map((row) => (
                    <AutomationRow key={row.id} onOpen={props.onOpen} row={row} />
                  ))}
                </Section>
              );
            })}
          </List>
        )}
      </Host>
    </View>
  );
}

function AutomationRow(props: {
  readonly onOpen: (triggerId: string) => void;
  readonly row: AutomationRowModel;
}): ReactNode {
  const { row } = props;
  const faded = row.look === "paused" ? [opacity(0.55)] : [];
  const detail =
    row.problem ??
    [row.cadence, row.where].filter((part): part is string => part !== null).join(" · ");
  return (
    <Button
      modifiers={[
        accessibilityLabel(row.accessibilityLabel),
        accessibilityHint("Opens this automation"),
      ]}
      onPress={() => props.onOpen(row.id)}
    >
      <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
        <Image
          color={tileTint[row.look]}
          modifiers={[
            accessibilityHidden(true),
            frame({ height: tileSize, width: tileSize }),
            background(tileFill[row.look], tileShape),
            ...faded,
          ]}
          size={15}
          systemName={row.symbol}
        />
        <VStack alignment="leading" modifiers={faded} spacing={2}>
          <Text
            modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text), lineLimit(2)]}
          >
            {row.name}
          </Text>
          <Text
            modifiers={[
              footnote,
              row.problem === null ? secondary : foregroundStyle(color.red),
              lineLimit(2),
            ]}
          >
            {detail}
          </Text>
          {row.runNote === null ? null : (
            <Text
              modifiers={[
                footnote,
                foregroundStyle(row.runNote.tone === "bad" ? color.red : color.amber),
                lineLimit(1),
              ]}
            >
              {row.runNote.text}
            </Text>
          )}
        </VStack>
        <Spacer />
        <Trailing row={row} />
        <Image
          color={color.mutedDim}
          modifiers={[accessibilityHidden(true)]}
          size={13}
          systemName="chevron.right"
        />
      </HStack>
    </Button>
  );
}

function Trailing(props: { readonly row: AutomationRowModel }): ReactNode {
  const trailing = props.row.trailing;
  if (trailing === null) return null;
  if (trailing.kind === "state") {
    return (
      <Text
        modifiers={[
          font({ textStyle: "subheadline", weight: "medium" }),
          trailing.tone === "accent" ? foregroundStyle(color.ember) : secondary,
        ]}
      >
        {trailing.text}
      </Text>
    );
  }
  return (
    <VStack alignment="trailing" spacing={1}>
      <Text
        modifiers={[
          font({ textStyle: "subheadline", weight: "medium" }),
          monospacedDigit(),
          foregroundStyle(trailing.soon ? color.ember : color.text),
        ]}
      >
        {trailing.day}
      </Text>
      <Text modifiers={[footnote, monospacedDigit(), secondary]}>{trailing.time}</Text>
    </VStack>
  );
}
