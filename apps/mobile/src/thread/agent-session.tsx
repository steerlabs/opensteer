import {
  mutationIdempotencyKey,
  workWords,
  type HostClient,
  type HostSnapshot,
  type OperationRow,
  type OperationRequestView,
  type SessionTaskView,
} from "@opensteer/client/host";
import { useThreadTranscript } from "@opensteer/client/react";
import { AgentSessionIdSchema, RequestIdSchema, ThreadIdSchema } from "@opensteer/core";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ExternalAgentMark } from "../screens/external-agent-mark.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { ActionLine } from "../ui/action-line.js";
import { useScreenAction } from "../ui/client-feedback.js";
import { ComposerAction } from "../ui/composer-action.js";
import { useHostValue } from "../ui/mobile-client-context.js";
import { AppText } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import {
  operationRequestsOf,
  sessionRowOf,
  sessionTaskOf,
  type OperationRequestItem,
} from "./agent-session-model.js";
import type { ThreadHeaderState } from "./thread-pane.js";

const selectAgentWork = (snapshot: HostSnapshot) => snapshot.agentWork;

/** A task's session view while a connected agent works it itself; null for any other task. */
export function useSessionTask(
  hostClient: HostClient | null,
  threadId: string,
): SessionTaskView | null {
  const selectThread = useCallback(
    (snapshot: HostSnapshot) => snapshot.threads.find(({ id }) => id === threadId) ?? null,
    [threadId],
  );
  const thread = useHostValue(hostClient, selectThread, null);
  const agentWork = useHostValue(hostClient, selectAgentWork, undefined);
  return useMemo(
    () => (thread === null ? null : sessionTaskOf({ threads: [thread], agentWork }, threadId)),
    [agentWork, thread, threadId],
  );
}

/** A session task's row in Tasks: the agent's mark and what it is using; null for any other. */
export function useSessionRow(
  hostClient: HostClient | null,
  threadId: string,
): ReturnType<typeof sessionRowOf> {
  const selectThread = useCallback(
    (snapshot: HostSnapshot) => snapshot.threads.find(({ id }) => id === threadId) ?? null,
    [threadId],
  );
  const thread = useHostValue(hostClient, selectThread, null);
  const agentWork = useHostValue(hostClient, selectAgentWork, undefined);
  return useMemo(
    () => (thread === null ? null : sessionRowOf({ threads: [thread], agentWork }, threadId)),
    [agentWork, thread, threadId],
  );
}

const stopSpec = { label: "stop this agent", done: "stopped", happened: "it was stopped" } as const;

/** Ends one agent session on one task, bound to the session the person saw. */
export function useAgentSessionStop(hostClient: HostClient, threadId: string) {
  return useScreenAction<string, void>(hostClient, `agent-session-stop:${threadId}`, {
    ...stopSpec,
    execute: async (sessionId) => {
      await hostClient.dispatch({
        type: "agent.session.stop",
        threadId: ThreadIdSchema.parse(threadId),
        agentSessionId: AgentSessionIdSchema.parse(sessionId),
        idempotencyKey: mutationIdempotencyKey(`agent-session-stop:${sessionId}`),
      });
    },
  });
}

/**
 * A task a connected agent works itself: its activity as it happens, the Requests it opened,
 * and where the composer would be, the agent's state with Stop. Nobody types into another
 * agent's task.
 */
