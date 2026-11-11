import type { ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, plateFill, radius, space, touchTarget } from "../theme.js";
import { AppText, RowGroup, SectionLabel } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { SearchField } from "./channel-details.js";
import { GroupNote, LinkRow, SwitchSettingRow } from "./settings-rows.js";
import { AgentOrb, Avatar, TeamTile } from "./team-marks.js";
import type { PersonView, TeamTileView } from "./team-models.js";

export type TeamRole = "owner" | "admin" | "member";

export interface TeamSettingsActions {
  readonly onProfile: () => void;
  readonly onNotifications: () => void;
  readonly onConnect: () => void;
  readonly onPeople: () => void;
  readonly onGroups: () => void;
  readonly onInvites: () => void;
  readonly onChannels: () => void;
  readonly onKnowledge: () => void;
  readonly onAuditLog: () => void;
  readonly onLeave: () => void;
}

/**
 * A team's page in Settings. Everyone sees themselves in it and their agent's
 * link; owners and admins also manage people, groups, invites, channels,
 * knowledge and the audit log. Admins never reach anyone's own Opensteer.
 */
export function TeamSettingsBody(props: {
  readonly actions: TeamSettingsActions;
  readonly team: TeamTileView;
  /** "chat.acme.example". */
  readonly address: string;
  readonly me: PersonView;
  readonly role: TeamRole;
  /** The computer the reader's agent is connected from, or null. */
  readonly agentLink: string | null;
  readonly counts: { readonly people: number; readonly groups: number };
  readonly paddingBottom: number;
}): ReactNode {
  const { actions, me, team } = props;
  const admin = props.role !== "member";
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      <View style={styles.hero}>
        <TeamTile size={56} team={team} />
        <AppText role="displaySmall">{team.name}</AppText>
        <AppText role="caption" tone="muted">
          {props.address} · Opensteer Account sign-in
        </AppText>
      </View>
      <View style={styles.group}>
        <SectionLabel>You</SectionLabel>
        <RowGroup>
          {[
            <LinkRow
              detail={`@${me.handle} · your agent is @${me.handle}-agent`}
              key="profile"
              label={me.name}
              mark={<Avatar ground={plateFill} person={me} size={28} />}
              onPress={actions.onProfile}
              value={roleWords[props.role]}
            />,
            <LinkRow
              icon="bell"
              key="notify"
              label="Notifications"
              onPress={actions.onNotifications}
            />,
            <LinkRow
              detail={
                props.agentLink === null ? "Connect your Opensteer to ask your agent here" : null
              }
              key="agent"
              label="Your agent"
              mark={<AgentOrb size={20} />}
              onPress={actions.onConnect}
              tone={props.agentLink === null ? "ember" : "default"}
              value={props.agentLink ?? "Not connected"}
            />,
          ]}
        </RowGroup>
      </View>
      {admin ? (
        <View style={styles.group}>
          <SectionLabel>{`Manage ${team.name}`}</SectionLabel>
          <RowGroup>
            {[
              <LinkRow
                icon="person.2"
                key="people"
                label="People"
                onPress={actions.onPeople}
                value={String(props.counts.people)}
              />,
              <LinkRow
                icon="person.3"
                key="groups"
                label="Groups"
                onPress={actions.onGroups}
                value={String(props.counts.groups)}
              />,
              <LinkRow icon="link" key="invites" label="Invites" onPress={actions.onInvites} />,
              <LinkRow
                icon="number"
                key="channels"
                label="Channels"
                onPress={actions.onChannels}
              />,
              <LinkRow
                icon="tablecells"
                key="knowledge"
                label="Knowledge"
                onPress={actions.onKnowledge}
              />,
              <LinkRow
                icon="list.bullet"
                key="audit"
                label="Audit log"
                onPress={actions.onAuditLog}
              />,
            ]}
          </RowGroup>
        </View>
      ) : null}
      <GroupNote>{`Admins can see what agents read, searched and posted in ${team.name}. Nobody here can see your own Opensteer or your tasks.`}</GroupNote>
      <RowGroup>
        {[
          <LinkRow
            action
            icon="rectangle.portrait.and.arrow.right"
            key="leave"
            label={`Leave ${team.name}`}
            onPress={() =>
              Alert.alert(
                `Leave ${team.name}?`,
                `You'll lose access to its channels. Tasks your agent did for ${team.name} stay on your computer.`,
                [
                  { style: "cancel", text: "Cancel" },
                  { onPress: actions.onLeave, style: "destructive", text: "Leave" },
                ],
              )
            }
            tone="danger"
          />,
        ]}
      </RowGroup>
    </ScrollView>
  );
}

