import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  computerConnectionsOn,
  type IntegrationAccess,
  type IntegrationConnectionSummary,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/client/integrations";
import type { MachineSummary } from "@opensteer/protocol";
import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Linking, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import { FailureText, useBlockActions } from "../computers/block-actions.js";
import { color, space } from "../theme.js";
import { appear, exit } from "../ui/motion.js";
import {
  AppText,
  Notice,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  StatusDot,
  Toggle,
} from "../ui/primitives.js";
import { IphoneAppRow } from "./app-row.js";
import { IphoneApprovalCard } from "./approval-card.js";
import { useIphoneAppsState } from "./context.js";
import { iphonePermissionOf, type IphoneAppsController } from "./controller.js";
import {
  iphoneAllowFailure,
  iphoneAnswerFailure,
  iphoneAppIds,
  iphoneAppName,
  iphoneAppRow,
  iphoneApprovalKeyFailure,
  iphoneAppsFooter,
  iphoneDefaultAccess,
  iphoneDisclosure,
  iphoneLevels,
  iphoneRemoveMessage,
  iphoneRemoveTitle,
  iphoneStatusLine,
  iphoneTaskScope,
  iphoneUnknownChange,
  type IphoneAppRowView,
} from "./model.js";

/**
 * This iPhone, on its own Computer page: whether it is sharing right now, its
 * apps with what agents can do with each now, the requests waiting for an
 * answer here, and Remove. An app the Host or this build doesn't offer is
 * listed with why, and can't be turned on.
 *
 * Each app's switch and level act on the tap: turning on or widening asks
 * iOS when it must and stops if iOS says no, and success is the Host's answer;
 * an answer that was lost is shown as unverified until it is read back.
 * Turning off or lowering needs only the Host.
 */
