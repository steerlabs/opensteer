import {
  canRespondToRequests,
  mutationIdempotencyKey,
  pluginAvailableIn,
  pluginContents,
  pluginSummaries,
  pluginVersionLabel,
  sameStableHostSnapshot,
  unwrapRpcResult,
  type HostClient,
  type PluginSummary,
  type WorkspaceSummary,
} from "@opensteer/client/host";
import { useHostRead, useHostSnapshot } from "@opensteer/client/react";
import { WorkspaceIdSchema } from "@opensteer/core";
import type { StaticScreenProps } from "@react-navigation/native";
import { useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { localMcpSecretsToSend, setLocalMcpServerSecrets } from "@opensteer/client/integrations";
import { operationDetail } from "../client/mobile-client.js";
import { LocalMcpSecretFields } from "../computers/local-mcp-secret-fields.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { ChoiceMenu } from "../ui/choice-menu.js";
import {
  AppText,
  Field,
  monoFontFamily,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  Toggle,
} from "../ui/primitives.js";
import { Screen, useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";
import { WorkspaceMark } from "../ui/workspace-mark.js";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";

export type PluginsDestination = { readonly deploymentId: string };

/**
 * Settings → Plugins, as the web's: a plugin is a folder of skills, tools and
 * sometimes a specialist. An administrator installs it once for this
 * Opensteer, from a folder on its computer; it does nothing until it is
 * turned on in Main or a project. Everyone else is told who manages them, and
 * a project's owner turns them on from that project's settings.
 */
export function PluginsScreen({ route }: StaticScreenProps<PluginsDestination>): ReactNode {
  const { deploymentId } = route.params;
  const hostClient = useAttachedHost(deploymentId);
  if (hostClient === null) return <DeploymentGate deploymentId={deploymentId} />;
  return <Plugins hostClient={hostClient} key={deploymentId} />;
}

function Plugins(props: { readonly hostClient: HostClient }): ReactNode {
  const { hostClient } = props;
  const column = useReadingColumn();
  const insets = useListContentInsets(space[32]);
  const { snapshot } = useHostSnapshot(hostClient, sameStableHostSnapshot);
  const administrator = snapshot.user?.instanceRole === "administrator";
  const connected = canRespondToRequests(snapshot);
  const plugins = useHostRead(
    administrator
      ? () =>
          hostClient.rpc["plugin.list"]({})
            .then(unwrapRpcResult)
            .then(({ plugins }) => pluginSummaries(plugins))
      : null,
    `plugins:${snapshot.user?.id ?? ""}`,
  );
  const computerName = snapshot.identityConfig?.deployment.name ?? "the computer Opensteer runs on";

  return (
    <Screen edgeToEdge>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.content, column, insets]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <AppText role="secondary" tone="muted">
          {`Skills, tools and specialists for your agents, packaged as folders on ${computerName}. Install one here, then turn it on where it’s needed.`}
        </AppText>
        {snapshot.user === null ? null : !administrator ? (
          <Notice
            detail={`Ask whoever runs ${computerName} to install one. An owner can turn installed plugins on in their project from its settings.`}
            title="An administrator manages plugins"
            tone="neutral"
          />
        ) : (
          <>
            {connected ? null : (
              <Notice
                detail="This screen shows what it last read, and changes wait until it’s back."
                title="Opensteer can’t be reached right now"
                tone="neutral"
              />
            )}
            <InstallPlugin
              computers={snapshot.machines.filter(({ computerUse }) => computerUse !== null)}
              connected={connected}
              hostClient={hostClient}
              onInstalled={plugins.reload}
            />
            <View style={styles.section}>
              <SectionLabel>Installed</SectionLabel>
              {plugins.data === null ? (
                plugins.error === null ? (
                  <View accessibilityLabel="Loading plugins" style={styles.loading}>
                    <ActivityIndicator color={color.muted} />
                  </View>
                ) : (
                  <Notice
                    action={{ label: "Try again", onPress: plugins.reload }}
                    detail={operationDetail(plugins.error, "Check the connection and try again.")}
                    title="Couldn’t read plugins"
                  />
                )
              ) : plugins.data.length === 0 ? (
                <View style={styles.empty}>
                  <AppText role="secondary" tone="muted">
                    Nothing installed yet. Agents can also add plugins inside their own project.
                  </AppText>
                </View>
              ) : (
                plugins.data.map((plugin) => (
                  <PluginCard
                    connected={connected}
                    hostClient={hostClient}
                    key={plugin.id}
                    onChanged={plugins.reload}
                    plugin={plugin}
                    workspaces={snapshot.workspaces}
                  />
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function InstallPlugin(props: {
  readonly computers: readonly { readonly id: string; readonly name: string }[];
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly onInstalled: () => void;
}): ReactNode {
  const [directory, setDirectory] = useState("");
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<{ readonly skipped: readonly string[] } | null>(null);
  const folder = directory.trim();
  const runsOn = props.computers.find(({ id }) => id === runnerId) ?? null;
  const install = (): void => {
    if (folder === "" || pending || !props.connected) return;
    setPending(true);
    setFailure(null);
    setResult(null);
    void props.hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey("plugin-install"),
        input: { directory: folder, ...(runnerId === null ? {} : { runnerId }) },
        type: "plugin.install",
      })
      .then((installed) => {
        if (installed.type !== "plugin.install") throw new Error("Plugin command mismatch.");
        setResult({
          skipped: installed.issues.map(
            ({ component, entry, message }) => `${entry ?? component}: ${message}`,
          ),
        });
        setDirectory("");
        AccessibilityInfo.announceForAccessibility("Plugin installed");
        props.onInstalled();
      })
      .catch((error: unknown) =>
        setFailure(operationDetail(error, "The plugin wasn’t installed. Check the folder.")),
      )
      .finally(() => setPending(false));
  };
  return (
    <View style={styles.section}>
      <SectionLabel>Install from a folder</SectionLabel>
      <View style={styles.form}>
        <Field
          hint="The full path to a plugin package on the computer Opensteer runs on. Programs it starts run only after that computer’s owner approves them."
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            editable: !pending,
            onChangeText: setDirectory,
            onSubmitEditing: install,
            placeholder: "/Users/you/plugins/tinycrm",
            returnKeyType: "go",
            spellCheck: false,
            value: directory,
          }}
          label="Folder"
        />
        {props.computers.length === 0 ? null : (
          <View style={styles.runsOn}>
            <AppText role="secondaryMedium" tone="soft" style={styles.grow}>
              Programs run on
            </AppText>
            <ChoiceMenu
              accessibilityLabel={`Programs run on ${runsOn?.name ?? "the Main computer"}. Change`}
              choices={[
                { id: "", title: "The Main computer" },
                ...props.computers.map(({ id, name }) => ({ id, title: name })),
              ]}
              disabled={pending}
              label={runsOn?.name ?? "The Main computer"}
              onChoose={(id) => setRunnerId(id === "" ? null : id)}
            />
          </View>
        )}
        <PrimaryButton
          busy={pending}
          disabled={folder === "" || !props.connected}
          label="Install plugin"
          onPress={install}
        />
        {failure === null ? null : <ErrorLine detail={failure} />}
        {result === null ? null : result.skipped.length === 0 ? (
          <AppText role="secondary" tone="soft">
            Plugin installed. Turn it on where it’s needed below.
          </AppText>
        ) : (
          <Notice
            detail={result.skipped.slice(0, 5).join("\n")}
            title={`Installed without ${
              result.skipped.length === 1 ? "one part" : `${result.skipped.length} parts`
            }`}
            tone="neutral"
          />
        )}
      </View>
    </View>
  );
}

function PluginCard(props: {
  readonly connected: boolean;
  readonly hostClient: HostClient;
  readonly onChanged: () => void;
  readonly plugin: PluginSummary;
  readonly workspaces: readonly WorkspaceSummary[];
}): ReactNode {
  const { connected, hostClient, plugin } = props;
  const [open, setOpen] = useState(false);
  const [changingSecrets, setChangingSecrets] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const places = props.workspaces.filter(
    (workspace) => workspace.status !== "deleted" && pluginAvailableIn(plugin, workspace.id),
  );
  const onIn = places.filter((workspace) => plugin.activeIn.includes(workspace.id));
  const owner = plugin.workspaceId
    ? props.workspaces.find((workspace) => workspace.id === plugin.workspaceId)
    : null;
  const run = (key: string, action: () => Promise<unknown>, said?: string): void => {
    if (pending !== null) return;
    setPending(key);
    setFailure(null);
    setDone(null);
    void action()
      .then(() => {
        if (said !== undefined) {
          setDone(said);
          AccessibilityInfo.announceForAccessibility(said);
        }
        props.onChanged();
      })
      .catch((error: unknown) => setFailure(operationDetail(error, "That didn’t save. Try again.")))
      .finally(() => setPending(null));
  };
  const remove = () =>
    Alert.alert(
      `Remove ${plugin.name}?`,
      `${
        onIn.length > 0 ? `It turns off in ${onIn.map(placeName).join(", ")}. ` : ""
      }Its skills and tools leave every agent, and any specialist made from it is removed. The folder on disk stays where it is.`,
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () =>
            run("remove", () =>
              hostClient.dispatch({
                idempotencyKey: mutationIdempotencyKey(`plugin-remove:${plugin.id}`),
                pluginId: plugin.id,
                type: "plugin.remove",
              }),
            ),
          style: "destructive",
          text: "Remove plugin",
        },
      ],
    );
  const where =
    onIn.length === 0
      ? "Off everywhere"
      : `On in ${onIn.slice(0, 3).map(placeName).join(", ")}${
          onIn.length > 3 ? ` and ${onIn.length - 3} more` : ""
        }`;
  return (
    <View style={styles.card}>
      <View style={styles.cardBody}>
        <View style={styles.titleLine}>
          <Symbol name="puzzlepiece.extension" size={16} tint={color.textSoft} />
          <AppText numberOfLines={1} role="bodyMedium" style={styles.grow}>
            {plugin.name}
          </AppText>
          {plugin.specialist ? (
            <View style={styles.tag}>
              <AppText role="caption" tone="soft">
                Specialist
              </AppText>
            </View>
          ) : null}
        </View>
        <AppText role="caption" tone="muted">
          {[
            pluginVersionLabel(plugin),
            pluginContents(plugin),
            owner ? `Added by an agent in ${owner.name}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </AppText>
        {plugin.description === null ? null : (
          <AppText role="secondary" tone="soft">
            {plugin.description}
          </AppText>
        )}
        {/* Cut from its start, so the folder's own name stays in view. */}
        {plugin.directory === null ? null : (
          <AppText
            ellipsizeMode="head"
            numberOfLines={1}
            role="caption"
            selectable
            style={styles.path}
            tone="muted"
          >
            {plugin.directory}
          </AppText>
        )}
        <View style={styles.actions}>
          <SecondaryButton
            accessibilityLabel={
              plugin.directory === null
                ? `Update ${plugin.name}, unavailable: its folder is unknown`
                : `Update ${plugin.name} from its folder`
            }
            busy={pending === "update"}
            compact
            disabled={!connected || plugin.directory === null || pending !== null}
            label="Update"
            onPress={() =>
              run(
                "update",
                () =>
                  hostClient.dispatch({
                    idempotencyKey: mutationIdempotencyKey(`plugin-update:${plugin.id}`),
                    input: { directory: plugin.directory! },
                    pluginId: plugin.id,
                    type: "plugin.update",
                  }),
                `${plugin.name} updated`,
              )
            }
          />
          {plugin.secretServers.length > 0 ? (
            <SecondaryButton
              accessibilityLabel={`Change ${plugin.name}’s secrets`}
              compact
              disabled={!connected || pending !== null}
              label="Secrets"
              onPress={() => setChangingSecrets(true)}
            />
          ) : null}
          <SecondaryButton
            busy={pending === "remove"}
            compact
            disabled={!connected || pending !== null}
            label="Remove"
            onPress={remove}
            tone="danger"
          />
        </View>
        {changingSecrets ? (
          <ChangeSecretsSheet
            hostClient={hostClient}
            onClose={() => setChangingSecrets(false)}
            onSaved={() => {
              setChangingSecrets(false);
              const said = `${plugin.name}’s secrets changed`;
              setDone(said);
              AccessibilityInfo.announceForAccessibility(said);
              props.onChanged();
            }}
            plugin={plugin}
          />
        ) : null}
        {done === null ? null : (
          <AppText role="caption" tone="soft">
            {done}
          </AppText>
        )}
        <ErrorLine detail={failure} />
      </View>
      <Pressable
        accessibilityLabel={`${where}. ${open ? "Hide" : "Show"} where ${plugin.name} can be on`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [styles.where, pressed && styles.pressed]}
      >
        <Symbol name={open ? "chevron.down" : "chevron.right"} size={12} tint={color.muted} />
        <AppText numberOfLines={1} role="secondary" style={styles.grow} tone="soft">
          {where}
        </AppText>
      </Pressable>
      {open ? (
        <RowGroup>
          {places.map((workspace) => {
            const key = `activation:${workspace.id}`;
            return (
              <View key={workspace.id} style={styles.place}>
                <WorkspaceMark
                  color={workspace.color}
                  icon={workspace.icon}
                  name={placeName(workspace)}
                  size="mini"
                />
                <AppText numberOfLines={1} role="body" style={styles.grow}>
                  {placeName(workspace)}
                </AppText>
                <Toggle
                  accessibilityLabel={`${plugin.name} on in ${placeName(workspace)}`}
                  disabled={!connected || workspace.status !== "ready" || pending !== null}
                  onChange={(active) =>
                    run(key, () =>
                      hostClient.dispatch({
                        active,
                        idempotencyKey: mutationIdempotencyKey(
                          `plugin-activation:${plugin.id}:${workspace.id}`,
                        ),
                        pluginId: plugin.id,
                        type: "plugin.activation.set",
                        workspaceId: WorkspaceIdSchema.parse(workspace.id),
                      }),
                    )
                  }
                  value={plugin.activeIn.includes(workspace.id)}
                />
              </View>
            );
          })}
        </RowGroup>
      ) : null}
    </View>
  );
}

/** New values for the secrets its computer's owner entered when approving its servers. */
function ChangeSecretsSheet(props: {
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly plugin: PluginSummary;
}): ReactNode {
  const [values, setValues] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>(
    {},
  );
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = () => {
    const changes = [];
    for (const server of props.plugin.secretServers) {
      const entered = localMcpSecretsToSend(
        server.secrets.map((secret) => ({ ...secret, saved: true })),
        values[server.id] ?? {},
      );
      if (!entered.ok) {
        setFailure(entered.message);
        return;
      }
      if (Object.keys(entered.secrets).length > 0) changes.push({ id: server.id, ...entered });
    }
    if (changes.length === 0) {
      setFailure("Enter a new value to change.");
      return;
    }
    setPending(true);
    setFailure(null);
    void Promise.all(
      changes.map(({ id, secrets }) => setLocalMcpServerSecrets(props.hostClient, id, secrets)),
    )
      .then(props.onSaved)
      .catch((error: unknown) => setFailure(operationDetail(error, "That didn’t save. Try again.")))
      .finally(() => setPending(false));
  };
  return (
    <Modal
      visible
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!pending) props.onClose();
      }}
    >
      <View style={styles.sheet}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <AppText role="title">{`${props.plugin.name}’s secrets`}</AppText>
          <AppText role="secondary" tone="soft">
            Enter only what changed. Its programs restart with the new values. Only the owner of the
            computer that runs them can change these.
          </AppText>
          {props.plugin.secretServers.map((server) => (
            <View key={server.id}>
              {props.plugin.secretServers.length > 1 ? (
                <SectionLabel>{server.name}</SectionLabel>
              ) : null}
              <LocalMcpSecretFields
                disabled={pending}
                fields={server.secrets.map((secret) => ({ ...secret, saved: true }))}
                onChange={(name, value) =>
                  setValues((current) => ({
                    ...current,
                    [server.id]: { ...current[server.id], [name]: value },
                  }))
                }
                values={values[server.id] ?? {}}
              />
            </View>
          ))}
          <ErrorLine detail={failure} />
        </ScrollView>
        <SecondaryButton disabled={pending} label="Cancel" onPress={props.onClose} />
        <PrimaryButton busy={pending} disabled={pending} label="Save" onPress={save} />
      </View>
    </Modal>
  );
}

function placeName(workspace: Pick<WorkspaceSummary, "kind" | "name">): string {
  return workspace.kind === "main" ? "Main" : workspace.name;
}

function ErrorLine(props: { readonly detail: string | null }): ReactNode {
  return props.detail === null ? null : (
    <View accessibilityLiveRegion="assertive" accessibilityRole="alert">
      <AppText role="secondary" tone="danger">
        {props.detail}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: space[8], marginTop: space[4] },
  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  cardBody: { gap: space[4], padding: space[16] },
  sheet: {
    backgroundColor: color.background,
    flex: 1,
    gap: space[12],
    padding: space[24],
    paddingTop: space[48],
  },
  content: { gap: space[24], paddingTop: space[16] },
  empty: { paddingVertical: space[12] },
  form: { gap: space[16] },
  grow: { flex: 1, minWidth: 0 },
  loading: { alignItems: "flex-start", paddingVertical: space[16] },
  path: { fontFamily: monoFontFamily },
  place: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[16],
  },
  pressed: { backgroundColor: color.surfacePressed },
  runsOn: { alignItems: "center", flexDirection: "row", gap: space[12] },
  section: { gap: space[12] },
  tag: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    paddingHorizontal: space[8],
    paddingVertical: space[2],
  },
  titleLine: { alignItems: "center", flexDirection: "row", gap: space[8] },
  where: {
    alignItems: "center",
    borderColor: color.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
  },
});
