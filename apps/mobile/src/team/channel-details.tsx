import { useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  material,
  plateFill,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import {
  AppText,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
} from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { GroupNote, LinkRow, SwitchSettingRow } from "./settings-rows.js";
import { AgentOrb, Avatar, PeopleOnlyBadge, peopleOnlySentence } from "./team-marks.js";
import type { ChannelHeaderView, MemberRowView } from "./team-models.js";

export type NotifyLevel = "everything" | "mentions" | "nothing";

export interface ChannelDetailsActions {
  readonly onMembers: () => void;
  readonly onFiles: () => void;
  readonly onPinned: () => void;
  readonly onKnowledge: () => void;
  readonly onInstructions: () => void;
  /** "Your agent here": the folder on the reader's own Opensteer that runs from here use. */
  readonly onAgentFolder: () => void;
  readonly onNotify: () => void;
  readonly onEditAbout: () => void;
  readonly onSetPeopleOnly: (on: boolean) => void;
  readonly onAddPeople: () => void;
  readonly onLeave: () => void;
  readonly onArchive: () => void;
}

/**
 * A channel's Details, pushed from its title. On a phone it holds what the
 * desktop's tabs and Details pane do: Members, Files, Pinned, Knowledge and
 * the instructions for agents, then the reader's own settings here, then, for
 * managers, Access (People only) and Archive.
 */
export function ChannelDetailsBody(props: {
  readonly actions: ChannelDetailsActions;
  readonly channel: ChannelHeaderView;
  readonly canManage: boolean;
  readonly counts: { readonly files: number; readonly pinned: number };
  /** The folder agent runs from here use on the reader's Opensteer; null where agents can't be asked. */
  readonly agentFolder: string | null;
  readonly notify: NotifyLevel;
  /** Agents working here right now, named in the People only confirmation. */
  readonly workingAgents: number;
  readonly paddingBottom: number;
}): ReactNode {
  const { actions, channel } = props;
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  const glyph =
    channel.kind === "private" ? "Private" : channel.kind === "public" ? "Public" : null;
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      {dm ? null : (
        <View style={styles.about}>
          <View style={styles.aboutHead}>
            <AppText role="displaySmall" style={styles.aboutName}>
              #{channel.name}
            </AppText>
            {props.canManage ? (
              <Pressable
                accessibilityLabel="Edit name and description"
                accessibilityRole="button"
                hitSlop={10}
                onPress={actions.onEditAbout}
              >
                <AppText role="secondaryMedium" tone="ember">
                  Edit
                </AppText>
              </Pressable>
            ) : null}
          </View>
          {channel.description === null ? null : (
            <AppText role="secondary" tone="soft">
              {channel.description}
            </AppText>
          )}
          <View style={styles.aboutFacts}>
            <AppText role="caption" tone="muted">
              {[glyph, channel.peopleOnly ? null : "agents allowed"].filter(Boolean).join(" · ")}
            </AppText>
            {channel.peopleOnly ? <PeopleOnlyBadge /> : null}
          </View>
        </View>
      )}
      <RowGroup>
        {[
          dm ? null : (
            <LinkRow
              icon="person.2"
              key="members"
              label="Members"
              onPress={actions.onMembers}
              value={String(channel.memberCount)}
            />
          ),
          channel.kind === "group-dm" ? (
            <LinkRow
              icon="person.badge.plus"
              key="add"
              label="Add people"
              onPress={actions.onAddPeople}
              tone="ember"
            />
          ) : null,
          <LinkRow
            icon="paperclip"
            key="files"
            label="Files"
            onPress={actions.onFiles}
            value={String(props.counts.files)}
          />,
          <LinkRow
            icon="pin"
            key="pinned"
            label="Pinned"
            onPress={actions.onPinned}
            value={String(props.counts.pinned)}
          />,
          dm ? null : (
            <LinkRow
              icon="tablecells"
              key="knowledge"
              label="Knowledge"
              onPress={actions.onKnowledge}
            />
          ),
          dm || channel.peopleOnly ? null : (
            <LinkRow
              icon="sparkles"
              key="instructions"
              label="Instructions for agents"
              onPress={actions.onInstructions}
            />
          ),
        ].filter((row) => row !== null)}
      </RowGroup>
      {props.agentFolder === null ? null : (
        <View style={styles.group}>
          <SectionLabel>Your agent here · on your Opensteer</SectionLabel>
          <RowGroup>
            {[
              <LinkRow
                key="folder"
                label="Works in"
                mark={<AgentOrb size={18} />}
                onPress={actions.onAgentFolder}
                value={props.agentFolder}
              />,
            ]}
          </RowGroup>
          <GroupNote>Changes apply to new asks. Only you see this.</GroupNote>
        </View>
      )}
      <View style={styles.group}>
        <SectionLabel>You</SectionLabel>
        <RowGroup>
          {[
            <LinkRow
              icon="bell"
              key="notify"
              label="Notify me"
              onPress={actions.onNotify}
              value={notifyWords[props.notify]}
            />,
            channel.kind === "dm" ? null : (
              <LinkRow
                action
                icon="rectangle.portrait.and.arrow.right"
                key="leave"
                label={dm ? "Leave conversation" : `Leave #${channel.name}`}
                onPress={actions.onLeave}
                tone="danger"
              />
            ),
          ].filter((row) => row !== null)}
        </RowGroup>
      </View>
      {props.canManage && !dm ? (
        <View style={styles.group}>
          <SectionLabel>Access</SectionLabel>
          <RowGroup>
            {[
              <SwitchSettingRow
                detail="Agents can't be asked, read or search here."
                icon="person"
                key="people-only"
                label="People only"
                onChange={(on) =>
                  confirmPeopleOnly(channel.name, on, props.workingAgents, actions.onSetPeopleOnly)
                }
                value={channel.peopleOnly}
              />,
              <LinkRow
                action
                icon="archivebox"
                key="archive"
                label="Archive channel"
                onPress={actions.onArchive}
              />,
            ]}
          </RowGroup>
          <GroupNote>{peopleOnlySentence}</GroupNote>
        </View>
      ) : null}
    </ScrollView>
  );
}

