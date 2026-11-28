import {
  agentHomeName,
  agentWords,
  arrivedConnection,
  connectedAgentsView,
  externalAgentGuides,
  externalAgentsReach,
  guideAddress,
  phoneSentence,
  connectedAgentNamePart,
  type ConnectedAgentRow,
  type ExternalAgentGuide,
} from "@opensteer/client/host";
import { useConnectedAgents, usePersonalRemoteAccess } from "@opensteer/client/react";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useState, type ReactNode } from "react";
import { useMobileState } from "../ui/mobile-client-context.js";
import { ExternalAgentMark } from "./external-agent-mark.js";
import { ExternalAgentSetupSheet } from "./external-agent-setup-sheet.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import { readGateSections } from "./read-gate-sections.js";
import type { NativeSettingsRow, NativeSettingsSection } from "./native-settings-page.types.js";
import { useSettingsHost } from "./use-settings-host.js";

/**
 * Connected agents: who is connected and what each can use, those whose Disconnect
 * outcome still shows, and how to add one. The list is the shared view model web
 * draws, read only while this page is open.
 */
export function ExternalAgentsSettingsController(): ReactNode {
  const navigation = useNavigation();
  const { selection } = useMobileState();
  const host = selection.hostClient;
  const deploymentId = selection.deploymentId;
  const snapshot = useSettingsHost(host);
  const personal = snapshot !== null && snapshot.identityConfig?.exposure !== "networked";
  const agents = useConnectedAgents(host);
  const remote = usePersonalRemoteAccess(personal ? host : null);
  const reach = externalAgentsReach({ identity: snapshot?.identityConfig ?? null, remote });
  const [guide, setGuide] = useState<ExternalAgentGuide | null>(null);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const connections = agents.connections;
  const arrived = guide === null ? null : arrivedConnection(connections, baseline);
  const names = { profiles: host?.getSnapshot().browserProfiles ?? [] };
  const view = connectedAgentsView(connections ?? [], names, agents.revoked);
  // A list read before whose refresh failed changes nothing until it is read again
  // (`readGateSections`): no setup starts against it, and one open closes.
  const readFailed = agents.readFailed && connections !== null;
  useEffect(() => {
    if (!readFailed) return;
    setGuide(null);
    setBaseline(null);
  }, [readFailed]);
  const addDisabled = connections === null || readFailed || reach.kind !== "ready";
  const openRemoteAccess = () => {
    setGuide(null);
    if (deploymentId) navigation.navigate("SettingsAccount", { deploymentId });
  };
  const open = (row: ConnectedAgentRow) => {
    if (deploymentId) navigation.navigate("ConnectedAgent", { deploymentId, connectionId: row.id });
  };
  const agentRows = (rows: readonly ConnectedAgentRow[]) =>
    rows.map((row): NativeSettingsRow => ({
      key: row.id,
      kind: "button",
      label: phoneSentence(
        [connectedAgentNamePart({ name: row.identity.label, who: row.identity.who })],
        { quoteNames: !row.connection.bridge },
      ),
      detail: phoneSentence(row.lineParts),
      opens: true,
      lead: (
        <ExternalAgentMark initial={row.identity.initial} providerId={row.identity.providerId} />
      ),
      onPress: () => open(row),
    }));
  const unreadable = connections === null && agents.error !== null;
  const sections: NativeSettingsSection[] = [
    { key: "lead", title: "", rows: [], footer: { text: agentWords("agents.lead") } },
  ];
  if (connections === null)
    sections.push({
      key: "connected",
      title: agentWords("agents.section.connected"),
      rows: unreadable
        ? []
        : [0, 1, 2].map((index) => ({
            key: `placeholder-${index}`,
            kind: "placeholder" as const,
            label: agentWords("common.loading"),
          })),
      ...(unreadable
        ? {
            footer: {
              text: agentWords("agents.unreadable"),
              tone: "danger" as const,
              link: {
                label: agentWords("common.tryAgain"),
                onPress: () => void agents.refresh?.(),
              },
            },
          }
        : {}),
    });
  if (view.connected.length)
    sections.push({
      key: "connected",
      title: agentWords("agents.section.connected"),
      rows: agentRows(view.connected),
    });
  if (view.disconnected.length)
    sections.push({
      key: "disconnected",
      title: agentWords("agents.section.disconnected"),
      rows: agentRows(view.disconnected),
    });
  if (reach.kind === "needs-remote" || reach.kind === "unavailable")
    sections.push({
      key: "notice",
      title: "",
      rows: [
        {
          key: "notice",
          kind: "text",
          label:
            reach.kind === "needs-remote"
              ? agentWords("remoteAccess.turnOnFirst.title")
              : agentWords("remoteAccess.unreadable"),
          detail:
            reach.kind === "needs-remote"
              ? agentWords("remoteAccess.turnOnFirst.detail")
              : reach.detail,
        },
        ...(reach.kind === "needs-remote"
          ? [
              {
                key: "turn-on",
                kind: "button" as const,
                label: agentWords("remoteAccess.turnOnFirst.action"),
                onPress: openRemoteAccess,
              },
            ]
          : []),
      ],
    });
  sections.push({
    key: "add",
    title: agentWords("agents.section.add"),
    rows: externalAgentGuides.map((entry): NativeSettingsRow => ({
      key: entry.id,
      kind: "button",
      label: entry.name,
      detail: entry.summary,
      opens: true,
      disabled: addDisabled,
      lead: <ExternalAgentMark providerId={entry.providerId} />,
      onPress: () => {
        // Setup starts from the loaded list, so a later arrival is the new agent.
        if (connections === null || reach.kind !== "ready") return;
        setBaseline(new Set(connections.map((connection) => connection.id)));
        setGuide(entry);
      },
    })),
    ...(personal && reach.kind === "ready" && snapshot
      ? { footer: { text: agentWords("agents.reachNote", { home: agentHomeName(snapshot) }) } }
      : {}),
  });
  return (
    <>
      <NativeSettingsPage
        sections={readGateSections(sections, {
          failed: readFailed,
          retry: {
            message: agentWords("agent.readFailed"),
            onRetry: () => void agents.refresh?.(),
          },
        })}
      />
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
