import {
  connectedAgentEarlier,
  formatClockTime,
  operationRow,
  sessionQuestions,
  type HostClient,
} from "@opensteer/client/host";
import type { useConnectedAgentHistory, useConnectedAgentWork } from "@opensteer/client/react";
import { View } from "react-native";
import {
  OperationRequestCard,
  OperationRowView,
  SessionQuestionCard,
} from "../thread/agent-session.js";
import { operationRequestsOf } from "../thread/agent-session-model.js";
import { ConnectedAgentLine } from "../thread/connected-agent-line.js";
import { space } from "../theme.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";

export function connectedAgentWorkSections({
  host,
  deploymentId,
  work,
  history,
  open,
}: {
  readonly host: HostClient;
  readonly deploymentId: string;
  readonly work: ReturnType<typeof useConnectedAgentWork>;
  readonly history: ReturnType<typeof useConnectedAgentHistory>;
  readonly open: (threadId: string, requestId?: string) => void;
}): NativeSettingsSection[] {
  const now = work.view.agents.map((entry): NativeSettingsRow => {
    const thread = work.tasks.find(({ id }) => id === entry.threadId)!;
    const request = entry.waiting?.request;
    const item = request
      ? operationRequestsOf({ threads: [thread] }, thread.id, [request])[0]
      : undefined;
    const places = entry.places
      .map(({ name, device }) =>
        device && device.name !== name ? `${name} · ${device.name}` : name,
      )
      .join(" · ");
    const needsYou = entry.state === "needs-you";
    return {
      key: entry.sessionId,
      kind: "content",
      label: thread.title,
      content: (
        <View style={{ gap: space[12], width: "100%" }}>
          <ConnectedAgentLine
            agent={entry.agent}
            detail={[places, needsYou ? "Needs you" : "Working"].filter(Boolean).join(" · ")}
            host={host}
            needsYou={needsYou}
            onOpen={() => open(thread.id, request?.id)}
            sessionId={entry.sessionId}
            threadId={thread.id}
            title={thread.title}
          />
          {item ? (
            <OperationRequestCard hostClient={host} item={item} />
          ) : request && sessionQuestions([request]).length ? (
            <SessionQuestionCard hostClient={host} deploymentId={deploymentId} request={request} />
          ) : null}
          {work.activity?.get(thread.id)?.map((operation) => (
            <OperationRowView key={operation.id} row={operationRow(operation)} showModeAndTime />
          ))}
        </View>
      ),
    };
  });

  const earlier: NativeSettingsRow[] = [];
  if (history.page) {
    const days = connectedAgentEarlier({
      operations: history.page.operations,
      activeSessionIds: new Set(work.view.agents.map(({ sessionId }) => sessionId)),
      hasEarlier: history.page.nextBefore !== null,
    });
    for (const day of days) {
      earlier.push({ kind: "text", key: day.day, label: day.label });
      for (const session of day.sessions) {
        const count = session.actionCount;
        const where =
          count === null
            ? session.place
            : `${session.place} · ${count} ${count === 1 ? "action" : "actions"}`;
        earlier.push({
          kind: "button",
          key: session.sessionId,
          label: `${where} · ${formatClockTime(session.at)}`,
          detail: `${session.action} · ${session.outcome}`,
          opens: true,
          onPress: () => open(session.threadId),
        });
      }
    }
    if (history.page.nextBefore) {
      earlier.push({
        kind: "button",
        key: "more",
        label: history.loadingMore ? "Loading…" : "Show earlier",
        disabled: history.loadingMore,
        onPress: () => void history.showEarlier(),
      });
    }
  }
  if (history.failed)
    earlier.push({
      kind: "text",
      key: "failed",
      label: "Couldn’t load earlier activity.",
    });
  const sections: NativeSettingsSection[] = [];
  if (now.length) sections.push({ key: "now", title: "Now", rows: now });
  if (earlier.length) sections.push({ key: "earlier", title: "Earlier", rows: earlier });
  return sections;
}
