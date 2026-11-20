import {
  chromeTabUsedBy,
  browserTabPicture,
  tabGroupOf,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
  type TabStripEntry,
} from "@opensteer/client/host";
import {
  useHostSelector,
  usePlace,
  usePlaceAgents,
  useTabLayout,
  useTabStrip,
} from "@opensteer/client/react";
import {
  TabGroupColorSchema,
  type TabGroup,
  type TabGroupColor,
  type TabId,
} from "@opensteer/core";
import type { TabOrganizeInput } from "@opensteer/protocol";
import { memo, useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { ActingDot } from "../browser/acting-dot.js";
import { AgentMarks } from "../browser/agent-marks.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { NeedsYouTag } from "../threads/task-row.js";
import { RowSubtitle } from "../ui/action-line.js";
import { screenAction, useScreenAction } from "../ui/client-feedback.js";
import { AppText, Field, SecondaryButton } from "../ui/primitives.js";
import { closeTabs, tabActionKey, tabActionSpecs, type TabActionKind } from "./tab-actions.js";
import { Symbol } from "../ui/symbol.js";
import { MacAppIcon } from "../computers/app-mark.js";
import { TabPicture } from "../screens/tab-picture.js";
import {
  moveBefore,
  moveGroupBefore,
  tabDetail,
  tabKindGlyph,
  tabKindNoun,
  tabTitle,
} from "./tab-entries.js";
import { useTabListSpans } from "./use-tabs.js";

/** Chrome's group tints, as the web draws them. */
export const tabGroupTint: Record<TabGroupColor, string> = {
  blue: "#8ab4f8",
  cyan: "#78d9ec",
  green: "#81c995",
  grey: "#9aa0a6",
  orange: "#fcad70",
  pink: "#ff8bcb",
  purple: "#c58af9",
  red: "#f28b82",
  yellow: "#fdd663",
};

/** What is being moved, while the person picks where it goes. */
type Moving =
  | { readonly kind: "tab"; readonly tabId: TabId; readonly title: string }
  | { readonly kind: "group"; readonly group: TabGroup };

/** A name being typed: a group's new name, or a new group for one tab. */
type Naming =
  | { readonly kind: "rename"; readonly groupId: TabGroup["groupId"] }
  | { readonly kind: "new-group"; readonly tabId: TabId };

/** One line of the list: a group's head, or a tab with the group it sits in. */
type TabEntry =
  | { readonly kind: "group"; readonly group: TabGroup }
  | { readonly kind: "tab"; readonly tabId: TabId; readonly group: TabGroup | null };

export interface TabListProps {
  readonly hostClient: HostClient;
  /** The tabs a filter keeps (`useTabFilterMatches`); groups with none kept are left out. Null keeps all. */
  readonly matches?: ReadonlySet<string> | null;
  /** The list is on screen: a row shows a picture this phone already holds, and never asks for one. */
  readonly shown?: boolean;
  readonly header?: ReactElement | null;
  readonly empty?: ReactElement | null;
  readonly onOpen: (tabId: TabId) => void;
  /** The tab this device is showing, marked as selected. */
  readonly selectedTabId?: TabId | null;
  readonly contentStyle?: object;
}

/**
 * The one tab list: every page, Mac window, phone and app in the Host's one
 * layout, groups with any kind inside. Touch has no drag, so each row and each
 * group head has a menu: Move (then tap where it goes), group, ungroup, close.
 * No kind is set apart or left out; a tab that cannot open says why.
 */
export function TabList(props: TabListProps): ReactNode {
  const { hostClient } = props;
  const client = hostClient;
  const strip = useTabStrip(hostClient);
  const layout = useTabLayout(hostClient);
  const spans = useTabListSpans(hostClient);
  const signIns = useHostSelector(hostClient, selectSignIns);
  // Each tab's and group's own action: the row says how it went, after the menu is gone.
  const act = useCallback(
    (kind: TabActionKind, id: string, work: () => Promise<unknown>) =>
      void screenAction(client, tabActionKey(kind, id), tabActionSpecs[kind]).run(work),
    [client],
  );
  const [moving, setMoving] = useState<Moving | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const matches = props.matches ?? null;
  const entries = useMemo(() => listEntries(strip.entries, matches), [strip, matches]);
  const groups = useMemo(
    () => strip.entries.flatMap((entry) => (entry.kind === "group" ? [entry.group] : [])),
    [strip],
  );
  const signInSet = useMemo(() => new Set(signIns.split("\n")), [signIns]);

  const organize = useCallback(
    (input: TabOrganizeInput | null, groupId?: string) => {
      setMoving(null);
      if (input === null) return;
      const work = () => client.organizeTabs(input);
      const tabId = input.tabIds[0];
      if (groupId !== undefined) act("changeGroup", groupId, work);
      else if (tabId !== undefined) act("move", tabId, work);
    },
    [act, client],
  );
  const placeBefore = useCallback(
    (anchorId: TabId) => {
      if (moving === null) return;
      if (moving.kind === "tab") {
        if (moving.tabId !== anchorId) organize(moveBefore(layout, moving.tabId, anchorId));
        return;
      }
      organize(moveGroupBefore(moving.group, anchorId), moving.group.groupId);
    },
    [layout, moving, organize],
  );
  const tabActions = useCallback(
    (place: PlaceItem): readonly (readonly NativeMenuOption[])[] => {
      const tab = place.tab;
      const current = tabGroupOf(layout, tab.tabId);
      return [
        [
          {
            icon: "arrow.up.left.and.arrow.down.right",
            id: "move",
            label: "Move…",
            onPress: () => setMoving({ kind: "tab", tabId: tab.tabId, title: tabTitle(tab) }),
          },
        ],
        [
          ...groups
            .filter((group) => group.groupId !== current?.groupId)
            .map((group): NativeMenuOption => ({
              id: `group:${group.groupId}`,
              label: `Move to ${group.name}`,
              onPress: () => organize({ group: { groupId: group.groupId }, tabIds: [tab.tabId] }),
            })),
          {
            icon: "plus.square.on.square",
            id: "new-group",
            label: "New group",
            onPress: () => setNaming({ kind: "new-group", tabId: tab.tabId }),
          },
          ...(current === null
            ? []
            : [
                {
                  id: "ungroup",
                  label: "Remove from group",
                  onPress: () => organize({ group: null, tabIds: [tab.tabId] }),
                },
              ]),
        ],
        [
          {
            destructive: true,
            icon: "xmark.circle",
            id: "close",
            label: "Close tab",
            onPress: () => act("close", tab.tabId, () => closeTabs(client, [tab.tabId])),
          },
        ],
      ];
    },
    [act, client, groups, layout, organize],
  );
  const groupActions = useCallback(
    (group: TabGroup): readonly (readonly NativeMenuOption[])[] => [
      [
        {
          icon: "pencil",
          id: "rename",
          label: "Rename",
          onPress: () => setNaming({ groupId: group.groupId, kind: "rename" }),
        },
        ...(group.tabIds.length === 0
          ? []
          : [
              {
                icon: "arrow.up.left.and.arrow.down.right" as const,
                id: "move",
                label: "Move group…",
                onPress: () => setMoving({ group, kind: "group" }),
              },
            ]),
      ],
      TabGroupColorSchema.options.map((hue): NativeMenuOption => ({
        id: `color:${hue}`,
        label: hue[0]!.toUpperCase() + hue.slice(1),
        onPress: () =>
          act("changeGroup", group.groupId, () =>
            client.updateTabGroup({ color: hue, groupId: group.groupId }),
          ),
        selected: group.color === hue,
      })),
      [
        {
          id: "ungroup",
          label: "Ungroup",
          onPress: () =>
            act("changeGroup", group.groupId, () => client.deleteTabGroup(group.groupId)),
        },
        ...(group.tabIds.length === 0
          ? []
          : [
              {
                destructive: true,
                icon: "xmark.circle" as const,
                id: "close",
                label: "Close tabs in group",
                onPress: () =>
                  act("closeGroup", group.groupId, () => closeTabs(client, group.tabIds)),
              },
            ]),
      ],
    ],
    [act, client],
  );
  const toggle = useCallback(
    (group: TabGroup) =>
      act("changeGroup", group.groupId, () =>
        client.updateTabGroup({ collapsed: !group.collapsed, groupId: group.groupId }),
      ),
    [act, client],
  );
  const submitName = useCallback(
    (name: string) => {
      const target = naming;
      setNaming(null);
      if (target === null || name.trim() === "") return;
      if (target.kind === "rename")
        act("changeGroup", target.groupId, () =>
          client.updateTabGroup({ groupId: target.groupId, name: name.trim() }),
        );
      else
        organize({
          group: { color: nextGroupColor(groups), name: name.trim() },
          tabIds: [target.tabId],
        });
    },
    [act, client, groups, naming, organize],
  );

  const renderItem = useCallback(
    ({ item }: { readonly item: TabEntry }) =>
      item.kind === "group" ? (
        <GroupHead
          group={item.group}
          hostClient={hostClient}
          menu={groupActions(item.group)}
          moving={moving}
          naming={naming?.kind === "rename" && naming.groupId === item.group.groupId}
          onCancelName={() => setNaming(null)}
          onName={submitName}
          onToggle={toggle}
        />
      ) : (
        <KeyedTabRow
          group={item.group}
          menu={tabActions}
          moving={moving}
          namingGroup={naming?.kind === "new-group" && naming.tabId === item.tabId}
          needsYou={signInSet.has(item.tabId)}
          onCancelName={() => setNaming(null)}
          onName={submitName}
          onOpen={moving === null ? props.onOpen : placeBefore}
          selected={props.selectedTabId === item.tabId}
          shown={props.shown ?? true}
          showComputer={spans.showComputer}
          showProfile={spans.showProfile}
          tabId={item.tabId}
          hostClient={hostClient}
        />
      ),
    [
      groupActions,
      hostClient,
      moving,
      naming,
      placeBefore,
      props.onOpen,
      props.selectedTabId,
      props.shown,
      signInSet,
      spans.showComputer,
      spans.showProfile,
      submitName,
      tabActions,
      toggle,
    ],
  );
  return (
    <FlatList
      contentContainerStyle={props.contentStyle}
      contentInsetAdjustmentBehavior="automatic"
      data={entries}
      keyExtractor={(entry) => (entry.kind === "group" ? entry.group.groupId : entry.tabId)}
      ListEmptyComponent={props.empty ?? undefined}
      ListHeaderComponent={
        <View style={styles.notices}>
          {props.header ?? null}
          {moving === null ? null : (
            <MoveBar
              moving={moving}
              onCancel={() => setMoving(null)}
              onEnd={
                moving.kind === "tab"
                  ? () => organize({ group: null, tabIds: [moving.tabId] })
                  : null
              }
            />
          )}
        </View>
      }
      renderItem={renderItem}
    />
  );
}

/** The strip as list lines: a collapsed group shows its head alone; a filter keeps only its matches. */
function listEntries(
  strip: readonly TabStripEntry[],
  matches: ReadonlySet<string> | null,
): readonly TabEntry[] {
  const lines: TabEntry[] = [];
  for (const entry of strip) {
    if (entry.kind === "tab") {
      if (matches === null || matches.has(entry.tabId))
        lines.push({ group: null, kind: "tab", tabId: entry.tabId });
      continue;
    }
    const kept = matches === null ? entry.tabIds : entry.tabIds.filter((id) => matches.has(id));
    if (matches !== null && kept.length === 0) continue;
    lines.push({ group: entry.group, kind: "group" });
    if (!entry.group.collapsed)
      for (const tabId of kept) lines.push({ group: entry.group, kind: "tab", tabId });
  }
  return lines;
}

/** A new group takes the first tint no group has yet, as Chrome does. */
function nextGroupColor(groups: readonly TabGroup[]): TabGroupColor {
  const used = new Set(groups.map((group) => group.color));
  return TabGroupColorSchema.options.find((hue) => !used.has(hue)) ?? "grey";
}

/**
 * The tabs a pending sign-in Request names, by tabId. A string, so a streamed
 * token, which leaves it equal, redraws nothing.
 */
function selectSignIns(snapshot: HostSnapshot): string {
  return snapshot.waitingRequests
    .flatMap(({ request: { payload } }) =>
      payload.kind === "browser.sign-in" && payload.tabId !== undefined ? [payload.tabId] : [],
    )
    .sort()
    .join("\n");
}

function MoveBar(props: {
  readonly moving: Moving;
  readonly onCancel: () => void;
  readonly onEnd: (() => void) | null;
}): ReactNode {
  const name = props.moving.kind === "tab" ? props.moving.title : props.moving.group.name;
  return (
    <View accessibilityLiveRegion="polite" style={styles.moveBar}>
      <AppText role="secondaryMedium">{`Tap the tab to put “${name}” before`}</AppText>
      <View style={styles.moveActions}>
        {props.onEnd === null ? null : (
          <SecondaryButton compact label="Move to end" onPress={props.onEnd} />
        )}
        <SecondaryButton compact label="Cancel" onPress={props.onCancel} />
      </View>
    </View>
  );
}

function NameField(props: {
  readonly initial: string;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState(props.initial);
  return (
    <View style={styles.nameField}>
      <Field
        input={{
          autoFocus: true,
          maxLength: 80,
          onChangeText: setDraft,
          onSubmitEditing: () => props.onSubmit(draft),
          returnKeyType: "done",
          value: draft,
        }}
        label={props.label}
      />
      <View style={styles.moveActions}>
        <SecondaryButton
          compact
          disabled={draft.trim() === ""}
          label="Save"
          onPress={() => props.onSubmit(draft)}
        />
        <SecondaryButton compact label="Cancel" onPress={props.onCancel} />
      </View>
    </View>
  );
}

const GroupHead = memo(function GroupHead(props: {
  readonly group: TabGroup;
  readonly hostClient: HostClient;
  readonly menu: readonly (readonly NativeMenuOption[])[];
  readonly moving: Moving | null;
  readonly naming: boolean;
  readonly onCancelName: () => void;
  readonly onName: (name: string) => void;
  readonly onToggle: (group: TabGroup) => void;
}): ReactNode {
  const { group } = props;
  const count = group.tabIds.length;
  const change = useScreenAction(
    props.hostClient,
    tabActionKey("changeGroup", group.groupId),
    tabActionSpecs.changeGroup,
  );
  const closing = useScreenAction(
    props.hostClient,
    tabActionKey("closeGroup", group.groupId),
    tabActionSpecs.closeGroup,
  );
  const busy = change.running || closing.running;
  const line = change.line ?? closing.line;
  return (
    <View style={styles.groupHead}>
      <View style={styles.groupLine}>
        <Pressable
          accessibilityHint={group.collapsed ? "Shows its tabs" : "Hides its tabs"}
          accessibilityLabel={`${group.name}, group of ${count} ${count === 1 ? "tab" : "tabs"}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, expanded: !group.collapsed }}
          disabled={busy || props.moving !== null}
          onPress={() => props.onToggle(group)}
          style={styles.groupToggle}
        >
          <View style={[styles.groupDot, { backgroundColor: tabGroupTint[group.color] }]} />
          <AppText numberOfLines={1} role="secondaryMedium" style={styles.flex}>
            {group.name}
          </AppText>
          <AppText role="caption" tone="muted">
            {String(count)}
          </AppText>
          <Symbol
            name={group.collapsed ? "chevron.right" : "chevron.down"}
            size={13}
            tint={color.muted}
          />
        </Pressable>
        {props.moving === null ? (
          <NativeMenu
            accessibilityLabel={`${group.name} actions`}
            disabledReason={busy ? "Wait for the last change to finish." : null}
            options={props.menu}
            style={styles.menu}
          >
            <Symbol name="ellipsis" size={17} tint={color.muted} />
          </NativeMenu>
        ) : null}
      </View>
      {line === null ? null : (
        <View style={styles.groupLineNote}>
          <RowSubtitle line={line} subtitle={null} />
        </View>
      )}
      {props.naming ? (
        <NameField
          initial={group.name}
          label="Group name"
          onCancel={props.onCancelName}
          onSubmit={props.onName}
        />
      ) : null}
    </View>
  );
});

interface TabRowProps {
  readonly group: TabGroup | null;
  readonly hostClient: HostClient;
  readonly menu: (place: PlaceItem) => readonly (readonly NativeMenuOption[])[];
  readonly moving: Moving | null;
  readonly namingGroup: boolean;
  readonly needsYou: boolean;
  readonly onCancelName: () => void;
  readonly onName: (name: string) => void;
  readonly onOpen: (tabId: TabId) => void;
  readonly selected: boolean;
  readonly shown: boolean;
  readonly showComputer: boolean;
  readonly showProfile: boolean;
}

/** A row reads its own tab, so a title or usage change repaints only it. */
const KeyedTabRow = memo(function KeyedTabRow({
  tabId,
  ...props
}: TabRowProps & { readonly tabId: TabId }): ReactNode {
  const place = usePlace(props.hostClient, tabId);
  return place ? <TabRow {...props} place={place} /> : null;
});

const TabRow = memo(function TabRow(props: TabRowProps & { readonly place: PlaceItem }): ReactNode {
  const { hostClient, place } = props;
  const tab = place.tab;
  // Who uses the tab, each marked working while the Host reports its Run acting in this very tab.
  const agents = usePlaceAgents(hostClient, place.key);
  const picture =
    props.shown && tab.kind === "page" ? browserTabPicture(hostClient, tab.tabId) : null;
  const sharedUsers = tab.sharedByPerson
    ? chromeTabUsedBy(agents.agents.map((agent) => agent.connectedAgentName ?? agent.title))
    : null;
  const detail = tabDetail(tab, props);
  const unavailable = tab.state === "unavailable";
  const movingThis =
    props.moving !== null &&
    (props.moving.kind === "tab"
      ? props.moving.tabId === tab.tabId
      : props.moving.group.tabIds.includes(tab.tabId));
  const title = tabTitle(tab);
  const closing = useScreenAction(
    hostClient,
    tabActionKey("close", tab.tabId),
    tabActionSpecs.close,
  );
  const moved = useScreenAction(hostClient, tabActionKey("move", tab.tabId), tabActionSpecs.move);
  const busy = closing.running || moved.running;
  // An action on this tab answers in the subtitle's place, so the row keeps its height.
  const line = closing.line ?? moved.line;
  return (
    <View>
      <View style={[styles.row, props.selected && styles.selected]}>
        {props.group === null ? null : (
          <View style={[styles.groupRail, { backgroundColor: tabGroupTint[props.group.color] }]} />
        )}
        <Pressable
          accessibilityHint={
            props.moving === null
              ? `Opens this ${tabKindNoun[tab.kind].toLowerCase()}`
              : "Puts the tab being moved before this one"
          }
          accessibilityLabel={[
            title,
            ...detail,
            sharedUsers ??
              (agents.agents.length > 0
                ? agents.agents.map((agent) => agent.title).join(", ")
                : null),
            props.needsYou ? "needs you" : null,
          ]
            .filter((part) => part !== null)
            .join(", ")}
          accessibilityRole="button"
          accessibilityState={{ disabled: movingThis, selected: props.selected }}
          disabled={movingThis}
          onPress={() => props.onOpen(tab.tabId)}
          style={({ pressed }) => [styles.rowPress, pressed && styles.pressed]}
          testID={`tab:${tab.kind}:${tab.state}`}
        >
          <View style={(unavailable || movingThis) && styles.dimmed}>
            {picture ? (
              <TabPicture picture={picture} size={32} />
            ) : place.icon.kind === "app" ? (
              <MacAppIcon
                app={{
                  bundleId: place.icon.bundleId,
                  displayName: place.icon.name,
                  teamId: null,
                }}
                hostClient={hostClient}
                machineId={place.icon.machineId}
                size={32}
              />
            ) : (
              <View style={styles.glyph}>
                <Symbol name={tabKindGlyph[tab.kind]} size={17} tint={color.muted} />
              </View>
            )}
          </View>
          <View style={styles.words}>
            <AppText numberOfLines={1} role="bodyMedium" tone={unavailable ? "muted" : "default"}>
              {title}
            </AppText>
            {detail.length === 0 && line === null ? null : (
              <RowSubtitle line={line} subtitle={detail.join(" · ")} />
            )}
            {sharedUsers ? (
              <AppText numberOfLines={1} role="caption" tone="muted">
                {sharedUsers}
              </AppText>
            ) : null}
          </View>
          {props.needsYou ? <NeedsYouTag /> : null}
          {agents.agents.length > 0 ? (
            <AgentMarks agents={agents.agents} />
          ) : agents.unnamedActing ? (
            <ActingDot grouped />
          ) : null}
        </Pressable>
        {props.moving === null ? (
          <NativeMenu
            accessibilityLabel={`${title} actions`}
            disabledReason={busy ? "Wait for the last change to finish." : null}
            options={props.menu(place)}
            style={styles.menu}
          >
            <Symbol name="ellipsis" size={17} tint={color.muted} />
          </NativeMenu>
        ) : null}
      </View>
      {props.namingGroup ? (
        <NameField
          initial=""
          label="New group name"
          onCancel={props.onCancelName}
          onSubmit={props.onName}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  dimmed: { opacity: 0.45 },
  flex: { flex: 1 },
  glyph: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  groupDot: { borderRadius: 5, height: 10, width: 10 },
  groupHead: { gap: space[8], paddingTop: space[12] },
  groupLine: { alignItems: "center", flexDirection: "row" },
  groupLineNote: { paddingHorizontal: space[12] },
  groupRail: { alignSelf: "stretch", borderRadius: 2, width: 3 },
  groupToggle: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  menu: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  moveActions: { flexDirection: "row", gap: space[8] },
  moveBar: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  nameField: { gap: space[8], paddingHorizontal: space[12], paddingVertical: space[8] },
  notices: { gap: space[8], paddingBottom: space[8] },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[4],
    minHeight: touchTarget + space[12],
    paddingLeft: space[4],
  },
  rowPress: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[8],
    paddingVertical: space[8],
  },
  selected: { backgroundColor: color.surfaceRaised },
  words: { flex: 1, gap: space[2], minWidth: 0 },
});