const notifyWords: Record<NotifyLevel, string> = {
  everything: "Everything",
  mentions: "Mentions",
  nothing: "Nothing",
};

/**
 * A change that stops agents mid-run is confirmed first, and says how many
 * are working; turning it back off says what agents regain.
 */
function confirmPeopleOnly(
  name: string,
  on: boolean,
  working: number,
  apply: (on: boolean) => void,
): void {
  if (on) {
    Alert.alert(
      `Make #${name} people only?`,
      [
        "Agents can't be asked, read or search here, and the channel is told.",
        working === 0
          ? null
          : `${working === 1 ? "1 agent is" : `${working} agents are`} working here; ${working === 1 ? "it" : "they"} won't be able to post.`,
      ]
        .filter(Boolean)
        .join(" "),
      [
        { style: "cancel", text: "Cancel" },
        { onPress: () => apply(true), text: "Make people only" },
      ],
    );
    return;
  }
  Alert.alert(
    `Let agents work in #${name}?`,
    "Members can ask their agents here again, and agents can read and search it for the people who ask.",
    [
      { style: "cancel", text: "Cancel" },
      { onPress: () => apply(false), text: "Allow agents" },
    ],
  );
}

/**
 * The instructions every agent run started here is given. Everyone in the
 * channel can read them; people who manage it can edit them. Agents never
 * change them, and they are not a lock: access is the team server's job.
 */
export function InstructionsBody(props: {
  readonly channelName: string;
  readonly instructions: string | null;
  /** "Last changed by Sam, Nov 2". */
  readonly lastChanged: string | null;
  readonly canEdit: boolean;
  readonly failure: string | null;
  /** Settles once saved; the editor stays open with its words if it rejects. */
  readonly onSave: (text: string) => Promise<void>;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <AppText role="secondary" tone="muted">
        Added to every agent run started in #{props.channelName}. Everyone here can read them.
      </AppText>
      {editing ? (
        <TextInput
          accessibilityLabel="Instructions for agents"
          autoFocus
          cursorColor={color.ember}
          multiline
          onChangeText={setDraft}
          placeholder="For example: Refunds over $200 need a manager. Always note the order number."
          placeholderTextColor={color.muted}
          selectionColor={color.ember}
          style={styles.editor}
          value={draft}
        />
      ) : (
        <View style={styles.instructions}>
          <AppText role="body" tone={props.instructions === null ? "muted" : "default"}>
            {props.instructions ?? "No instructions yet."}
          </AppText>
        </View>
      )}
      {props.failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {props.failure}
        </AppText>
      )}
      {props.lastChanged === null || editing ? null : (
        <AppText role="caption" tone="muted">
          {props.lastChanged}
        </AppText>
      )}
      {!props.canEdit ? null : editing ? (
        <View style={styles.buttons}>
          <SecondaryButton compact label="Cancel" onPress={() => setDraft(null)} />
          <PrimaryButton
            busy={saving}
            compact
            disabled={draft.trim() === (props.instructions ?? "").trim()}
            label="Save"
            onPress={() => {
              setSaving(true);
              props.onSave(draft.trim()).then(
                () => {
                  setSaving(false);
                  setDraft(null);
                },
                () => setSaving(false),
              );
            }}
          />
        </View>
      ) : (
        <SecondaryButton compact label="Edit" onPress={() => setDraft(props.instructions ?? "")} />
      )}
    </ScrollView>
  );
}

