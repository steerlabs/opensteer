import {
  arrivedConnection,
  connectionDetail,
  externalAgentGuides,
  externalAgentsReach,
  guideAddress,
  type ExternalAgentGuide,
} from "@opensteer/client/host";
import { mutationIdempotencyKey, unwrapRpcResult } from "@opensteer/client/host";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import { Alert } from "react-native";
import {
  notDone,
  readLine,
  settingsFooter,
  useScreenAction,
  useScreenRead,
} from "../ui/client-feedback.js";
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
  const personal = snapshot !== null;
  // Both read only while this page is open, never on attach.
  const agents = useScreenRead(host, {
    key: "connected-agents",
    label: "your agents",
    read: host
      ? async (signal) =>
          unwrapRpcResult(await host.rpc["connections.list"]({}, { signal })).connections
      : null,
    subscribeInvalidation: (listener) => host?.subscribeConnectionsChanged(listener) ?? (() => {}),
  });
  const [removingId, setRemovingId] = useState<string | null>(null);
  const revoke = useScreenAction(host, "connection-revoke", {
    label: "remove this agent",
    done: "removed",
    happened: "this agent was removed",
    execute: async (connectionId: string) => {
      await host!.dispatch({
        type: "connection.revoke",
        connectionId,
        idempotencyKey: mutationIdempotencyKey("connection-revoke"),
      });
    },
    reconcile: async (connectionId) => {
      const { connections } = unwrapRpcResult(await host!.rpc["connections.list"]({}));
      return connections.some((row) => row.id === connectionId)
        ? notDone("removed")
        : { kind: "confirmed", value: undefined };
    },
  });
  const remote = usePersonalRemoteAccess(personal ? host : null);
  const reach = externalAgentsReach({ identity: snapshot?.identityConfig ?? null, remote });
  const [guide, setGuide] = useState<ExternalAgentGuide | null>(null);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const connections = agents.data;
  const arrived = guide === null ? null : arrivedConnection(connections, baseline);
  const openRemoteAccess = () => {
    setGuide(null);
    if (selection.deploymentId)
      navigation.navigate("SettingsAccount", { deploymentId: selection.deploymentId });
  };
  const remove = (connectionId: string) => {
    const connection = connections?.find((row) => row.id === connectionId);
    if (!connection || revoke.running) return;
    Alert.alert(
      `Remove ${connection.label}?`,
      "It loses access to Opensteer right away, even in a conversation it has open.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setRemovingId(connectionId);
            void revoke.run(connectionId).then((outcome) => {
              if (outcome.kind === "confirmed") agents.refresh();
            });
          },
        },
      ],
    );
  };
  const notice: ExternalAgentsFormProps["notice"] =
    reach.kind === "needs-remote"
      ? {
          title: "Use from anywhere is off",
          detail: externalAgentsNeedsRemote,
          action: { label: "Open Account", onPress: openRemoteAccess },
        }
      : reach.kind === "unavailable"
        ? { title: "Couldn’t check Use from anywhere", detail: reach.detail, action: null }
        : null;
  return (
    <>
      <SettingsPageLayout>
        <ExternalAgentsForm
          connections={(connections ?? []).map((connection) => ({
            id: connection.id,
            title: connection.label,
            detail: connectionDetail(connection),
            removing: revoke.running && removingId === connection.id,
          }))}
          loading={connections === null}
          addDisabled={connections === null || reach.kind !== "ready"}
          line={settingsFooter(readLine(agents, agents.refresh) ?? revoke.line) ?? null}
          footnote={personal ? externalAgentsFootnote : null}
          guides={externalAgentGuides}
          notice={notice}
          onAdd={(next) => {
            // Setup starts from the loaded list, so a later arrival is the new agent.
            if (connections === null || reach.kind !== "ready") return;
            setBaseline(new Set(connections.map((connection) => connection.id)));
            setGuide(next);
          }}
          removeDisabled={revoke.running}
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
