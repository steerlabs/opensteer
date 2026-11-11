import {
  audienceLabel,
  composerRuntimeNotice,
  formatRelativeTime,
  isTeamPlace,
  requestOutcomeLine,
  requestWaitLines,
  taskStarterLine,
  taskStoppedText,
  unplacedOutcomes,
  type HostClient,
  type HostSnapshot,
  type ThreadSummary,
} from "@opensteer/client/host";
import { useHostRead, useHostSelector, useTeam } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { useCallback, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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
  /** The Requests the transcript already shows where they were asked, as a key. */
  readonly placed: string;
}

function sameTaskPlace(left: TeamTaskPlace, right: TeamTaskPlace): boolean {
  return (
    left.team === right.team &&
    left.project === right.project &&
    left.teamName === right.teamName &&
    left.viewerId === right.viewerId &&
    left.held === right.held &&
    left.placed === right.placed
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
      placed: (threadId === null ? [] : (snapshot.transcripts[threadId] ?? []))
        .flatMap((entry) => (entry.kind === "request" ? [entry.requestId] : []))
        .join(" "),
    }),
    [threadId, workspaceId],
  );
  return useHostSelector(hostClient, select, sameTaskPlace);
}

export type TeamRuntimeNotice = NonNullable<ReturnType<typeof composerRuntimeNotice>>;

/**
 * What a shared task says above its composer on a team place: who started it,
 * who can see it, how its earlier questions ended, why it stopped, whom it
 * waits on and why it can't send. Every line is a Host fact; one it doesn't
 * send isn't drawn.
 */
export function TeamTaskFacts(props: {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly runtime: TeamRuntimeNotice | null;
  readonly thread: ThreadSummary;
}): ReactNode {
  const { runtime, thread } = props;
  const navigation = useNavigation();
  const where = useTeamTaskPlace(props.hostClient, thread);
  if (!where.team) return null;
  const place = { project: where.project, team: where.teamName };
  const held = new Set(where.held.split(" ").filter(Boolean));
  const waits = thread.requestWaits
    ? requestWaitLines(thread.requestWaits, place.project, held)
    : [];
  // An outcome whose question the transcript shows is told there, where it was asked.
  const outcomes = unplacedOutcomes(
    thread.requestOutcomes ?? [],
    where.placed
      .split(" ")
      .filter(Boolean)
      .map((requestId) => ({ kind: "request", requestId })),
  ).slice(-outcomesShown);
  const starter = thread.startedBy ? taskStarterLine(thread.startedBy, where.viewerId) : null;
  const lines = [
    ...(thread.stopped
      ? [
          taskStoppedText(thread.stopped, place, {
            startedBy: thread.startedBy,
            viewerId: where.viewerId,
          }).long,
        ]
      : []),
    ...waits,
  ];
  if (
    !starter &&
    !thread.audience &&
    lines.length === 0 &&
    outcomes.length === 0 &&
    runtime === null
  )
    return null;
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
      {outcomes.length > 0 ? (
        <View accessibilityLabel="How earlier questions ended" style={styles.earlier}>
          {outcomes.map((outcome) => (
            <AppText key={outcome.requestId} role="caption" tone="muted">
              {`${requestOutcomeLine(outcome)} · ${formatRelativeTime(outcome.at)}`}
            </AppText>
          ))}
        </View>
      ) : null}
      {lines.map((line) => (
        <AppText key={line} role="caption" tone="muted">
          {line}
        </AppText>
      ))}
      {runtime === null ? null : (
        <View style={styles.line}>
          <AppText role="caption" tone="ember">
            {`Can’t send yet. ${runtime.why} ${runtime.fix}`}
          </AppText>
          {runtime.settings ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() =>
                navigation.navigate("TeamProjectRuntime", {
                  deploymentId: props.deploymentId,
                  workspaceId: thread.workspaceId,
                })
              }
            >
              <AppText role="caption" tone="default">
                How it runs
              </AppText>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

/**
 * Why a shared Project's composer can't send, from the summary's runtime. Who
 * may fix it comes from the Host's `can` on the Project, read only while it
 * can't run; until that answers, the reader is told who can.
 */
export function useTeamRuntimeNotice(
  hostClient: HostClient,
  thread: ThreadSummary | null,
): TeamRuntimeNotice | null {
  const { team, summary, identity, generation } = useTeam(hostClient);
  const where = useTeamTaskPlace(hostClient, thread);
  const runtime =
    thread === null
      ? undefined
      : summary?.projects.find(({ id }) => id === thread.workspaceId)?.runtime;
  const blocked =
    where.team && thread !== null && runtime !== undefined && runtime.state !== "ready";
  const workspaceId = thread?.workspaceId ?? "";
  const access = useHostRead(
    team && blocked ? () => team.projectAccess({ workspaceId, limit: 1 }) : null,
    `team-runtime-access:${identity}:${workspaceId}:${generation}`,
  );
  if (!blocked) return null;
  return composerRuntimeNotice(runtime, {
    project: where.project,
    team: where.teamName,
    canChange: access.data?.can.manage.allowed === true,
  });
}

const styles = StyleSheet.create({
  earlier: {
    borderBottomColor: color.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space[2],
    paddingBottom: space[4],
  },
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