/**
 * The people and groups in a channel. A group counts as members, including
 * people added to it later. Managers add people or groups and take them off;
 * removal closes their open views at once.
 */
export function MembersBody(props: {
  readonly members: readonly MemberRowView[];
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly canManage: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (memberId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}
      keyboardShouldPersistTaps="handled"
    >
      <SearchField
        onChange={props.onQuery}
        placeholder="Find people and groups"
        value={props.query}
      />
      {props.canManage ? (
        <RowGroup>
          {[
            <LinkRow
              action
              icon="person.badge.plus"
              key="add"
              label="Add people or groups"
              onPress={props.onAdd}
              tone="ember"
            />,
          ]}
        </RowGroup>
      ) : null}
      <RowGroup>
        {props.members.map((member) => (
          <View key={member.id} style={styles.member}>
            {member.person === null ? (
              <View style={styles.groupMark}>
                <Symbol name="person.3" size={16} tint={color.textSoft} />
              </View>
            ) : (
              <Avatar ground={plateFill} person={member.person} presence size={28} />
            )}
            <View style={styles.memberWords}>
              <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
                {member.name}
              </AppText>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="caption"
                tone="muted"
              >
                {member.detail}
              </AppText>
            </View>
            {member.role === "manager" ? (
              <AppText role="caption" style={styles.role}>
                Manager
              </AppText>
            ) : null}
            {member.canRemove ? (
              <Pressable
                accessibilityLabel={`Remove ${member.name}`}
                accessibilityRole="button"
                onPress={() => props.onRemove(member.id)}
                style={styles.remove}
              >
                <Symbol name="xmark" size={13} tint={color.muted} weight="semibold" />
              </Pressable>
            ) : null}
          </View>
        ))}
      </RowGroup>
    </ScrollView>
  );
}

export function SearchField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly autoFocus?: boolean;
}): ReactNode {
  return (
    <View style={styles.search}>
      <Symbol name="magnifyingglass" size={15} tint={color.muted} />
      <TextInput
        accessibilityLabel={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={props.autoFocus}
        clearButtonMode="while-editing"
        cursorColor={color.ember}
        maxFontSizeMultiplier={controlFontScaleLimit}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={color.muted}
        returnKeyType="search"
        selectionColor={color.ember}
        style={styles.searchInput}
        value={props.value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  about: { gap: space[4], paddingHorizontal: space[4] },
  aboutFacts: { alignItems: "center", flexDirection: "row", gap: space[8], marginTop: space[4] },
  aboutHead: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  aboutName: { flexShrink: 1 },
  buttons: { flexDirection: "row", gap: space[8], justifyContent: "flex-end" },
  editor: {
    ...material.control,
    ...type.body,
    borderRadius: radius.md,
    color: color.text,
    minHeight: 180,
    padding: space[12],
    textAlignVertical: "top",
  },
  group: { gap: space[8] },
  groupMark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  instructions: { ...material.plate, borderRadius: radius.md, padding: space[14] },
  member: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingLeft: space[14],
    paddingRight: space[6],
    paddingVertical: space[6],
  },
  memberWords: { flex: 1, minWidth: 0 },
  page: { gap: space[20], padding: space[16] },
  remove: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  role: { color: color.muted, fontWeight: "600" },
  search: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    minHeight: 40,
    paddingHorizontal: space[12],
  },
  searchInput: { ...type.body, color: color.text, flex: 1, paddingVertical: space[8] },
});
