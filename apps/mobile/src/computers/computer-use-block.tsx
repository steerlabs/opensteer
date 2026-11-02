import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  askForEachComputerUseApp,
  cancelComputerUseSetup,
  computerUseApprovalKeyStep,
  computerUseAccessLabel,
  computerUseAddAppsOn,
  computerUseAppApprovalDetail,
  computerUseAppApprovalLabel,
  computerUseAppApprovalsTitle,
  computerUseApproveOn,
  computerUseAutomaticFootnote,
  computerUseFirstRun,
  computerUseGrantLabel,
  computerUseGrantOrder,
  computerUseGrantPurpose,
  computerUseInstallOn,
  computerUseIntroduction,
  computerUsePendingAction,
  computerUseSessionTitle,
  computerUseSetUpFrom,
  computerUseSetUpFromSteps,
  computerUseSetupQuestion,
  computerUseStatusLine,
  computerUseStop,
  computerUseStops,
  computerUseStopSentence,
  computerUseTakeBack,
  computerUseTone,
  computerUseTurnOnFrom,
  computerUseUnblockOn,
  phoneUseIntroduction,
  phoneUseStatusLine,
  phoneUseTone,
  takeBackComputerUseApp,
  type ComputerUseAppRow,
  type ComputerUsePendingApp,
  type ComputerUseTone,
  type ComputerUseView,
  type ComputerUseViewer,
  type PhoneUseView,
} from "@opensteer/client/integrations";
import { useComputerUseStop } from "@opensteer/client/react";
import type { ComputerUseSessionSummary, MachineSummary } from "@opensteer/protocol";
import { type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { color, material, radius, space, touchTarget } from "../theme.js";
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
import { AppMark, MacAppIcon } from "./app-mark.js";
import { FailureText, useBlockActions } from "./block-actions.js";

/**
 * Computer use on one Mac, from the phone.
 *
 * It is the web's block read from the same shared model, so the two say the
 * same thing in the same words, minus everything only the Mac can do: the
 * macOS panels, approving or adding an app, and turning automatic approval
 * on. What the phone can do is what narrows access — Stop, Remove, Block,
 * Decline, and turning automatic approval off — which is exactly what someone
 * away from the Mac needs.
 */
export function ComputerUseBlock(props: {
  /** False while the Host is unreachable: nothing is changed on a guess. */
  readonly canRespond: boolean;
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  readonly onOpenThread: (threadId: string) => void;
  readonly view: ComputerUseView;
}): ReactNode {
  const { hostClient, machine, view } = props;
  const { busy, failureFor, run } = useBlockActions(props.canRespond, props.onChanged);
  // The phone is never the Mac: every place is named.
  const viewer: ComputerUseViewer = { here: false, machineName: machine.name };
  const state = view.state;
  const ready = state.kind === "ready";
  const automatic = view.appApproval === "automatic";
  const firstRun = computerUseFirstRun(view);
  const disabled = !props.canRespond || busy !== null;

  return (
    <View style={styles.block}>
      <View accessibilityRole="summary" style={styles.status}>
        <ToneDot tone={computerUseTone(view)} />
        <AppText role="secondary" style={styles.statusText} tone="soft">
          {computerUseStatusLine(view, viewer)}
        </AppText>
      </View>

      {state.kind === "permission-required" || firstRun ? (
        <AppText role="secondary" tone="muted">
          {computerUseIntroduction(viewer)}
        </AppText>
      ) : null}

      {state.kind === "unavailable" ? (
        <AppText role="secondary" tone="muted">
          {computerUseInstallOn(machine.name)}
        </AppText>
      ) : null}

      {(state.kind === "ready" || state.kind === "permission-required") &&
      view.approvalKeyId === null ? (
        <Notice
          detail={computerUseApprovalKeyStep(viewer)}
          title="App approvals need setup"
          tone="neutral"
        />
      ) : null}

      {state.kind === "permission-required" ? (
        <View style={styles.section}>
          <RowGroup>
            {computerUseGrantOrder.map((grant) => {
              const done = !state.missing.includes(grant);
              return (
                <View
                  accessibilityLabel={`${computerUseGrantLabel[grant]}, ${done ? "on" : "off"}`}
                  accessible
                  key={grant}
                  style={styles.row}
                >
                  <Symbol
                    name={done ? "checkmark.circle.fill" : "circle.dotted"}
                    size={20}
                    tint={done ? color.green : color.muted}
                  />
                  <View style={styles.rowText}>
                    <AppText role="body" tone={done ? "muted" : "default"}>
                      {computerUseGrantLabel[grant]}
                    </AppText>
                    <AppText role="secondary" tone="muted">
                      {computerUseGrantPurpose[grant]}
                    </AppText>
                  </View>
                </View>
              );
            })}
          </RowGroup>
          <Notice
            detail={computerUseSetUpFromSteps(machine.name)}
            title={computerUseSetUpFrom(machine.name)}
            tone="neutral"
          />
        </View>
      ) : null}

      {view.sessions.length > 0 ? (
        <View style={styles.section}>
          {view.sessions.map((session) => (
            <SessionRow
              canRespond={props.canRespond}
              hostClient={hostClient}
              key={session.sessionId}
              machineName={machine.name}
              onOpenThread={props.onOpenThread}
              session={session}
            />
          ))}
        </View>
      ) : null}

      {ready ? (
        <View style={styles.section}>
          <SectionLabel>
            {firstRun ? computerUseSetupQuestion : computerUseAppApprovalsTitle}
          </SectionLabel>
          <View accessibilityRole="radiogroup">
            <RowGroup>
              {(["ask", "automatic"] as const).map((choice) => {
                // Automatic is confirmed in a window on the Mac it covers, so
                // from here it can only be turned off, never on.
                const remoteOnly = choice === "automatic" && !automatic;
                return (
                  <PolicyOption
                    busy={busy === `policy:${choice}`}
                    checked={view.appApproval === choice}
                    detail={computerUseAppApprovalDetail(choice, machine.name)}
                    disabled={disabled || remoteOnly}
                    key={choice}
                    note={remoteOnly ? computerUseTurnOnFrom(machine.name) : null}
                    onPress={() => {
                      if (choice !== "ask" || view.appApproval === "ask") return;
                      run("policy:ask", () => askForEachComputerUseApp(hostClient, machine.id));
                    }}
                    title={computerUseAppApprovalLabel[choice]}
                  />
                );
              })}
            </RowGroup>
          </View>
          {automatic ? (
            <AppText role="caption" tone="muted">
              {computerUseAutomaticFootnote(view)}
            </AppText>
          ) : null}
          <FailureText detail={failureFor("policy:ask")} />
        </View>
      ) : null}

      {view.apps.length > 0 || view.pending.length > 0 ? (
        <View style={styles.section}>
          <SectionLabel>Apps</SectionLabel>
          <RowGroup>
            {[
              ...view.apps.map((row) => (
                <AppRow
                  automatic={automatic}
                  busy={busy === appKey(row.connectionId)}
                  disabled={disabled}
                  failure={failureFor(appKey(row.connectionId))}
                  hostClient={hostClient}
                  key={row.connectionId}
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
                  row={row}
                  viewer={viewer}
                />
              )),
              ...view.pending.map((pending) => (
                <PendingRow
                  busy={busy === `cancel:${pending.request.id}`}
                  disabled={disabled}
                  failure={failureFor(`cancel:${pending.request.id}`)}
                  key={pending.request.id}
                  machineName={machine.name}
                  onCancel={() =>
                    run(`cancel:${pending.request.id}`, () =>
                      cancelComputerUseSetup(hostClient, pending.request.id),
                    )
                  }
                  onOpenThread={props.onOpenThread}
                  pending={pending}
                />
              )),
            ]}
          </RowGroup>
        </View>
      ) : null}

      {ready ? (
        <AppText role="caption" tone="muted">
          {computerUseAddAppsOn(machine.name)}
        </AppText>
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
          <AppText role="caption" style={styles.where} tone="muted">
            {computerUseUnblockOn(props.viewer)}
          </AppText>
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

function PendingRow(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly failure: string | null;
  readonly machineName: string;
  readonly onCancel: () => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly pending: ComputerUsePendingApp;
}): ReactNode {
  const { pending } = props;
  const name = pending.identity.displayName;
  const action = computerUsePendingAction(pending);
  const { threadId, threadTitle } = pending.request;
  return (
    <View style={styles.appRow}>
      <View style={styles.row}>
        <AppMark blocked={false} name={name} pending />
        <View style={styles.rowText}>
          <AppText numberOfLines={1} role="body" tone="soft">
            {name}
          </AppText>
          <AppText role="caption" tone="muted">
            {`${computerUseAccessLabel[pending.access]} · ${computerUseApproveOn(props.machineName)}`}
          </AppText>
          {threadId ? (
            <Pressable
              accessibilityHint="Opens the thread"
              accessibilityRole="link"
              // A caption line is 18 points; the slop makes it a whole target.
              hitSlop={{ bottom: 13, left: space[8], right: space[8], top: 13 }}
              onPress={() => props.onOpenThread(threadId)}
            >
              <AppText numberOfLines={1} role="caption" tone="ember">
                {`Asked in ${threadTitle ?? "Untitled thread"}`}
              </AppText>
            </Pressable>
          ) : null}
        </View>
        <SecondaryButton
          accessibilityLabel={`${action.label} ${name}`}
          busy={props.busy}
          compact
          disabled={props.disabled}
          label={action.label}
          onPress={props.onCancel}
        />
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
