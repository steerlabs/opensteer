import {
  arrivedConnection,
  connectionDetail,
  externalAgentGuides,
  externalAgentsReach,
  guideAddress,
  type ExternalAgentGuide,
} from "@opensteer/client/host";
import { useConnectedAgents, usePersonalRemoteAccess } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { useRef, useState, type ReactNode } from "react";
import { Alert } from "react-native";
import { useMobileState } from "../ui/mobile-client-context.js";
import { ExternalAgentSetupSheet } from "./external-agent-setup-sheet.js";
import { externalAgentsFootnote, externalAgentsNeedsRemote } from "./external-agents-model.js";
import { ExternalAgentsForm } from "./settings-external-agents-form.js";
import type { ExternalAgentsFormProps } from "./settings-external-agents-form.types.js";
import { SettingsPageLayout } from "./settings-page-layout.js";
import { useSettingsHost } from "./use-settings-host.js";

/** Agents Opensteer did not launch, reaching this Deployment through its MCP server. */
export function ExternalAgentsSettingsController(): ReactNode {
  const navigation = useNavigation();
  const { selection } = useMobileState();
  const host = selection.hostClient;
  const snapshot = useSettingsHost(host);
  const personal = snapshot?.deploymentPolicy?.ownership === "single-user";
  // Both read only while this page is open, never on attach.
  const agents = useConnectedAgents(host);
  const remote = usePersonalRemoteAccess(personal ? host : null);
  const reach = externalAgentsReach({ identity: snapshot?.identityConfig ?? null, remote });
  const [guide, setGuide] = useState<ExternalAgentGuide | null>(null);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const connections = agents.connections;
  // A confirmation answered later reads the pending revoke as it is then.
  const pending = useRef(agents.pending);
  pending.current = agents.pending;
  const arrived = guide === null ? null : arrivedConnection(connections, baseline);
  const openRemoteAccess = () => {
    setGuide(null);
    if (selection.deploymentId)
      navigation.navigate("SettingsRemoteAccess", { deploymentId: selection.deploymentId });
  };
  const workspaces = snapshot?.workspaces ?? [];
  const remove = (connectionId: string) => {
    const connection = connections?.find((row) => row.id === connectionId);
    if (!connection || pending.current !== null) return;
    Alert.alert(
      `Remove ${connection.label}?`,
      "It loses access to Opensteer right away, even in a conversation it has open.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            // The client takes one revoke at a time; never let a confirmation pass silently.
            if (pending.current !== null)
              Alert.alert(
                `${connection.label} wasn’t removed`,
                "Another removal was still finishing. Remove it again.",
              );
            else void agents.revoke?.(connectionId);
          },
        },
      ],
    );
  };
  const loadError = connections === null ? agents.error : null;
  const notice: ExternalAgentsFormProps["notice"] =
    loadError !== null
      ? {
          title: "Your agents couldn’t be loaded",
          detail: loadError,
          action: { label: "Try again", onPress: () => void agents.refresh?.() },
        }
      : reach.kind === "needs-remote"
        ? {
            title: "Remote access is off",
            detail: externalAgentsNeedsRemote,
            action: { label: "Open Remote access", onPress: openRemoteAccess },
          }
        : reach.kind === "unavailable"
          ? { title: "Remote access couldn’t be checked", detail: reach.detail, action: null }
          : null;
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
          addDisabled={connections === null || reach.kind !== "ready"}
          error={loadError === null ? agents.error : null}
          footnote={personal ? externalAgentsFootnote : null}
          guides={externalAgentGuides}
          notice={notice}
          onAdd={(next) => {
            // Setup starts from the loaded list, so a later arrival is the new agent.
            if (connections === null || reach.kind !== "ready") return;
            setBaseline(new Set(connections.map((connection) => connection.id)));
            setGuide(next);
          }}
          removeDisabled={agents.pending !== null}
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
