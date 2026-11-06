import { externalAgentGuides, type ExternalAgentGuide } from "@opensteer/client/host";
import { useConnectedAgents, usePersonalRemoteAccess } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { useMobileState } from "../ui/mobile-client-context.js";
import { ExternalAgentSetupSheet } from "./external-agent-setup-sheet.js";
import {
  arrivedConnection,
  connectionDetail,
  externalAgentsFootnote,
  externalAgentsNeedsRemote,
  externalAgentsReach,
  guideAddress,
} from "./external-agents-model.js";
import { ExternalAgentsForm } from "./settings-external-agents-form.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useSettingsHost } from "./use-settings-host.js";

/** Agents Opensteer did not launch, reaching this Deployment through its MCP server. */
export function ExternalAgentsSettingsController(): ReactNode {
  const navigation = useNavigation();
  const { selection } = useMobileState();
  const host = selection.hostClient;
  const snapshot = useSettingsHost(host);
  const personal = snapshot?.deploymentShape?.kind === "personal";
  // Both read only while this page is open, never on attach.
  const agents = useConnectedAgents(host);
  const remote = usePersonalRemoteAccess(personal ? host : null);
  const reach = externalAgentsReach({ identity: snapshot?.identityConfig ?? null, remote });
  const [guide, setGuide] = useState<ExternalAgentGuide | null>(null);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const connections = agents.connections;
  useEffect(() => {
    if (guide !== null && baseline === null && connections !== null)
      setBaseline(new Set(connections.map((connection) => connection.id)));
  }, [baseline, connections, guide]);
  const arrived = guide === null ? null : arrivedConnection(connections, baseline);
  const openRemoteAccess = () => {
    setGuide(null);
    if (selection.deploymentId)
      navigation.navigate("SettingsRemoteAccess", { deploymentId: selection.deploymentId });
  };
  const workspaces = snapshot?.workspaces ?? [];
  const remove = (connectionId: string) => {
    const connection = connections?.find((row) => row.id === connectionId);
    if (!connection) return;
    Alert.alert(
      `Remove ${connection.label}?`,
      "It loses access to Opensteer right away, even in a conversation it has open.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void agents.revoke?.(connectionId) },
      ],
    );
  };
  return (
    <>
      <SettingsPageLayout>
        <ExternalAgentsForm
          connections={(connections ?? []).map((connection) => ({
            id: connection.id,
            title: connection.label,
            detail: connectionDetail(connection, workspaces),
            removing: agents.pending === connection.id,
          }))}
          error={agents.error ?? (reach.kind === "unavailable" ? reach.detail : null)}
          footnote={personal ? externalAgentsFootnote : null}
          guides={externalAgentGuides}
          notice={
            reach.kind === "needs-remote"
              ? {
                  title: "Remote access is off",
                  detail: externalAgentsNeedsRemote,
                  action: { label: "Open Remote access", onPress: openRemoteAccess },
                }
              : null
          }
          onAdd={(next) => {
            setBaseline(
              connections === null ? null : new Set(connections.map((connection) => connection.id)),
            );
            setGuide(next);
          }}
          onRemove={remove}
        />
      </SettingsPageLayout>
      <ExternalAgentSetupSheet
        address={guide !== null && reach.kind === "ready" ? guideAddress(guide, reach) : null}
        connected={arrived}
        guide={guide}
        onClose={() => {
          setGuide(null);
          setBaseline(null);
        }}
        onRemoteAccess={openRemoteAccess}
      />
    </>
  );
}
