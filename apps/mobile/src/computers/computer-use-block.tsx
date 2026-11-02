import { ActivityIndicator, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import {
  AppText,
  Notice,
  ChoiceRow,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  StatusDot,
} from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { MacAppIcon } from "./app-mark.js";
import { FailureText } from "./block-actions.js";
import { useComputerAppApproval } from "./computer-app-approval.js";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { ComputerUseInstalledApp } from "@opensteer/protocol";
import { useState } from "react";

import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  askForEachComputerUseApp,
  cancelComputerUseSetup,
  computerUseAccessLabel,
  computerUseAppApprovalDetail,
  computerUseAppApprovalLabel,
  computerUseSessionTitle,
  computerUseSetUpFromSteps,
  computerUseStatusLine,
  computerUseStop,
  computerUseStops,
  computerUseStopSentence,
  computerUseTakeBack,
  phoneUseIntroduction,
  phoneUseStatusLine,
  phoneUseTone,
  takeBackComputerUseApp,
  type ComputerUseAppRow,
  type ComputerUseTone,
  type ComputerUseView,
  type ComputerUseViewer,
  type PhoneUseView,
} from "@opensteer/client/integrations";
import { useComputerUseStop } from "@opensteer/client/react";
import type { ComputerUseSessionSummary, MachineSummary } from "@opensteer/protocol";
import { type ReactNode } from "react";
import { StyleSheet } from "react-native";
import { color, material, radius, space, touchTarget } from "../theme.js";

import { useBlockActions } from "./block-actions.js";

