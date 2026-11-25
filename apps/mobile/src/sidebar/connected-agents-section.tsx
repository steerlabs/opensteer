import { connectedAgentNamePart, phoneSentence, type HostClient } from "@opensteer/client/host";
import { useActiveConnectedAgentSessions } from "@opensteer/client/react";
import { View } from "react-native";
import { ConnectedAgentLine } from "../thread/connected-agent-line.js";
import { SectionLabel } from "../ui/primitives.js";
import { space } from "../theme.js";

export function ConnectedAgentsSection({
  host,
  onOpen,
}: {
  readonly host: HostClient;
  readonly onOpen: (threadId: string) => void;
}) {
  const { view } = useActiveConnectedAgentSessions(host);
  if (!view.agents.length) return null;
  return (
    <View style={{ marginBottom: space[12] }}>
      <View style={{ paddingHorizontal: space[12] }}>
        <SectionLabel>Connected agents</SectionLabel>
      </View>
      {view.agents.map(({ agent, threadId, sessionId, state, action }) => (
        <ConnectedAgentLine
          key={sessionId}
          host={host}
          agent={agent}
          threadId={threadId}
          sessionId={sessionId}
          onOpen={() => onOpen(threadId)}
          title={phoneSentence([connectedAgentNamePart(agent)])}
          detail={
            state === "needs-you" ? ["Needs you", action].filter(Boolean).join(" · ") : "Working"
          }
          needsYou={state === "needs-you"}
        />
      ))}
    </View>
  );
}
