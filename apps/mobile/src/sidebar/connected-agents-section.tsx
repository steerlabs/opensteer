import {
  connectedAgentNowRow,
  phoneSentence,
  sessionActionParts,
  type HostClient,
} from "@opensteer/client/host";
import { useConnectedAgentRowDistinctions, useConnectedAgentWork } from "@opensteer/client/react";
import { View } from "react-native";
import { ConnectedAgentLine } from "../thread/connected-agent-line.js";
import { SectionLabel } from "../ui/primitives.js";
import { space } from "../theme.js";

export function ConnectedAgentsSection({
  host,
  onOpen,
}: {
  readonly host: HostClient;
  readonly onOpen: (threadId: string, requestId?: string) => void;
}) {
  const { view } = useConnectedAgentWork(host);
  const distinctions = useConnectedAgentRowDistinctions(host, view.agents);
  if (!view.agents.length) return null;
  return (
    <View style={{ marginBottom: space[12] }}>
      <View style={{ paddingHorizontal: space[12] }}>
        <SectionLabel>Connected agents</SectionLabel>
      </View>
      {view.agents.map((entry) => {
        const { agent, threadId, sessionId } = entry;
        const distinction = distinctions.get(sessionId);
        const row = connectedAgentNowRow(entry, null, distinction);
        return (
          <ConnectedAgentLine
            key={sessionId}
            host={host}
            agent={agent}
            threadId={threadId}
            sessionId={sessionId}
            onOpen={() => onOpen(threadId, row.requestId)}
            openLabel={phoneSentence(sessionActionParts(row.primaryAction, agent, distinction))}
            title={phoneSentence(row.nameParts, { quoteNames: true })}
            detail={phoneSentence(row.detailParts, { quoteNames: false })}
            needsYou={row.needsYou}
            distinction={distinction}
          />
        );
      })}
    </View>
  );
}