/** Owner approvals work here; macOS grants still require the target Mac. */
export function ComputerUseBlock(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  readonly onOpenThread: (threadId: string) => void;
  readonly view: ComputerUseView;
}): ReactNode {
  const { hostClient, machine, view } = props;
  const approval = useComputerAppApproval(hostClient);
  const { busy, failureFor, run } = useBlockActions(props.canRespond, props.onChanged);
  const [apps, setApps] = useState<readonly ComputerUseInstalledApp[] | null>(null);
  const [query, setQuery] = useState("");
  const viewer = { here: false, machineName: machine.name };
  const disabled = !props.canRespond || busy !== null || machine.ownership === "other";
  async function request(
    input:
      | {
          readonly kind: "app";
          readonly app: ComputerUseAppRow["identity"];
          readonly access: "read" | "read-write";
        }
      | { readonly kind: "policy"; readonly appApproval: "automatic" },
  ) {
    const result = await hostClient.dispatch({
      type: "integration.computer.setup.request",
      idempotencyKey: mutationIdempotencyKey(`computer-app:${machine.id}`),
      input:
        input.kind === "app"
          ? { ...input, definitionId: view.definition.id, runnerId: machine.id }
          : { ...input, runnerId: machine.id },
    });
    if (result.type !== "integration.computer.setup.request")
      throw new Error("The approval was not requested.");
    await approval.ask(result.request.id);
  }
  async function listApps(search: string) {
    const result = unwrapRpcResult(
      await hostClient.rpc["integration.computer.apps.installed"]({
        runnerId: machine.id,
        query: search,
        limit: 100,
        offset: 0,
        icons: false,
      }),
    );
    if (result.unavailableReason) throw new Error("The computer can't list apps right now.");
    setApps(result.apps);
  }
  return (
    <View style={styles.block}>
      {approval.dialog}
      <AppText role="secondary">{computerUseStatusLine(view, viewer)}</AppText>
      {view.state.kind === "permission-required" ? (
        <Notice title="macOS permissions needed" detail={computerUseSetUpFromSteps(machine.name)} />
      ) : null}
      <SecondaryButton
        label="Add app"
        disabled={disabled || view.state.kind === "offline"}
        onPress={() => run("list", () => listApps(""))}
      />
      {view.sessions.map((session) => (
        <SessionRow
          key={session.sessionId}
          canRespond={props.canRespond}
          hostClient={hostClient}
          machineName={machine.name}
          onOpenThread={props.onOpenThread}
          session={session}
        />
      ))}
      <SectionLabel>App approvals</SectionLabel>
      {(["ask", "automatic"] as const).map((choice) => (
        <PolicyOption
          key={choice}
          busy={busy === `policy:${choice}`}
          checked={view.appApproval === choice}
          detail={computerUseAppApprovalDetail(choice, machine.name)}
          disabled={disabled}
          note={null}
          title={computerUseAppApprovalLabel[choice]}
          onPress={() => {
            if (choice !== view.appApproval)
              run(`policy:${choice}`, () =>
                choice === "ask"
                  ? askForEachComputerUseApp(hostClient, machine.id)
                  : request({ kind: "policy", appApproval: "automatic" }),
              );
          }}
        />
      ))}
      {view.apps.map((row) => (
        <View key={row.connectionId}>
          <AppRow
            automatic={view.appApproval === "automatic"}
            busy={busy === appKey(row.connectionId)}
            disabled={disabled}
            failure={failureFor(appKey(row.connectionId))}
            hostClient={hostClient}
            machineId={machine.id}
            machineName={machine.name}
            onTakeBack={() =>
              run(appKey(row.connectionId), () =>
                takeBackComputerUseApp(hostClient, {
                  appApproval: view.appApproval,
                  connectionId: row.connectionId,
                }),
              )
            }
            onUnblock={() =>
              run(appKey(row.connectionId), () =>
                request({ kind: "app", app: row.identity, access: row.access }),
              )
            }
            row={row}
            viewer={viewer}
          />
          {!row.blocked ? (
            <SecondaryButton
              label={row.access === "read" ? "Allow control" : "Read only"}
              disabled={disabled}
              onPress={() =>
                run(appKey(row.connectionId), async () => {
                  if (row.access === "read")
                    await request({ kind: "app", app: row.identity, access: "read-write" });
                  else
                    await hostClient.dispatch({
                      type: "integration.computer.setup.set",
                      idempotencyKey: mutationIdempotencyKey(`computer-app:${row.connectionId}`),
                      input: {
                        kind: "app",
                        runnerId: machine.id,
                        app: row.identity,
                        definitionId: view.definition.id,
                        access: "read",
                      },
                    });
                })
              }
            />
          ) : null}
        </View>
      ))}
      {view.pending.map((pending) => (
        <View key={pending.request.id}>
          <AppText role="body">{pending.identity.displayName}</AppText>
          <AppText role="secondary">{computerUseAccessLabel[pending.request.access]}</AppText>
          {pending.request.threadTitle ? (
            <AppText role="caption">Asked in {pending.request.threadTitle}</AppText>
          ) : null}
          <SecondaryButton
            label="Review"
            disabled={disabled}
            onPress={() =>
              run(pending.request.id, async () => {
                await approval.ask(pending.request.id);
              })
            }
          />
          <SecondaryButton
            label="Decline"
            disabled={disabled}
            onPress={() =>
              run(pending.request.id, () => cancelComputerUseSetup(hostClient, pending.request.id))
            }
          />
        </View>
      ))}
      <FailureText
        detail={failureFor("list") ?? failureFor("policy:automatic") ?? failureFor("policy:ask")}
      />
      {apps !== null ? (
        <Modal visible presentationStyle="pageSheet" onRequestClose={() => setApps(null)}>
          <View
            style={{
              flex: 1,
              padding: space[24],
              paddingTop: space[48],
              backgroundColor: color.surface,
            }}
          >
            <TextInput
              accessibilityLabel="Search installed apps"
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => run("list", () => listApps(query))}
            />
            <SecondaryButton label="Search" onPress={() => run("list", () => listApps(query))} />
            <ScrollView>
              {apps.map((app) => (
                <View key={app.identity.bundleId}>
                  <AppText role="body">{app.identity.displayName}</AppText>
                  {(["read", "read-write"] as const).map((access) => (
                    <SecondaryButton
                      key={access}
                      label={computerUseAccessLabel[access]}
                      disabled={disabled}
                      onPress={() => {
                        setApps(null);
                        run(app.identity.bundleId, () =>
                          request({ kind: "app", app: app.identity, access }),
                        );
                      }}
                    />
                  ))}
                </View>
              ))}
            </ScrollView>
            <SecondaryButton label="Close" onPress={() => setApps(null)} />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

/** An Android phone's owner sets access from this client. */
export function PhoneUseBlock(props: {
  /** False while the Host is unreachable: nothing is changed on a guess. */
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  readonly onOpenThread: (threadId: string) => void;
  readonly view: PhoneUseView;
}): ReactNode {
  const { hostClient, machine, view } = props;
  const { busy, failureFor, run } = useBlockActions(props.canRespond, props.onChanged);
  const disabled = !props.canRespond || busy !== null;
  const owned = machine.ownership !== "other";

  const setAccess = (access: "read" | "read-write" | null): void => {
    run("access", async () => {
      if (access === null) {
        if (view.connectionId === null) return;
        const result = await hostClient.dispatch({
          connectionId: view.connectionId,
          idempotencyKey: mutationIdempotencyKey(`agent-phone-access:${machine.id}`),
          type: "integration.disconnect",
        });
        if (result.type !== "integration.disconnect")
          throw new Error("Phone access did not change.");
        return;
      }
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`agent-phone-access:${machine.id}`),
        input: {
          access,
          app: null,
          definitionId: "android-phone",
          kind: "app",
          runnerId: machine.id,
        },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set")
        throw new Error("Phone access did not change.");
    });
  };

  return (
    <View style={styles.block}>
      <View accessibilityRole="summary" style={styles.status}>
        <ToneDot tone={phoneUseTone(view)} />
        <AppText role="secondary" style={styles.statusText} tone="soft">
          {phoneUseStatusLine(view, machine.name)}
        </AppText>
      </View>
      {view.access === null ? (
        <AppText role="secondary" tone="muted">
          {phoneUseIntroduction}
        </AppText>
      ) : null}
      {view.session === null ? null : (
        <View style={styles.section}>
          <SessionRow
            canRespond={props.canRespond}
            hostClient={hostClient}
            machineName={machine.name}
            onOpenThread={props.onOpenThread}
            session={view.session}
          />
        </View>
      )}
      {owned ? (
        <View style={styles.section}>
          <SectionLabel>Access</SectionLabel>
          <RowGroup>
            {([null, "read", "read-write"] as const).map((access) => (
              <ChoiceRow
                description={view.access === access ? "Current access" : "Set access"}
                disabled={disabled || view.access === access}
                key={access ?? "off"}
                onPress={() => setAccess(access)}
                title={access === null ? "Off" : computerUseAccessLabel[access]}
              />
            ))}
          </RowGroup>
          <FailureText detail={failureFor("access")} />
        </View>
      ) : null}
    </View>
  );
}

function appKey(connectionId: string): string {
  return `app:${connectionId}`;
}

/** The block's tone as a dot; the agent at work is its own ember, as everywhere. */
function ToneDot(props: { readonly tone: ComputerUseTone }): ReactNode {
  switch (props.tone) {
    case "live":
      return <StatusDot live tone="ember" />;
    case "ready":
      return <StatusDot tone="green" />;
    case "attention":
      return <StatusDot tone="amber" />;
    case "idle":
      return <StatusDot tone="muted" />;
  }
}

/**
 * One live session: the agent's ember, what it holds, the task that holds it
 * — which opens that Thread — and Stop. The Stop is the same one the task's
 * own line and Watch show, so pressing it here is seen there too.
 */
function SessionRow(props: {
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly machineName: string;
  readonly onOpenThread: (threadId: string) => void;
  readonly session: ComputerUseSessionSummary;
}): ReactNode {
  const { hostClient, machineName, session } = props;
  const title = session.threadTitle ?? "Untitled thread";
  const stop = useComputerUseStop(hostClient, session.sessionId);
  const stopping = stop?.phase === "stopping" || stop?.phase === "stopped";
  return (
    <View style={styles.session}>
      <View pointerEvents="none" style={styles.sessionTint} />
      <View style={styles.sessionRow}>
        <StatusDot live tone="ember" />
        <Pressable
          accessibilityHint="Opens the thread"
          accessibilityLabel={`${computerUseSessionTitle(session)}, ${title}`}
          accessibilityRole="link"
          onPress={() => props.onOpenThread(session.threadId)}
          style={({ pressed }) => [styles.sessionText, pressed && styles.pressed]}
        >
          <AppText role="secondaryMedium">{computerUseSessionTitle(session)}</AppText>
          <AppText numberOfLines={1} role="secondary" tone="ember">
            {title}
          </AppText>
        </Pressable>
        <SecondaryButton
          {...(stopping
            ? {}
            : { accessibilityLabel: `Stop ${computerUseSessionTitle(session)} on ${machineName}` })}
          compact
          disabled={!props.canRespond || stopping}
          label={stopping ? computerUseStop.busyLabel : "Stop"}
          onPress={() =>
            computerUseStops(hostClient).stop({
              machineName,
              runId: session.runId,
              sessionId: session.sessionId,
            })
          }
          tone="danger"
        />
      </View>
      <FailureText
        detail={stop?.phase === "failed" ? (stop.message ?? computerUseStopSentence(stop)) : null}
      />
    </View>
  );
}

/** One of the two App approvals choices, as a native radio row. */
function PolicyOption(props: {
  readonly busy: boolean;
  readonly checked: boolean;
  readonly detail: string;
  readonly disabled: boolean;
  readonly note: string | null;
  readonly onPress: () => void;
  readonly title: string;
}): ReactNode {
  return (
    <Pressable
      accessibilityHint={props.note ?? undefined}
      accessibilityLabel={props.title}
      accessibilityRole="radio"
      accessibilityState={{
        busy: props.busy,
        checked: props.checked,
        disabled: props.disabled && !props.checked,
      }}
      // The chosen row stays pressable-looking but does nothing: choosing what
      // is already chosen changes nothing.
      disabled={props.disabled || props.checked}
      onPress={props.onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowText}>
        <AppText role="bodyMedium" tone={props.disabled && !props.checked ? "muted" : "default"}>
          {props.title}
        </AppText>
        <AppText role="secondary" tone="muted">
          {props.detail}
        </AppText>
        {props.note === null ? null : (
          <AppText role="caption" tone="soft">
            {props.note}
          </AppText>
        )}
      </View>
      <View style={styles.trailing}>
        {props.busy ? (
          <ActivityIndicator color={color.ember} />
        ) : props.checked ? (
          <Symbol name="checkmark" size={17} tint={color.ember} weight="semibold" />
        ) : null}
      </View>
    </Pressable>
  );
}

function AppRow(props: {
  readonly automatic: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly failure: string | null;
  readonly hostClient: HostClient;
  readonly machineId: string;
  readonly machineName: string;
  readonly onTakeBack: () => void;
  readonly onUnblock: () => void;
  readonly row: ComputerUseAppRow;
  readonly viewer: ComputerUseViewer;
}): ReactNode {
  const { row } = props;
  const name = row.identity.displayName;
  const takeBack = computerUseTakeBack({
    appApproval: props.automatic ? "automatic" : "ask",
    appName: name,
    machineName: props.machineName,
  });
  return (
    <View style={styles.appRow}>
      <View style={styles.row}>
        <MacAppIcon
          app={row.identity}
          blocked={row.blocked}
          hostClient={props.hostClient}
          machineId={props.machineId}
        />
        <View style={styles.rowText}>
          <AppText numberOfLines={1} role="body" tone={row.blocked ? "muted" : "default"}>
            {name}
          </AppText>
          <View style={styles.meta}>
            {row.blocked ? (
              <AppText role="caption" tone="danger">
                Blocked
              </AppText>
            ) : (
              <AppText role="caption" tone="muted">
                {computerUseAccessLabel[row.access]}
              </AppText>
            )}
            {row.inUse && !row.blocked ? (
              <AppText role="caption" tone="ember">
                In use
              </AppText>
            ) : null}
          </View>
        </View>
        {row.blocked ? (
          <SecondaryButton label="Unblock" disabled={props.disabled} onPress={props.onUnblock} />
        ) : (
          <SecondaryButton
            accessibilityLabel={`${takeBack.label} ${name}`}
            busy={props.busy}
            compact
            disabled={props.disabled}
            label={takeBack.label}
            onPress={props.onTakeBack}
          />
        )}
      </View>
      <FailureText detail={props.failure} />
    </View>
  );
}

const styles = StyleSheet.create({
  appRow: { gap: space[4] },
  block: { gap: space[20] },
  meta: { flexDirection: "row", flexWrap: "wrap", gap: space[8] },
  pressed: { ...material.quiet },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  rowText: { flex: 1, gap: space[2], minWidth: 0 },
  section: { gap: space[8] },
  session: {
    ...material.plate,
    borderRadius: radius.md,
    overflow: "hidden",
  },
  sessionRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingLeft: space[14],
    paddingRight: space[6],
    paddingVertical: space[6],
  },
  sessionText: { flex: 1, justifyContent: "center", minHeight: touchTarget, minWidth: 0 },
  sessionTint: {
    backgroundColor: color.emberWash,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  status: { alignItems: "center", flexDirection: "row", gap: space[10] },
  statusText: { flex: 1 },
  trailing: { alignItems: "center", justifyContent: "center", minWidth: 24 },
  where: { maxWidth: 120, textAlign: "right" },
});