export function IphoneAppsBlock(props: {
  /** False while the Host is unreachable; local removal still stops sharing. */
  readonly canRespond: boolean;
  readonly controller: IphoneAppsController;
  readonly data: {
    readonly connections: readonly IntegrationConnectionSummary[];
    readonly definitions: readonly IntegrationDefinitionSummaryView[];
  } | null;
  readonly hostClient: HostClient;
  readonly machine: MachineSummary;
  readonly onChanged: () => Promise<void>;
  /** The iPhone stopped and left this Opensteer; the page it was on is gone. */
  readonly onRemoved: () => void;
  readonly opensteer: string;
}): ReactNode {
  const { controller, hostClient, machine } = props;
  const state = useIphoneAppsState(controller);
  const { snapshot } = state;
  const { busy, failureFor, run } = useBlockActions(props.canRespond, props.onChanged);
  // What the person just switched an app to, shown until the change settles.
  const [intent, setIntent] = useState<{ readonly app: IphoneAppId; readonly on: boolean } | null>(
    null,
  );
  const [answers, setAnswers] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [removing, setRemoving] = useState(false);
  const status = iphoneStatusLine(snapshot, props.opensteer);
  const definitions = props.data?.definitions ?? [];
  const connected = computerConnectionsOn(props.data?.connections ?? [], machine.id);
  const rows = iphoneAppIds.flatMap((app) => {
    const connection = connected.find(({ definitionId }) => definitionId === app) ?? null;
    const definition = definitions.find(({ id }) => id === app) ?? null;
    const permission = iphonePermissionOf(snapshot, app);
    // Neither side knows it, and agents have none of it: there is nothing to say.
    if (definition === null && permission === null && connection === null) return [];
    return [
      {
        connectionId: connection?.id ?? null,
        definition,
        view: iphoneAppRow({
          access: connection?.computer?.access ?? null,
          app,
          change: state.changes[app] ?? null,
          connection: snapshot.connection,
          definition,
          locationAccuracy: snapshot.locationAccuracy ?? null,
          opensteer: props.opensteer,
          permission,
          queued: state.queued.includes(app),
        }),
      },
    ];
  });
  const disabled = !props.canRespond || busy !== null || removing;
  const disabledReason = !props.canRespond
    ? `${props.opensteer} can't be reached right now.`
    : busy !== null || removing
      ? "Wait for the current change to finish."
      : null;

  /** Only the Host's answer is success; why it wasn't is kept on the row by the controller. */
  const allow = (view: IphoneAppRowView, access: IntegrationAccess): void => {
    run(view.app, async () => {
      const outcome = await controller.allow({ access, app: view.app, hostClient });
      if (outcome.kind === "allowed") {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    });
  };

  const lower = (view: IphoneAppRowView): void => {
    run(view.app, async () => {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`iphone-app:${view.app}`),
        input: {
          access: "read",
          app: null,
          definitionId: view.app,
          kind: "app",
          runnerId: machine.id,
        },
        type: "integration.computer.setup.set",
      });
      if (result.type !== "integration.computer.setup.set") {
        throw new Error(`${view.name} did not change.`);
      }
    });
  };

  const toggle = (row: (typeof rows)[number], on: boolean): void => {
    const { view } = row;
    setIntent({ app: view.app, on });
    if (on) {
      allow(view, iphoneDefaultAccess(view.app, row.definition));
      return;
    }
    const connectionId = row.connectionId;
    if (connectionId === null) return;
    run(view.app, async () => {
      const result = await hostClient.dispatch({
        connectionId,
        idempotencyKey: mutationIdempotencyKey(`iphone-app-off:${view.app}`),
        type: "integration.disconnect",
      });
      if (result.type !== "integration.disconnect") {
        throw new Error(`${view.name} is still on.`);
      }
    });
  };

  const check = (view: IphoneAppRowView): void => {
    run(view.app, async () => {
      await controller.check({ app: view.app, hostClient });
    });
  };

  const answer = (setupRequestId: string, decision: "allow" | "deny"): void => {
    run(`approval:${setupRequestId}`, async () => {
      const outcome = await controller.answer({ decision, setupRequestId });
      const listed = snapshot.approvals.find(
        (approval) => approval.setupRequestId === setupRequestId,
      );
      const message = iphoneAnswerFailure(
        outcome,
        listed === undefined ? "this app" : iphoneAppName(listed.definitionId, definitions),
      );
      if (message !== null) setAnswers((current) => new Map(current).set(setupRequestId, message));
    });
  };

  const remove = (): void => {
    Alert.alert(iphoneRemoveTitle(machine.name, props.opensteer), iphoneRemoveMessage, [
      { style: "cancel", text: "Cancel" },
      {
        onPress: () => {
          setRemoving(true);
          // The iPhone stops before the Host is asked anything; the controller
          // says so if the Host could not be told.
          void controller
            .remove({ hostClient })
            .then(props.onRemoved)
            .finally(() => setRemoving(false));
        },
        style: "destructive",
        text: "Remove",
      },
    ]);
  };

  const openSettings = (): void => void Linking.openSettings().catch(() => undefined);

  return (
    <View style={styles.block}>
      <View accessibilityRole="summary" style={styles.status}>
        <StatusDot tone={status.tone} />
        <AppText role="secondary" style={styles.statusText} tone="soft">
          {status.text}
        </AppText>
      </View>

      {state.approvalKey === "failed" ? (
        <Notice
          action={{ label: "Try again", onPress: () => controller.retryApprovalKey() }}
          detail="New or wider access is approved on this iPhone, which isn't ready to approve yet."
          title={iphoneApprovalKeyFailure}
        />
      ) : null}

      <View style={styles.section}>
        <SectionLabel>Apps agents can use</SectionLabel>
        {props.data === null ? (
          <View accessibilityLabel="Loading apps" style={styles.loading}>
            <ActivityIndicator color={color.muted} />
          </View>
        ) : (
          <RowGroup>
            {rows.map((row) => {
              const { view } = row;
              const failed = state.failures[view.app] ?? null;
              const control = view.control;
              return (
                <IphoneAppRow
                  app={view.app}
                  disabledReason={disabledReason}
                  key={view.app}
                  levels={
                    view.access === null || view.change !== null
                      ? []
                      : iphoneLevels({
                          app: view.app,
                          current: view.access,
                          definition: row.definition,
                          here: view.offered,
                        })
                  }
                  line={view.line}
                  name={view.name}
                  onLevel={(level) => {
                    setIntent(null);
                    if (level.action === "lower") lower(view);
                    else allow(view, level.access);
                  }}
                  tone={view.tone}
                  trailing={
                    control.kind === "settings" ? (
                      <SecondaryButton
                        accessibilityLabel={`Open iPhone Settings for ${view.name}`}
                        compact
                        label="Settings"
                        onPress={openSettings}
                      />
                    ) : (
                      <Toggle
                        accessibilityHint={view.line}
                        accessibilityLabel={view.name}
                        disabled={disabled || !control.changeable}
                        onChange={(on) => toggle(row, on)}
                        value={
                          busy === view.app && intent?.app === view.app ? intent.on : control.on
                        }
                      />
                    )
                  }
                >
                  <Remedy
                    onAsk={() =>
                      run(view.app, async () => {
                        await controller.requestPermission(view.app);
                      })
                    }
                    onChoose={(picker) =>
                      run(view.app, async () => {
                        await (picker === "photos"
                          ? controller.choosePhotos()
                          : controller.chooseContacts());
                      })
                    }
                    onOpenSettings={openSettings}
                    view={view}
                  />
                  <Unverified
                    busy={busy === view.app}
                    disabled={disabled}
                    onCheck={() => check(view)}
                    view={view}
                  />
                  <FailureText
                    detail={
                      failureFor(view.app) ??
                      // The row's own line already says what an unoffered app
                      // lacks, and what iPhone Settings refuses an app that is off.
                      (failed === null ||
                      view.effect === "unavailable" ||
                      (failed.kind === "blocked" && view.access === null)
                        ? null
                        : iphoneAllowFailure(failed, view.name, props.opensteer))
                    }
                  />
                </IphoneAppRow>
              );
            })}
          </RowGroup>
        )}
        <AppText role="caption" tone="muted">
          {`${iphoneAppsFooter} ${iphoneDisclosure(props.opensteer)}`}
        </AppText>
      </View>

      {snapshot.approvals.length === 0 ? null : (
        <View style={styles.section}>
          <SectionLabel>Waiting for you</SectionLabel>
          <RowGroup>
            {snapshot.approvals.map((approval) => (
              <IphoneApprovalCard
                approval={approval}
                busy={
                  busy === `approval:${approval.setupRequestId}` ||
                  state.answering.includes(approval.setupRequestId)
                }
                failure={
                  failureFor(`approval:${approval.setupRequestId}`) ??
                  answers.get(approval.setupRequestId) ??
                  null
                }
                key={approval.setupRequestId}
                name={iphoneAppName(approval.definitionId, definitions)}
                onAllow={() => answer(approval.setupRequestId, "allow")}
                onDeny={() => answer(approval.setupRequestId, "deny")}
              />
            ))}
          </RowGroup>
          <AppText role="caption" tone="muted">
            {`${iphoneTaskScope} ${iphoneDisclosure(props.opensteer)}`}
          </AppText>
        </View>
      )}

      <SecondaryButton
        busy={removing}
        disabled={removing}
        label={`Remove ${machine.name}`}
        onPress={remove}
        tone="danger"
      />
    </View>
  );
}

