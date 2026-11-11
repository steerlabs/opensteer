import {
  audienceLabel,
  composerRuntimeNotice,
  formatRelativeTime,
  isTeamPlace,
  requestOutcomeLine,
  requestWaitLines,
  taskStarterLine,
  taskStoppedText,
  type HostClient,
  type HostSnapshot,
  type ThreadSummary,
} from "@opensteer/client/host";
import { useHostSelector, useTeam } from "@opensteer/client/react";
import { useCallback, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { color, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";

/** The latest outcomes a task shows; the Host keeps more than a reader needs here. */
const outcomesShown = 3;

interface TeamTaskPlace {
  readonly team: boolean;
  readonly project: string;
  readonly teamName: string;
  readonly viewerId: string | null;
  /** The pending Requests on this task the reader holds, as a key. */
  readonly held: string;
}

function sameTaskPlace(left: TeamTaskPlace, right: TeamTaskPlace): boolean {
  return (
    left.team === right.team &&
    left.project === right.project &&
    left.teamName === right.teamName &&
    left.viewerId === right.viewerId &&
    left.held === right.held
  );
}

function useTeamTaskPlace(hostClient: HostClient, thread: ThreadSummary | null): TeamTaskPlace {
  const threadId = thread?.id ?? null;
  const workspaceId = thread?.workspaceId ?? null;
  const select = useCallback(
    (snapshot: HostSnapshot): TeamTaskPlace => ({
      team: isTeamPlace(snapshot),
      project: snapshot.workspaces.find(({ id }) => id === workspaceId)?.name ?? "this project",
      teamName: snapshot.identityConfig?.deployment.name ?? "the team",
      viewerId: snapshot.user?.id ?? null,
      held: (threadId === null ? [] : (snapshot.requests[threadId] ?? []))
        .filter(({ status }) => status === "pending")
        .map(({ id }) => id)
        .join(" "),
    }),
    [threadId, workspaceId],
  );
  return useHostSelector(hostClient, select, sameTaskPlace);
}

/**
 * What a shared task says above its composer on a team place: who started it,
 * who can see it, why it stopped or can't send, whom its questions wait on and
 * how they ended. Every line is a Host fact; one it doesn't send isn't drawn.
 */
export function TeamTaskFacts(props: {
  readonly hostClient: HostClient;
  readonly thread: ThreadSummary;
}): ReactNode {
  const { thread } = props;
  const where = useTeamTaskPlace(props.hostClient, thread);
  const blocked = useTeamSendBlocked(props.hostClient, thread);
  if (!where.team) return null;
  const place = { project: where.project, team: where.teamName };
  const held = new Set(where.held.split(" ").filter(Boolean));
  const waits = thread.requestWaits
    ? requestWaitLines(thread.requestWaits, place.project, held)
    : [];
  const outcomes = (thread.requestOutcomes ?? []).slice(-outcomesShown);
  const starter = thread.startedBy ? taskStarterLine(thread.startedBy, where.viewerId) : null;
  const lines = [
    ...(thread.stopped ? [taskStoppedText(thread.stopped, place).long] : []),
    ...waits,
    ...outcomes.map(
      (outcome) => `${requestOutcomeLine(outcome, place)} · ${formatRelativeTime(outcome.at)}`,
    ),
  ];
  if (!starter && !thread.audience && lines.length === 0 && blocked === null) return null;
  return (
    <View accessibilityLabel="About this task" style={styles.facts}>
      {starter || thread.audience ? (
        <View style={styles.line}>
          {starter ? (
            <AppText role="caption" tone="soft">
              {starter}
            </AppText>
          ) : null}
          {thread.audience ? (
            <View style={styles.marker}>
              <Symbol name="person.2" size={11} tint={color.textSoft} />
              <AppText role="caption" tone="soft">
                {audienceLabel(thread.audience, place.project)}
              </AppText>
            </View>
          ) : null}
        </View>
      ) : null}
      {lines.map((line) => (
        <AppText key={line} role="caption" tone="muted">
          {line}
        </AppText>
      ))}
      {blocked === null ? null : (
        <AppText role="caption" tone="ember">
          {blocked}
        </AppText>
      )}
    </View>
  );
}

/**
 * Why a shared Project's composer can't send, from the summary's runtime and
 * the reader's level on it. Null when it runs or nothing is known.
 */
export function useTeamSendBlocked(
  hostClient: HostClient,
  thread: ThreadSummary | null,
): string | null {
  const { summary } = useTeam(hostClient);
  const where = useTeamTaskPlace(hostClient, thread);
  if (!where.team || thread === null) return null;
  const runtime = summary?.projects.find(({ id }) => id === thread.workspaceId)?.runtime;
  const notice = composerRuntimeNotice(runtime, {
    project: where.project,
    team: where.teamName,
    manages: thread.audience?.myLevel === "manage",
  });
  return notice ? `Can’t send yet. ${notice.why} ${notice.fix}` : null;
}

const styles = StyleSheet.create({
  facts: { gap: space[4], paddingBottom: space[8], paddingHorizontal: space[16] },
  line: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  marker: {
    alignItems: "center",
    borderColor: color.line,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[4],
    paddingHorizontal: space[8],
    paddingVertical: space[2],
  },
});
