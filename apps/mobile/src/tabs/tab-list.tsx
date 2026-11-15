import type { HostClient, LegacyHostSnapshot, TabsReadModel } from "@opensteer/client/host";
import { samePlaceAgents } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import {
  TabGroupColorSchema,
  type Tab,
  type TabGroup,
  type TabGroupColor,
  type TabId,
} from "@opensteer/core";
import type { TabOrganizeInput } from "@opensteer/protocol";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { ActingDot } from "../browser/acting-dot.js";
import { AgentMarks } from "../browser/agent-marks.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { NativeMenu, type NativeMenuOption } from "../thread/composer-menu.js";
import { NeedsYouTag } from "../threads/task-row.js";
import { AppText, Field, Notice, SecondaryButton } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { tabAgents } from "./tab-agents.js";
import {
  layoutGroups,
  moveBefore,
  moveGroupBefore,
  tabDetail,
  tabEntries,
  tabGroupOf,
  tabKindGlyph,
  tabKindNoun,
  tabTitle,
  type TabEntry,
} from "./tab-entries.js";
import { tabsClient } from "./tabs-host.js";
import { useOperation, useTab, useTabLayout, useTabListSpans } from "./use-tabs.js";

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

export interface TabListProps {
  readonly hostClient: HostClient;
  readonly model: TabsReadModel;
  /** Which tabs to show; groups with none of them shown are left out. */
  readonly filter?: ((tab: Tab) => boolean) | null;
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
  const { hostClient, model } = props;
  const layout = useTabLayout(model);
  const spans = useTabListSpans(model);
  const signIns = useHostSelector(hostClient, selectSignIns);
  const operation = useOperation();
  const [moving, setMoving] = useState<Moving | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const client = tabsClient(hostClient);
  const filter = props.filter ?? null;
  // The ids the filter keeps, as one string, so only a change in what matches redraws the list.
  const readMatches = () =>
    filter === null
      ? null
      : [...model.rows.values()]
          .filter(filter)
          .map((tab) => tab.tabId)
          .join("\n");
  const matchKey = useSyncExternalStore(model.subscribe, readMatches, readMatches);
  const entries = useMemo(() => {
    const all = tabEntries(layout);
    if (matchKey === null) return all;
    const matched = new Set(matchKey.split("\n"));
    return all.filter((entry) =>
      entry.kind === "tab"
        ? matched.has(entry.tabId)
        : entry.group.tabIds.some((id) => matched.has(id)),
    );
  }, [layout, matchKey]);
  const groups = useMemo(() => layoutGroups(layout), [layout]);
  const signInSet = useMemo(() => new Set(signIns.split("\n")), [signIns]);

