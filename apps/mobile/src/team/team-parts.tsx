import {
  accessPreviewHeadline,
  accessPreviewLines,
  initialsOf,
  pagedListBound,
  teamErrorText,
  teamReasonText,
  type HostClient,
  type TeamAccess,
  isTeamPlace,
} from "@opensteer/client/host";
import { useHostSelector, useTeam } from "@opensteer/client/react";
import type { AccessChange, Can } from "@opensteer/protocol";
import type { ReactNode } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View } from "react-native";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText, SecondaryButton, SectionLabel } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

export function TeamSection(props: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
  readonly label: string;
}): ReactNode {
  return (
    <View style={styles.section}>
      <View accessibilityRole="header" style={styles.sectionHead}>
        <View style={styles.grow}>
          <SectionLabel>{props.label}</SectionLabel>
        </View>
        {props.action ?? null}
      </View>
      {props.children}
      {props.footer === undefined ? null : (
        <AppText role="caption" tone="muted">
          {props.footer}
        </AppText>
      )}
    </View>
  );
}

export function Avatar(props: {
  readonly name: string;
  readonly group?: boolean | undefined;
}): ReactNode {
  return (
    <View style={[styles.avatar, props.group === true && styles.avatarGroup]}>
      {props.group === true ? (
        <Symbol name="person.2" size={14} tint={color.textSoft} />
      ) : (
        <Text allowFontScaling={false} style={styles.avatarText}>
          {initialsOf(props.name)}
        </Text>
      )}
    </View>
  );
}

export function ReadState(props: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly team?: string;
}): ReactNode {
  if (props.error === null || props.error === undefined)
    return (
      <View accessibilityLabel="Loading" style={styles.row}>
        <ActivityIndicator color={color.muted} size="small" />
      </View>
    );
  return (
    <View style={styles.row}>
      <View style={styles.grow}>
        <AppText role="secondary" tone="danger">
          {teamErrorText(props.error, props.team)}
        </AppText>
      </View>
      <SecondaryButton compact label="Try again" onPress={props.onRetry} />
    </View>
  );
}

export function CanLine(props: { readonly can: Can; readonly team: string }): ReactNode {
  if (props.can.allowed || !props.can.reason) return null;
  return (
    <AppText role="caption" tone="muted">
      {teamReasonText(props.can.reason, props.team)}
    </AppText>
  );
}

export function showError(error: unknown, team: string): void {
  Alert.alert("That didn’t save", teamErrorText(error, team));
}

/**
 * Previews an access batch and asks before applying it: who gains, who loses,
 * and which other paths keep someone's access. A refused plan shows why and
 * offers nothing to confirm.
 */
export async function confirmAccessChange(input: {
  readonly team: TeamAccess;
  readonly teamName: string;
  readonly revision: number;
  readonly changes: readonly AccessChange[];
  readonly title: string;
  readonly confirm: string;
  readonly destructive?: boolean;
  readonly onDone?: () => void;
}): Promise<void> {
  let preview;
  try {
    preview = await input.team.previewAccess(input.revision, input.changes);
  } catch (error) {
    showError(error, input.teamName);
    return;
  }
  const lines = accessPreviewLines(preview, input.teamName).map(({ tone, text }) =>
    tone === "blocked" ? text : `• ${text}`,
  );
  if (!preview.allowed) {
    Alert.alert("This can’t be saved", lines.join("\n"));
    return;
  }
  Alert.alert(input.title, [accessPreviewHeadline(preview), ...lines].join("\n"), [
    { style: "cancel", text: "Cancel" },
    {
      style: input.destructive === true ? "destructive" : "default",
      text: input.confirm,
      onPress: () => {
        input.team
          .applyAccess(preview.accessRevision, input.changes)
          .then(() => input.onDone?.())
          .catch((error: unknown) => showError(error, input.teamName));
      },
    },
  ]);
}

export const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  avatarGroup: { borderRadius: radius.xs },
  avatarText: { color: color.textSoft, fontSize: 12, fontWeight: "700" },
  banner: {
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space[8],
    padding: space[14],
  },
  bannerAccent: { backgroundColor: color.emberWash, borderColor: color.emberLine },
  chip: {
    borderColor: color.lineStrong,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space[8],
    paddingVertical: space[2],
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space[6] },
  content: { gap: space[24], paddingTop: space[16] },
  grow: { flex: 1, gap: space[2], minWidth: 0 },
  identity: { alignItems: "center", flexDirection: "row", gap: space[12] },
  marker: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    flexDirection: "row",
    gap: space[6],
    minHeight: 32,
    paddingHorizontal: space[10],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  section: { gap: space[8] },
  sectionHead: { alignItems: "center", flexDirection: "row", gap: space[8] },
  titleLine: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[6] },
});

export function Pill(props: {
  readonly label: string;
  readonly tone?: "warn" | "accent" | undefined;
}): ReactNode {
  return (
    <View
      style={[
        styles.chip,
        props.tone === "warn" && { borderColor: color.amberLine, backgroundColor: color.amberWash },
        props.tone === "accent" && {
          borderColor: color.emberLine,
          backgroundColor: color.emberWash,
        },
      ]}
    >
      <AppText role="caption" tone={props.tone === "accent" ? "ember" : "soft"}>
        {props.label}
      </AppText>
    </View>
  );
}

/** Renders its child only when this Host lets the person create a project. */
export function CreateProjectGate(props: {
  readonly hostClient: HostClient | null;
  readonly children: ReactNode;
}): ReactNode {
  return props.hostClient === null ? (
    props.children
  ) : (
    <TeamCreateGate hostClient={props.hostClient}>{props.children}</TeamCreateGate>
  );
}

function TeamCreateGate(props: {
  readonly hostClient: HostClient;
  readonly children: ReactNode;
}): ReactNode {
  return useCanCreateProject(props.hostClient) ? props.children : null;
}

export function useCanCreateProject(hostClient: HostClient): boolean {
  const { summary } = useTeam(hostClient);
  const team = useHostSelector(hostClient, (snapshot) => isTeamPlace(snapshot));
  return !team || summary?.can.createProject.allowed === true;
}

/** "Show more" for a paged team list: one page per press, up to the list's bound. */
export function ShowMoreRow(props: {
  readonly list: {
    readonly nextCursor: string | null;
    readonly loadingMore: boolean;
    readonly capped: boolean;
    readonly error: unknown;
    readonly first: unknown;
    readonly more: () => void;
  };
  readonly team: string;
}): ReactNode {
  const { list } = props;
  if (list.first && list.error)
    return (
      <View style={styles.row}>
        <View style={styles.grow}>
          <AppText role="secondary" tone="danger">
            {teamErrorText(list.error, props.team)}
          </AppText>
        </View>
        <SecondaryButton compact label="Try again" onPress={list.more} />
      </View>
    );
  if (list.nextCursor)
    return (
      <View style={styles.row}>
        <SecondaryButton busy={list.loadingMore} compact label="Show more" onPress={list.more} />
      </View>
    );
  if (list.capped)
    return (
      <View style={styles.row}>
        <AppText role="caption" tone="muted">
          {`Showing the first ${pagedListBound.toLocaleString()}. Search to find the rest.`}
        </AppText>
      </View>
    );
  return null;
}
