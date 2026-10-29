import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import {
  computerConnectionsOn,
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
} from "../ui/primitives.js";
import { IphoneAccessSheet, IphoneAppRow } from "./app-row.js";
import { IphoneApprovalCard } from "./approval-card.js";
import { useIphoneAppsState } from "./context.js";
import {
  iphonePermissionOf,
  type IphoneAllowOutcome,
  type IphoneAppsController,
} from "./controller.js";
import {
  iphoneAccessChoices,
  iphoneAllowFailure,
  iphoneAnswerFailure,
  iphoneAppIds,
  iphoneAppName,
  iphoneAppRow,
  iphoneApprovalKeyFailure,
  iphoneAppsFooter,
  iphoneDisclosure,
  iphoneRemoveMessage,
  iphoneRemoveTitle,
  iphoneReview,
  iphoneStatusLine,
  iphoneTaskScope,
  iphoneUnknownChange,
  type IphoneAccessChoice,
  type IphoneAppRowView,
} from "./model.js";

/**
 * This iPhone, on its own Computer page: whether it is sharing right now, its
 * apps with what agents can do with each now, the requests waiting for an
 * answer here, and Remove. An app the Host or this build doesn't offer is
 * listed with why, and can't be turned on.
 *
 * Access changes only through an app's sheet: a level is chosen as a draft,
 * reviewed once, and only the review's button sends it. Widening asks iOS
 * after that commit and stops if iOS says no; success is the Host's answer,
 * and an answer that was lost is shown as unverified until it is read back.
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
  const [open, setOpen] = useState<IphoneAppId | null>(null);
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
        permission,
        view: iphoneAppRow({
          access: connection?.computer?.access ?? null,
          app,
          change: state.changes[app] ?? null,
          connection: snapshot.connection,
          definition,
          locationAccuracy: snapshot.locationAccuracy ?? null,
          opensteer: props.opensteer,
          permission,
        }),
      },
    ];
  });
  const opened = open === null ? null : (rows.find(({ view }) => view.app === open) ?? null);
  const disabled = !props.canRespond || busy !== null || removing;

  /** The row's result once a reviewed change settles; only the Host's answer is success. */
  const settle = (view: IphoneAppRowView, outcome: IphoneAllowOutcome): void => {
    if (outcome.kind === "allowed") {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }
    const failure = iphoneAllowFailure(outcome, view.name, props.opensteer);
    if (failure !== null) throw new Error(failure);
  };

  const commit = (row: (typeof rows)[number], choice: IphoneAccessChoice): void => {
    setOpen(null);
    const { view } = row;
    switch (choice.action) {
      case "current":
        return;
      case "allow":
        if (choice.access === null) return;
        run(view.app, async () => {
          settle(
            view,
            await controller.allow({ access: choice.access ?? "read", app: view.app, hostClient }),
          );
        });
        return;
      case "lower":
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
        return;
      case "turn-off":
        run(view.app, async () => {
          if (row.connectionId === null) return;
          const result = await hostClient.dispatch({
            connectionId: row.connectionId,
            idempotencyKey: mutationIdempotencyKey(`iphone-app-off:${view.app}`),
            type: "integration.disconnect",
          });
          if (result.type !== "integration.disconnect") {
            throw new Error(`${view.name} is still on.`);
          }
        });
        return;
    }
  };

  const check = (view: IphoneAppRowView): void => {
    run(view.app, async () => settle(view, await controller.check({ app: view.app, hostClient })));
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
            {rows.map((row) => (
              <IphoneAppRow
                disabled={disabled || !row.view.opens}
                key={row.view.app}
                line={row.view.line}
                name={row.view.name}
                onPress={() => setOpen(row.view.app)}
                tone={row.view.tone}
              >
                <Remedy
                  onAsk={() =>
                    run(row.view.app, async () => {
                      await controller.requestPermission(row.view.app);
                    })
                  }
                  onChoose={(picker) =>
                    run(row.view.app, async () => {
                      await (picker === "photos"
                        ? controller.choosePhotos()
                        : controller.chooseContacts());
                    })
                  }
                  onOpenSettings={openSettings}
                  view={row.view}
                />
                <Unverified
                  busy={busy === row.view.app}
                  disabled={disabled}
                  onCheck={() => check(row.view)}
                  view={row.view}
                />
                <FailureText detail={failureFor(row.view.app)} />
              </IphoneAppRow>
            ))}
          </RowGroup>
        )}
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

      <AppText role="secondary" tone="muted">
        {iphoneAppsFooter}
      </AppText>

      <SecondaryButton
        busy={removing}
        disabled={removing}
        label={`Remove ${machine.name}`}
        onPress={remove}
        tone="danger"
      />

      {opened === null ? null : (
        <IphoneAccessSheet
          // A change in flight holds the sheet; an unverified one still lets
          // access be lowered or turned off, but not asked for again.
          busy={
            busy !== null || (opened.view.change !== null && opened.view.change.phase !== "unknown")
          }
          choices={iphoneAccessChoices({
            app: opened.view.app,
            current: opened.view.access,
            definition: opened.definition,
            here: opened.view.change === null && opened.view.offered,
          })}
          facts={{ access: opened.view.accessLabel, permission: opened.view.permissionLabel }}
          header={
            <Unverified
              busy={busy === opened.view.app}
              disabled={disabled}
              onCheck={() => {
                setOpen(null);
                check(opened.view);
              }}
              view={opened.view}
            />
          }
          name={opened.view.name}
          onClose={() => setOpen(null)}
          onCommit={(choice) => commit(opened, choice)}
          onOpenSettings={openSettings}
          review={(choice) =>
            iphoneReview({
              app: opened.view.app,
              choice,
              current: opened.view.access,
              definition: opened.definition,
              name: opened.view.name,
              opensteer: props.opensteer,
              permission: opened.permission,
            })
          }
          summary={{ text: opened.view.summary, tone: opened.view.tone }}
        />
      )}
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