  const organize = useCallback(
    (input: TabOrganizeInput | null) => {
      setMoving(null);
      if (input === null) return;
      void operation.run(() => client.organizeTabs(input), "The tabs could not be moved.");
    },
    [client, operation],
  );
  const placeBefore = useCallback(
    (anchorId: TabId) => {
      if (moving === null) return;
      if (moving.kind === "tab") {
        if (moving.tabId !== anchorId) organize(moveBefore(model.layout, moving.tabId, anchorId));
        return;
      }
      organize(moveGroupBefore(moving.group, anchorId));
    },
    [model, moving, organize],
  );
  const tabActions = useCallback(
    (tab: Tab): readonly (readonly NativeMenuOption[])[] => {
      const current = tabGroupOf(model.layout, tab.tabId);
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
            onPress: () =>
              void operation.run(
                () => client.closeTabs([tab.tabId]),
                "The tab could not be closed.",
              ),
          },
        ],
      ];
    },
    [client, groups, model, operation, organize],
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
          void operation.run(
            () => client.updateTabGroup({ color: hue, groupId: group.groupId }),
            "The group could not be changed.",
          ),
        selected: group.color === hue,
      })),
      [
        {
          id: "ungroup",
          label: "Ungroup",
          onPress: () =>
            void operation.run(
              () => client.deleteTabGroup(group.groupId),
              "The group could not be removed.",
            ),
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
                  void operation.run(
                    () => client.closeTabs([...group.tabIds]),
                    "The tabs could not be closed.",
                  ),
              },
            ]),
      ],
    ],
    [client, operation],
  );
  const toggle = useCallback(
    (group: TabGroup) =>
      void operation.run(
        () => client.updateTabGroup({ collapsed: !group.collapsed, groupId: group.groupId }),
        "The group could not be changed.",
      ),
    [client, operation],
  );
  const submitName = useCallback(
    (name: string) => {
      const target = naming;
      setNaming(null);
      if (target === null || name.trim() === "") return;
      if (target.kind === "rename")
        void operation.run(
          () => client.updateTabGroup({ groupId: target.groupId, name: name.trim() }),
          "The group could not be renamed.",
        );
      else
        organize({
          group: { color: nextGroupColor(groups), name: name.trim() },
          tabIds: [target.tabId],
        });
    },
    [client, groups, naming, operation, organize],
  );

  const renderItem = useCallback(
    ({ item }: { readonly item: TabEntry }) =>
      item.kind === "group" ? (
        <GroupHead
          busy={operation.busy}
          group={item.group}
          menu={groupActions(item.group)}
          moving={moving}
          naming={naming?.kind === "rename" && naming.groupId === item.group.groupId}
          onCancelName={() => setNaming(null)}
          onName={submitName}
          onToggle={toggle}
        />
      ) : (
        <KeyedTabRow
          busy={operation.busy}
          group={item.group}
          menu={tabActions}
          model={model}
          moving={moving}
          namingGroup={naming?.kind === "new-group" && naming.tabId === item.tabId}
          needsYou={signInSet.has(item.tabId)}
          onCancelName={() => setNaming(null)}
          onName={submitName}
          onOpen={moving === null ? props.onOpen : placeBefore}
          selected={props.selectedTabId === item.tabId}
          showComputer={spans.showComputer}
          showProfile={spans.showProfile}
          tabId={item.tabId}
          hostClient={hostClient}
        />
      ),
    [
      groupActions,
      hostClient,
      model,
      moving,
      naming,
      operation.busy,
      placeBefore,
      props.onOpen,
      props.selectedTabId,
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
          {operation.failure === null ? null : (
            <Notice
              action={{ label: "Dismiss", onPress: operation.dismiss }}
              detail={operation.failure}
              title="That didn’t work"
            />
          )}
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

/** A new group takes the first tint no group has yet, as Chrome does. */
function nextGroupColor(groups: readonly TabGroup[]): TabGroupColor {
  const used = new Set(groups.map((group) => group.color));
  return TabGroupColorSchema.options.find((hue) => !used.has(hue)) ?? "grey";
}

/**
 * The tabs a pending sign-in Request names, by tabId. A string, so a streamed
 * token, which leaves it equal, redraws nothing.
 */
function selectSignIns(snapshot: LegacyHostSnapshot): string {
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
  readonly busy: boolean;
  readonly group: TabGroup;
  readonly menu: readonly (readonly NativeMenuOption[])[];
  readonly moving: Moving | null;
  readonly naming: boolean;
  readonly onCancelName: () => void;
  readonly onName: (name: string) => void;
  readonly onToggle: (group: TabGroup) => void;
}): ReactNode {
  const { group } = props;
  const count = group.tabIds.length;
  return (
    <View style={styles.groupHead}>
      <View style={styles.groupLine}>
        <Pressable
          accessibilityHint={group.collapsed ? "Shows its tabs" : "Hides its tabs"}
          accessibilityLabel={`${group.name}, group of ${count} ${count === 1 ? "tab" : "tabs"}`}
          accessibilityRole="button"
          accessibilityState={{ disabled: props.busy, expanded: !group.collapsed }}
          disabled={props.busy || props.moving !== null}
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
            disabledReason={props.busy ? "Wait for the last change to finish." : null}
            options={props.menu}
            style={styles.menu}
          >
            <Symbol name="ellipsis" size={17} tint={color.muted} />
          </NativeMenu>
        ) : null}
      </View>
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
  readonly busy: boolean;
  readonly group: TabGroup | null;
  readonly hostClient: HostClient;
  readonly menu: (tab: Tab) => readonly (readonly NativeMenuOption[])[];
  readonly moving: Moving | null;
  readonly namingGroup: boolean;
  readonly needsYou: boolean;
  readonly onCancelName: () => void;
  readonly onName: (name: string) => void;
  readonly onOpen: (tabId: TabId) => void;
  readonly selected: boolean;
  readonly showComputer: boolean;
  readonly showProfile: boolean;
}

/** A row reads its own tab, so a title or usage change repaints only it. */
const KeyedTabRow = memo(function KeyedTabRow({
  model,
  tabId,
  ...props
}: TabRowProps & { readonly model: TabsReadModel; readonly tabId: TabId }): ReactNode {
  const tab = useTab(model, tabId);
  return tab ? <TabRow {...props} tab={tab} /> : null;
});

const TabRow = memo(function TabRow(props: TabRowProps & { readonly tab: Tab }): ReactNode {
  const { tab } = props;
  const selectAgents = useCallback(
    (snapshot: LegacyHostSnapshot) => tabAgents(tab.usedBy, snapshot),
    [tab.usedBy],
  );
  const agents = useHostSelector(props.hostClient, selectAgents, samePlaceAgents);
  const detail = tabDetail(tab, props);
  const unavailable = tab.state === "unavailable";
  const movingThis =
    props.moving !== null &&
    (props.moving.kind === "tab"
      ? props.moving.tabId === tab.tabId
      : props.moving.group.tabIds.includes(tab.tabId));
  const title = tabTitle(tab);
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
            agents.agents.length > 0 ? agents.agents.map((agent) => agent.title).join(", ") : null,
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
          <View style={[styles.glyph, (unavailable || movingThis) && styles.dimmed]}>
            <Symbol name={tabKindGlyph[tab.kind]} size={17} tint={color.muted} />
          </View>
          <View style={styles.words}>
            <AppText numberOfLines={1} role="bodyMedium" tone={unavailable ? "muted" : "default"}>
              {title}
            </AppText>
            {detail.length === 0 ? null : (
              <AppText numberOfLines={1} role="caption" tone="muted">
                {detail.join(" · ")}
              </AppText>
            )}
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
            disabledReason={props.busy ? "Wait for the last change to finish." : null}
            options={props.menu(tab)}
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
