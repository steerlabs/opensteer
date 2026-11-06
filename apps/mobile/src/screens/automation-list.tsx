import { memo, useCallback, useState, type ReactNode } from "react";
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
  type SectionListRenderItemInfo,
  type ViewStyle,
} from "react-native";
import { color, controlFontScaleLimit, radius, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import {
  sectionNote,
  type AutomationListProps,
  type AutomationRowLook,
  type AutomationRowModel,
} from "./automation-row.js";
import { AnchorMark, ScheduleGroupHead } from "./automation-parts.js";

type ListSection = AutomationListProps["sections"][number] & {
  readonly data: readonly AutomationRowModel[];
};

/**
 * Automations as Android draws a list: grouped cards with a leading tile,
 * a two-line item and a ripple, under a native pull to refresh. iOS draws
 * its own SwiftUI list (`automation-list.ios.tsx`).
 */
export function AutomationList(props: AutomationListProps): ReactNode {
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const [refreshing, setRefreshing] = useState(false);
  const { onOpen, onRefresh } = props;
  const pull = useCallback(() => {
    setRefreshing(true);
    void onRefresh().finally(() => setRefreshing(false));
  }, [onRefresh]);
  const sections: readonly ListSection[] = props.sections.map((section) => ({
    ...section,
    data: section.rows,
  }));
  const renderItem = useCallback(
    ({ index, item, section }: SectionListRenderItemInfo<AutomationRowModel, ListSection>) => (
      <AutomationRow
        first={index === 0}
        last={index === section.data.length - 1}
        onOpen={onOpen}
        quiet={section.id === "system"}
        row={item}
      />
    ),
    [onOpen],
  );
  return (
    <Screen edgeToEdge>
      <SectionList<AutomationRowModel, ListSection>
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyExtractor={(row) => row.id}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyTile}>
              <Symbol name="clock" size={26} tint={color.textSoft} />
            </View>
            <AppText role="title">No automations yet</AppText>
            <AppText role="secondary" style={styles.centred} tone="muted">
              Ask in Chat for something to happen on its own — “every weekday at 8, sum up my email”
              — and it shows up here.
            </AppText>
          </View>
        }
        ListFooterComponent={
          props.capped ? (
            <AppText role="caption" style={styles.footnote} tone="muted">
              Showing the first 100 automations.
            </AppText>
          ) : undefined
        }
        ListHeaderComponent={props.banner === null ? undefined : <>{props.banner}</>}
        refreshControl={
          <RefreshControl
            colors={[color.ember]}
            onRefresh={pull}
            progressBackgroundColor={color.surfaceElevated}
            refreshing={refreshing}
            tintColor={color.muted}
          />
        }
        renderItem={renderItem}
        renderSectionFooter={({ section }) => {
          const note = sectionNote(section.id);
          return note === null ? null : (
            <AppText role="caption" style={styles.note} tone="muted">
              {note}
            </AppText>
          );
        }}
        renderSectionHeader={({ section }) => (
          <ScheduleGroupHead
            attention={section.id === "attention"}
            count={section.data.length}
            title={section.title}
          />
        )}
        sections={sections}
        stickySectionHeadersEnabled={false}
      />
    </Screen>
  );
}