const roleWords: Record<TeamRole, string> = { admin: "Admin", member: "Member", owner: "Owner" };

export interface PersonAdminRow {
  readonly person: PersonView;
  readonly email: string | null;
  readonly role: TeamRole;
  /** "Active now", "2d ago". */
  readonly lastActive: string;
  readonly deactivated: boolean;
}

/** Everyone in the team. A row opens its actions: Change role, Add to group, Deactivate. */
export function PeopleAdminBody(props: {
  readonly people: readonly PersonAdminRow[];
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onInvite: () => void;
  readonly onPerson: (personId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}
      keyboardShouldPersistTaps="handled"
    >
      <SearchField onChange={props.onQuery} placeholder="Find people" value={props.query} />
      <RowGroup>
        {[
          <LinkRow
            action
            icon="person.badge.plus"
            key="invite"
            label="Invite people"
            onPress={props.onInvite}
            tone="ember"
          />,
        ]}
      </RowGroup>
      <RowGroup>
        {props.people.map((row) => (
          <Pressable
            accessibilityHint="Change role, add to a group, or deactivate"
            accessibilityLabel={`${row.person.name}, ${roleWords[row.role]}${row.deactivated ? ", deactivated" : ""}`}
            accessibilityRole="button"
            key={row.person.id}
            onPress={() => props.onPerson(row.person.id)}
            style={({ pressed }) => [
              styles.person,
              pressed && styles.pressed,
              row.deactivated && styles.dim,
            ]}
          >
            <Avatar ground={plateFill} person={row.person} size={28} />
            <View style={styles.words}>
              <AppText maxFontSizeMultiplier={controlFontScaleLimit} numberOfLines={1} role="body">
                {row.person.name}
              </AppText>
              <AppText
                maxFontSizeMultiplier={controlFontScaleLimit}
                numberOfLines={1}
                role="caption"
                tone="muted"
              >
                {[
                  `@${row.person.handle}`,
                  row.email,
                  row.deactivated ? "Deactivated" : row.lastActive,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </AppText>
            </View>
            {row.role === "member" ? null : (
              <View style={styles.role}>
                <AppText role="caption" style={styles.roleText}>
                  {roleWords[row.role]}
                </AppText>
              </View>
            )}
            <Symbol name="ellipsis" size={15} tint={color.muted} />
          </Pressable>
        ))}
      </RowGroup>
    </ScrollView>
  );
}

export interface GroupAdminRow {
  readonly id: string;
  readonly name: string;
  /** "6 people · 1 group". */
  readonly members: string;
  /** "#support, #launch, Leadership topic". */
  readonly usedBy: string | null;
}

/**
 * Groups of people (and of other groups). A channel or topic that lists a
 * group includes everyone in it, now and later.
 */
export function GroupsAdminBody(props: {
  readonly groups: readonly GroupAdminRow[];
  readonly onNew: () => void;
  readonly onGroup: (groupId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      <RowGroup>
        {[
          <LinkRow
            action
            icon="plus"
            key="new"
            label="New group"
            onPress={props.onNew}
            tone="ember"
          />,
        ]}
      </RowGroup>
      <RowGroup>
        {props.groups.map((group) => (
          <LinkRow
            detail={[group.members, group.usedBy === null ? null : `Used by ${group.usedBy}`]
              .filter(Boolean)
              .join(" · ")}
            icon="person.3"
            key={group.id}
            label={group.name}
            onPress={() => props.onGroup(group.id)}
          />
        ))}
      </RowGroup>
    </ScrollView>
  );
}

export interface GroupMemberRow {
  readonly id: string;
  readonly kind: "person" | "group";
  readonly name: string;
  readonly person: PersonView | null;
}

/** One group: who is in it (people and groups) and where it grants access. */
export function GroupDetailBody(props: {
  readonly members: readonly GroupMemberRow[];
  readonly usedBy: readonly string[];
  readonly onAdd: () => void;
  readonly onRemove: (memberId: string) => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      <View style={styles.group}>
        <SectionLabel>Members</SectionLabel>
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
            ...props.members.map((member) => (
              <View key={member.id} style={styles.person}>
                {member.person === null ? (
                  <View style={styles.groupMark}>
                    <Symbol name="person.3" size={15} tint={color.textSoft} />
                  </View>
                ) : (
                  <Avatar ground={plateFill} person={member.person} size={28} />
                )}
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  numberOfLines={1}
                  role="body"
                  style={styles.words}
                >
                  {member.name}
                </AppText>
                <Pressable
                  accessibilityLabel={`Remove ${member.name}`}
                  accessibilityRole="button"
                  onPress={() => props.onRemove(member.id)}
                  style={styles.remove}
                >
                  <Symbol name="xmark" size={13} tint={color.muted} weight="semibold" />
                </Pressable>
              </View>
            )),
          ]}
        </RowGroup>
      </View>
      <View style={styles.group}>
        <SectionLabel>Used by</SectionLabel>
        {props.usedBy.length === 0 ? (
          <GroupNote>No channel or topic lists this group yet.</GroupNote>
        ) : (
          <RowGroup>
            {props.usedBy.map((place) => (
              <View key={place} style={styles.usedBy}>
                <AppText role="body">{place}</AppText>
              </View>
            ))}
          </RowGroup>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * The team's invite link. Anyone with it can join while it is on; a new link
 * replaces the old one at once.
 */
export function InvitesAdminBody(props: {
  readonly enabled: boolean;
  readonly onEnabled: (on: boolean) => void;
  readonly link: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onShare: () => void;
  readonly onNewLink: () => void;
  /** "Expires Nov 18 · used 4 times". */
  readonly status: string;
  /** "#general". */
  readonly landing: string;
  readonly onLanding: () => void;
  readonly paddingBottom: number;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: props.paddingBottom }]}>
      <RowGroup>
        {[
          <SwitchSettingRow
            detail={null}
            icon="link"
            key="on"
            label="Invite link"
            onChange={props.onEnabled}
            value={props.enabled}
          />,
          props.enabled ? (
            <View key="link" style={styles.link}>
              <AppText numberOfLines={1} role="secondary" style={styles.words} tone="soft">
                {props.link}
              </AppText>
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={props.onCopy}
                style={styles.linkAction}
              >
                <AppText role="secondaryMedium" tone="ember">
                  {props.copied ? "Copied" : "Copy"}
                </AppText>
              </Pressable>
              <Pressable
                accessibilityLabel="Share the invite link"
                accessibilityRole="button"
                onPress={props.onShare}
                style={styles.linkAction}
              >
                <Symbol name="square.and.arrow.up" size={17} tint={color.ember} />
              </Pressable>
            </View>
          ) : null,
          props.enabled ? (
            <LinkRow
              key="landing"
              label="New people land in"
              onPress={props.onLanding}
              value={props.landing}
            />
          ) : null,
          props.enabled ? (
            <LinkRow
              action
              icon="arrow.clockwise"
              key="new"
              label="New link"
              onPress={() =>
                Alert.alert("Make a new invite link?", "The current link stops working at once.", [
                  { style: "cancel", text: "Cancel" },
                  { onPress: props.onNewLink, text: "New link" },
                ])
              }
            />
          ) : null,
        ].filter((row) => row !== null)}
      </RowGroup>
      {props.enabled ? (
        <GroupNote>{props.status}</GroupNote>
      ) : (
        <GroupNote>Nobody can join with a link while it is off.</GroupNote>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  dim: { opacity: 0.5 },
  group: { gap: space[8] },
  groupMark: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  hero: { alignItems: "center", gap: space[6], paddingTop: space[8] },
  link: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[4],
    minHeight: touchTarget + 6,
    paddingLeft: space[14],
    paddingRight: space[4],
  },
  linkAction: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  page: { gap: space[20], padding: space[16] },
  person: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingLeft: space[14],
    paddingRight: space[10],
    paddingVertical: space[6],
  },
  pressed: { backgroundColor: color.surfacePressed },
  remove: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    width: touchTarget,
  },
  role: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    paddingHorizontal: space[8],
    paddingVertical: 2,
  },
  roleText: { color: color.textSoft, fontWeight: "600" },
  usedBy: { justifyContent: "center", minHeight: touchTarget, paddingHorizontal: space[14] },
  words: { flex: 1, minWidth: 0 },
});