/** A change whose answer was lost: it may have happened, and only reading the Host says. */
function Unverified(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCheck: () => void;
  readonly view: IphoneAppRowView;
}): ReactNode {
  const change = props.view.change;
  if (change?.phase !== "unknown") return null;
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.remedy}>
      <Notice
        action={{ label: "Check status", onPress: props.onCheck }}
        detail={iphoneUnknownChange(props.view.name, props.view.changeLabel ?? "")}
        title="Approval not verified"
      />
    </Animated.View>
  );
}

/** What iPhone Settings needs, under the app it is for, with the one action that helps. */
function Remedy(props: {
  readonly onAsk: () => void;
  readonly onChoose: (picker: "contacts" | "photos") => void;
  readonly onOpenSettings: () => void;
  readonly view: IphoneAppRowView;
}): ReactNode {
  const remedy = props.view.remedy;
  if (remedy === null) return null;
  switch (remedy.kind) {
    case "settings":
      return (
        <View style={styles.remedy}>
          <Notice
            action={{ label: "Open Settings", onPress: props.onOpenSettings }}
            detail={remedy.detail}
            title={remedy.title}
          />
        </View>
      );
    case "ask":
      return (
        <View style={styles.remedy}>
          <Notice
            action={{ label: "Continue", onPress: props.onAsk }}
            detail={remedy.detail}
            title={remedy.title}
          />
        </View>
      );
    case "limited":
      return (
        <View style={styles.remedyLine}>
          <AppText role="caption" style={styles.remedyText} tone="muted">
            {remedy.detail}
          </AppText>
          <SecondaryButton
            compact
            label={remedy.choose.label}
            onPress={() => props.onChoose(remedy.choose.picker)}
          />
        </View>
      );
    case "restricted":
      return (
        <View style={styles.remedyLine}>
          <AppText role="caption" tone="muted">
            {remedy.detail}
          </AppText>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  block: { gap: space[20] },
  loading: { alignItems: "center", paddingVertical: space[24] },
  remedy: { paddingBottom: space[12], paddingHorizontal: space[16] },
  remedyLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    paddingBottom: space[12],
    paddingHorizontal: space[16],
  },
  remedyText: { flex: 1 },
  section: { gap: space[8] },
  status: { alignItems: "center", flexDirection: "row", gap: space[10] },
  statusText: { flex: 1 },
});