export function AgentSessionPane(props: {
  readonly hostClient: HostClient;
  readonly threadId: string;
  readonly title: string;
  readonly view: SessionTaskView;
  readonly onHeader?: ((header: ThreadHeaderState) => void) | undefined;
}): ReactNode {
  const { hostClient, onHeader, threadId, title, view } = props;
  useEffect(() => {
    onHeader?.({
      connectionLabel: view.header,
      title,
      placeName: null,
      icon: null,
      color: null,
      isVoice: false,
      task: null,
    });
  }, [onHeader, title, view.header]);
  const transcript = useThreadTranscript(hostClient, threadId);
  const agentWork = useHostValue(hostClient, selectAgentWork, undefined);
  const requests = useMemo(
    () => operationRequestsOf({ threads: [], agentWork }, threadId, transcript.requests),
    [agentWork, threadId, transcript.requests],
  );
  const stop = useAgentSessionStop(hostClient, threadId);
  const activity = view.activity;
  return (
    <View style={styles.pane} testID="agent-session">
      <ScrollView contentContainerStyle={styles.content}>
        <AppText role="secondaryMedium" tone="muted">
          {workWords("work.activity")}
        </AppText>
        {activity.kind === "unavailable" ? (
          <AppText tone="muted">{workWords("work.activityUnavailable")}</AppText>
        ) : activity.rows.length === 0 ? (
          <AppText tone="muted">{workWords("work.activityEmpty")}</AppText>
        ) : (
          activity.rows.map((row) => <OperationRowView key={row.id} row={row} />)
        )}
        {requests.map((item) => (
          <OperationRequestCard hostClient={hostClient} item={item} key={item.request.id} />
        ))}
      </ScrollView>
      <View style={styles.bar}>
        <View style={styles.barRow}>
          <ExternalAgentMark
            initial={view.agent.initial}
            providerId={view.agent.providerId}
            size={24}
          />
          <View accessibilityLiveRegion="polite" style={styles.grow}>
            <AppText
              numberOfLines={1}
              role="secondaryMedium"
              tone={view.state === "stopped" || view.state === "ended" ? "muted" : "default"}
            >
              {view.statusLine}
            </AppText>
          </View>
          {view.stop === null ? null : (
            <ComposerAction
              busy={stop.running}
              disabled={false}
              kind="stop"
              label={view.stop.label}
              onPress={() => {
                if (view.stop) void stop.run(view.stop.sessionId);
              }}
            />
          )}
        </View>
        <AppText role="caption" tone="muted">
          {view.noComposer}
        </AppText>
        {stop.line === null ? null : <ActionLine line={stop.line} onDismiss={stop.dismiss} />}
      </View>
    </View>
  );
}

const glyphs: Readonly<Record<OperationRow["glyph"], SFSymbolName>> = {
  globe: "globe",
  app: "square.grid.2x2",
  plugin: "puzzlepiece.extension",
  list: "list.bullet",
};
const tones: Readonly<Record<OperationRow["outcome"]["tone"], string>> = {
  ok: color.green,
  bad: color.red,
  warn: color.amber,
  muted: color.muted,
  busy: color.textSoft,
};

/** One operation: what it did, who allowed it, and how it ended, stated plainly. */
export function OperationRowView({ row }: { readonly row: OperationRow }): ReactNode {
  return (
    <View style={styles.operation} testID={`operation:${row.id}`}>
      <Symbol name={glyphs[row.glyph]} size={15} tint={color.textSoft} />
      <View style={styles.grow}>
        <AppText role="secondary">{row.action}</AppText>
        <AppText role="caption" tone="muted">
          {row.allowedBy === null ? row.outcome.label : `${row.allowedBy} · ${row.outcome.label}`}
        </AppText>
        {row.detail === null ? null : (
          <AppText role="caption" tone="muted">
            {row.detail}
          </AppText>
        )}
      </View>
      <View style={[styles.chip, { borderColor: tones[row.outcome.tone] }]}>
        <AppText role="caption" style={{ color: tones[row.outcome.tone] }}>
          {row.outcome.label}
        </AppText>
      </View>
    </View>
  );
}

const answerSpec = {
  label: "send your answer",
  done: "sent",
  happened: "your answer was sent",
} as const;

/**
 * The Request a direct operation opened: the Home's question and summary, the agent's own
 * words kept apart and labelled, the exact calls behind one tap, and Allow once or Don't
 * allow. Once settled, only what happened.
 */