const AutomationRow = memo(function AutomationRow(props: {
  readonly first: boolean;
  readonly last: boolean;
  readonly onOpen: (triggerId: string) => void;
  readonly quiet: boolean;
  readonly row: AutomationRowModel;
}): ReactNode {
  const { row } = props;
  const faded = row.look === "paused";
  return (
    <Pressable
      accessibilityHint="Opens this automation"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityRole="button"
      android_ripple={{ color: color.surfacePressed, foreground: true }}
      onPress={() => props.onOpen(row.id)}
      style={[
        styles.row,
        props.quiet && styles.rowQuiet,
        props.first && styles.rowFirst,
        props.last && styles.rowLast,
      ]}
    >
      <View style={[styles.tile, tile[row.look], faded && styles.faded]}>
        <Symbol name={row.symbol} size={20} tint={tileTint[row.look]} />
      </View>
      <View style={[styles.words, faded && styles.faded]}>
        <AppText numberOfLines={2} role="bodyMedium" style={styles.name}>
          {row.name}
        </AppText>
        {row.problem === null ? (
          <View style={styles.line}>
            <AppText numberOfLines={1} role="secondary" style={styles.detail} tone="muted">
              {row.cadence}
            </AppText>
            {row.where === null ? null : (
              <>
                <AppText role="secondary" style={styles.detail} tone="muted">
                  ·
                </AppText>
                <AnchorMark anchor={row.item.anchor} size={16} />
                <AppText numberOfLines={1} role="secondary" style={styles.anchor} tone="soft">
                  {row.where}
                </AppText>
              </>
            )}
          </View>
        ) : (
          <AppText numberOfLines={2} role="secondary" style={[styles.detail, styles.problem]}>
            {row.problem}
          </AppText>
        )}
        {row.runNote === null ? null : (
          <AppText
            numberOfLines={1}
            role="secondary"
            style={[styles.detail, row.runNote.tone === "bad" ? styles.problem : styles.warn]}
          >
            {row.runNote.text}
          </AppText>
        )}
      </View>
      <Trailing row={row} />
      {props.last ? null : <View style={styles.divider} />}
    </Pressable>
  );
});

function Trailing(props: { readonly row: AutomationRowModel }): ReactNode {
  const trailing = props.row.trailing;
  if (trailing === null) return null;
  if (trailing.kind === "state") {
    return (
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="secondaryMedium"
        style={[styles.day, trailing.tone === "accent" ? styles.accent : styles.mutedWord]}
      >
        {trailing.text}
      </AppText>
    );
  }
  return (
    <View style={styles.when}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="secondaryMedium"
        style={[styles.day, trailing.soon && styles.accent]}
      >
        {trailing.day}
      </AppText>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.time}
        tone="muted"
      >
        {trailing.time}
      </AppText>
    </View>
  );
}

const tileSize = 40;
const rowGap = space[16];

const tile = StyleSheet.create({
  attention: { backgroundColor: color.redWash, borderColor: color.redLine },
  once: { backgroundColor: color.emberWash, borderColor: color.emberLine },
  paused: {},
  plain: {},
  system: { backgroundColor: "transparent", borderColor: color.lineStrong, borderStyle: "dashed" },
} satisfies Record<AutomationRowLook, ViewStyle>);

const tileTint: Record<AutomationRowLook, string> = {
  attention: color.red,
  once: color.ember,
  paused: color.textSoft,
  plain: color.textSoft,
  system: color.muted,
};

const styles = StyleSheet.create({
  accent: { color: color.ember },
  anchor: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  centred: { textAlign: "center" },
  content: { paddingTop: space[4] },
  day: { fontSize: 14, fontVariant: ["tabular-nums"], lineHeight: 20 },
  detail: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  // Material's inset divider: it starts where the words do.
  divider: {
    backgroundColor: color.line,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    left: space[16] + tileSize + rowGap,
    position: "absolute",
    right: 0,
  },
  empty: {
    alignItems: "center",
    gap: space[10],
    paddingHorizontal: space[24],
    paddingVertical: space[48],
  },
  emptyTile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.lg,
    height: 56,
    justifyContent: "center",
    marginBottom: space[4],
    width: 56,
  },
  faded: { opacity: 0.55 },
  footnote: { paddingHorizontal: space[4], paddingTop: space[16] },
  line: { alignItems: "center", flexDirection: "row", gap: space[6], minWidth: 0 },
  mutedWord: { color: color.muted },
  name: { fontSize: 16, lineHeight: 22 },
  note: { paddingHorizontal: space[4], paddingTop: space[8] },
  problem: { color: color.red },
  row: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    flexDirection: "row",
    gap: rowGap,
    minHeight: 72,
    overflow: "hidden",
    paddingHorizontal: space[16],
    paddingVertical: space[12],
  },
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowQuiet: { backgroundColor: color.surface },
  tile: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    height: tileSize,
    justifyContent: "center",
    width: tileSize,
  },
  time: { fontVariant: ["tabular-nums"], textAlign: "right" },
  warn: { color: color.amber },
  when: { alignItems: "flex-end", gap: space[2] },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
