import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { AgentOrb } from "../team/team-marks.js";
import { TeamDrawerSection, type TeamDrawerActions } from "../team/drawer-section.js";
import type { TeamDrawerSectionView } from "../team/team-models.js";
import type { DrawerComputerView, DrawerTabView } from "./home-models.js";

export type DrawerPlace =
  | { readonly kind: "tasks" }
  | { readonly kind: "needs-you" }
  | { readonly kind: "voice" }
  | { readonly kind: "channel"; readonly id: string }
  | { readonly kind: "tab"; readonly id: string };

export interface DrawerActions extends TeamDrawerActions {
  readonly onTasks: () => void;
  readonly onNeedsYou: () => void;
  readonly onVoice: () => void;
  readonly onSearch: () => void;
  readonly onOpenTab: (tabId: string) => void;
  readonly onAllTabs: () => void;
  readonly onSettings: () => void;
}

/**
 * The phone's drawer: the reader's own places first (Tasks, Needs you,
 * Voice), then each team they're in, then a few tabs, and the computer this
 * Opensteer runs on. Folders live on Home, so the drawer stays short.
 *
 * Closed, it reads nothing; open, each row redraws only when its own counts do.
 */
export function DrawerBody(props: {
  readonly actions: DrawerActions;
  readonly computer: DrawerComputerView;
  readonly current: DrawerPlace;
  readonly needsYou: number;
  readonly tabs: readonly DrawerTabView[];
  readonly moreTabs: number;
  readonly teams: readonly TeamDrawerSectionView[];
  /** A Voice call is on. */
  readonly voiceOn: boolean;
}): ReactNode {
  const { actions, current } = props;
  const channelId = current.kind === "channel" ? current.id : null;
  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <AppText role="displaySmall" style={styles.brand}>
          Opensteer
        </AppText>
        <Pressable
          accessibilityLabel="Search"
          accessibilityRole="button"
          onPress={actions.onSearch}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Symbol name="magnifyingglass" size={18} tint={color.textSoft} weight="medium" />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Place
          label="Tasks"
          mark={<AgentOrb size={20} />}
          onPress={actions.onTasks}
          selected={current.kind === "tasks"}
        />
        <Place
          accessibilityLabel={props.needsYou > 0 ? `Needs you, ${props.needsYou}` : "Needs you"}
          icon="exclamationmark.circle"
          label="Needs you"
          onPress={actions.onNeedsYou}
          selected={current.kind === "needs-you"}
          trailing={props.needsYou > 0 ? <AmberCount count={props.needsYou} /> : null}
        />
        <Place
          icon="waveform"
          label="Voice"
          onPress={actions.onVoice}
          selected={current.kind === "voice"}
          trailing={props.voiceOn ? <StatusDot live tone="ember" /> : null}
        />
        {props.teams.map((section) => (
          <TeamDrawerSection
            actions={actions}
            currentId={channelId}
            key={section.team.id}
            section={section}
          />
        ))}
        {props.tabs.length === 0 ? null : (
          <View style={styles.tabs}>
            <AppText role="caption" style={styles.subhead} tone="muted">
              Tabs
            </AppText>
            {props.tabs.map((tab) => (
              <Place
                icon={
                  tab.kind === "browser"
                    ? "globe"
                    : tab.kind === "phone"
                      ? "smartphone"
                      : "square.grid.2x2"
                }
                key={tab.id}
                label={tab.title}
                onPress={() => actions.onOpenTab(tab.id)}
                quiet
                selected={current.kind === "tab" && current.id === tab.id}
              />
            ))}
            <Place
              icon="rectangle.on.rectangle"
              label={props.moreTabs > 0 ? `All tabs · ${props.moreTabs} more` : "All tabs"}
              onPress={actions.onAllTabs}
              quiet
              selected={false}
            />
          </View>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <View style={styles.computerMark}>
          <Symbol name="laptopcomputer" size={16} tint={color.textSoft} />
        </View>
        <View style={styles.computerWords}>
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            numberOfLines={1}
            role="secondaryMedium"
          >
            {props.computer.name}
          </AppText>
          <View style={styles.computerState}>
            <StatusDot
              live={props.computer.state === "connecting"}
              size={6}
              tone={
                props.computer.state === "connected"
                  ? "green"
                  : props.computer.state === "connecting"
                    ? "amber"
                    : "muted"
              }
            />
            <AppText role="caption" tone="muted">
              {props.computer.state === "connected"
                ? "Connected"
                : props.computer.state === "connecting"
                  ? "Connecting…"
                  : "Offline"}
            </AppText>
          </View>
        </View>
        <Pressable
          accessibilityLabel="Settings"
          accessibilityRole="button"
          onPress={actions.onSettings}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Symbol name="gearshape" size={19} tint={color.muted} />
        </Pressable>
      </View>
    </View>
  );
}

function Place(props: {
  readonly accessibilityLabel?: string;
  readonly icon?: SFSymbolName;
  readonly label: string;
  readonly mark?: ReactNode;
  readonly onPress: () => void;
  readonly quiet?: boolean;
  readonly selected: boolean;
  readonly trailing?: ReactNode;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.place,
        props.selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.mark}>
        {props.mark ?? <Symbol name={props.icon ?? "circle"} size={17} tint={color.muted} />}
      </View>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="secondary"
        style={[
          styles.label,
          props.selected ? styles.labelSelected : props.quiet ? styles.labelQuiet : null,
        ]}
      >
        {props.label}
      </AppText>
      {props.trailing ?? null}
    </Pressable>
  );
}

/** Questions waiting on the reader: the one amber count in the drawer. */
function AmberCount(props: { readonly count: number }): ReactNode {
  return (
    <View style={styles.amber}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.amberText}
      >
        {props.count}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  amber: {
    alignItems: "center",
    backgroundColor: color.amber,
    borderRadius: radius.full,
    minWidth: 20,
    paddingHorizontal: space[6],
  },
  amberText: { color: color.inkOnAmber, fontVariant: ["tabular-nums"], fontWeight: "700" },
  brand: { color: color.text, flex: 1, fontWeight: "700" },
  computerMark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  computerState: { alignItems: "center", flexDirection: "row", gap: space[6] },
  computerWords: { flex: 1, minWidth: 0 },
  content: { paddingBottom: space[16], paddingHorizontal: space[8] },
  footer: {
    alignItems: "center",
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[10],
    paddingBottom: space[24],
    paddingLeft: space[16],
    paddingRight: space[8],
    paddingTop: space[8],
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: touchTarget,
    paddingBottom: space[4],
    paddingLeft: space[20],
    paddingRight: space[8],
  },
  iconButton: {
    alignItems: "center",
    borderRadius: radius.full,
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  label: { color: color.textSoft, flex: 1 },
  labelQuiet: { color: color.muted },
  labelSelected: { color: color.text, fontWeight: "600" },
  mark: { alignItems: "center", width: 28 },
  panel: { backgroundColor: color.surfaceElevated, flex: 1 },
  place: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: space[10],
    minHeight: Platform.OS === "android" ? 48 : touchTarget,
    paddingHorizontal: space[10] - 1,
    paddingRight: space[12],
  },
  pressed: { ...material.quiet },
  selected: { ...material.selected },
  subhead: { paddingBottom: space[2], paddingLeft: space[10], paddingTop: space[10] },
  tabs: {
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space[12],
    paddingTop: space[4],
  },
});