export function OperationRequestCard(props: {
  readonly hostClient: HostClient;
  readonly item: OperationRequestItem;
}): ReactNode {
  const { hostClient, item } = props;
  const { request, view } = item;
  const [showCalls, setShowCalls] = useState(false);
  const answer = useScreenAction<string, void>(hostClient, `request:${request.id}`, {
    ...answerSpec,
    execute: async (value) => {
      if (view.answers === null) return;
      await hostClient.dispatch({
        type: "request.respond",
        requestId: RequestIdSchema.parse(request.id),
        response: { kind: "form", answers: { [view.answers.fieldId]: [value] } },
        idempotencyKey: mutationIdempotencyKey(`request:${request.id}`),
      });
    },
  });
  return (
    <View style={styles.card} testID={`operation-request:${request.id}`}>
      <View style={styles.barRow}>
        <ExternalAgentMark
          initial={view.agent.initial}
          providerId={view.agent.providerId}
          size={20}
        />
        <AppText role="secondaryMedium" tone="muted">
          {view.agent.name}
        </AppText>
      </View>
      <AppText role="bodyMedium">{view.question}</AppText>
      {view.summary ? <AppText role="secondary">{view.summary}</AppText> : null}
      {view.agentWords === null ? null : (
        <View style={styles.agentWords}>
          <AppText role="caption" tone="muted">
            {view.agentWords.label}
          </AppText>
          <AppText role="secondary" style={styles.italic} tone="soft">
            {view.agentWords.text}
          </AppText>
        </View>
      )}
      {view.calls === null ? null : (
        <>
          <Pressable
            accessibilityRole="button"
            onPress={() => setShowCalls((shown) => !shown)}
            style={styles.link}
          >
            <AppText role="secondaryMedium" tone="ember">
              {showCalls ? view.calls.hide : view.calls.show}
            </AppText>
          </Pressable>
          {showCalls ? (
            <AppText role="caption" style={styles.calls}>
              {view.calls.text}
            </AppText>
          ) : null}
        </>
      )}
      {view.answers === null ? (
        <AppText role="secondary" tone="muted">
          {view.settled}
        </AppText>
      ) : (
        <>
          <View style={styles.answers}>
            <AnswerButton
              busy={answer.running}
              label={view.answers.deny.label}
              onPress={() => void answer.run(view.answers!.deny.value)}
            />
            <AnswerButton
              busy={answer.running}
              label={view.answers.allow.label}
              onPress={() => void answer.run(view.answers!.allow.value)}
              primary
            />
          </View>
          <AppText role="caption" tone="muted">
            {view.after}
          </AppText>
        </>
      )}
      {answer.line === null ? null : <ActionLine line={answer.line} onDismiss={answer.dismiss} />}
    </View>
  );
}

function AnswerButton(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly primary?: boolean;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.busy }}
      disabled={props.busy}
      onPress={props.onPress}
      style={[styles.answer, props.primary === true && styles.primary]}
    >
      <AppText role="secondaryMedium" tone={props.primary === true ? "default" : "soft"}>
        {props.label}
      </AppText>
    </Pressable>
  );
}

/** The Needs you row's words and mark for a direct operation's Request. */
export type NeedsYouOperation = Pick<OperationRequestView, "agent" | "listTitle">;

const styles = StyleSheet.create({
  agentWords: {
    borderLeftColor: color.lineStrong,
    borderLeftWidth: 2,
    gap: space[4],
    paddingLeft: space[8],
  },
  answer: {
    alignItems: "center",
    borderColor: color.lineControl,
    borderRadius: radius.md,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget,
  },
  answers: { flexDirection: "row", gap: space[8] },
  bar: {
    borderTopColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space[4],
    padding: space[12],
  },
  barRow: { alignItems: "center", flexDirection: "row", gap: space[8] },
  calls: { backgroundColor: color.surfaceCode, fontFamily: "Menlo", padding: space[8] },
  card: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    gap: space[8],
    padding: space[12],
  },
  chip: {
    borderRadius: radius.xs,
    borderWidth: 1,
    paddingHorizontal: space[6],
    paddingVertical: 2,
  },
  content: { gap: space[12], padding: space[16] },
  grow: { flex: 1, minWidth: 0 },
  italic: { fontStyle: "italic" },
  link: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  operation: { alignItems: "flex-start", flexDirection: "row", gap: space[8] },
  pane: { flex: 1 },
  primary: { backgroundColor: color.emberWash, borderColor: color.emberLine },
});
