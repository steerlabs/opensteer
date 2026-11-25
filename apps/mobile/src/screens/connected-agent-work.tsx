import {
  connectedAgentEarlierSection,
  connectedAgentNowSection,
  joinSentenceParts,
  phoneSentence,
  workWords,
  type HostClient,
} from "@opensteer/client/host";
import type { useConnectedAgentHistory, useConnectedAgentWork } from "@opensteer/client/react";
import { View } from "react-native";
import {
  OperationRequestCard,
  OperationRowView,
  SessionQuestionCard,
} from "../thread/agent-session.js";
import { ConnectedAgentLine } from "../thread/connected-agent-line.js";
import { AppText } from "../ui/primitives.js";
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
  const now = connectedAgentNowSection(work);
  const sections: NativeSettingsSection[] = [];
  if (now.length) {
    sections.push({
      key: "now",
      title: "Now",
      rows: now.map(({ entry, row, titleParts, detailParts, view, operation, question }) => {
        const title = phoneSentence(titleParts);
        const { activity } = view;
        return {
          key: entry.sessionId,
          kind: "content",
          label: title,
          content: (
            <View style={{ gap: space[12], width: "100%" }}>
              <ConnectedAgentLine
                agent={entry.agent}
                detail={phoneSentence(detailParts, { quoteNames: false })}
                host={host}
                needsYou={row.needsYou}
                onOpen={() => open(entry.threadId, row.requestId)}
                sessionId={entry.sessionId}
                threadId={entry.threadId}
                title={title}
              />
              {operation ? (
                <OperationRequestCard hostClient={host} item={operation} />
              ) : question ? (
                <SessionQuestionCard
                  hostClient={host}
                  deploymentId={deploymentId}
                  request={question}
                />
              ) : null}
              {activity.kind === "unavailable" ? (
                <AppText tone="muted">{workWords("work.activityUnavailable")}</AppText>
              ) : activity.rows.length ? (
                activity.rows.map((row) => (
                  <OperationRowView key={row.id} row={row} showModeAndTime />
                ))
              ) : (
                <AppText tone="muted">{workWords("work.activityEmpty")}</AppText>
              )}
            </View>
          ),
        };
      }),
    });
  }
  const earlier = connectedAgentEarlierSection(history, work.view.agents);
  if (earlier) {
    const rows: NativeSettingsRow[] = earlier.days.flatMap(({ day, label, sessions }) => [
      { kind: "text", key: day, label },
      ...sessions.map((session): NativeSettingsRow => ({
        kind: "button",
        key: session.sessionId,
        label: phoneSentence(joinSentenceParts([session.labelParts, [session.time]]), {
          quoteNames: false,
        }),
        detail: phoneSentence(session.detailParts, { quoteNames: false }),
        opens: true,
        onPress: () => open(session.threadId),
      })),
    ]);
    if (earlier.more)
      rows.push({
        kind: "button",
        key: "more",
        ...earlier.more,
        onPress: () => void history.showEarlier(),
      });
    if (earlier.error) rows.push({ kind: "text", key: "failed", label: earlier.error });
    sections.push({ key: "earlier", title: "Earlier", rows });
  }
  return sections;
}
