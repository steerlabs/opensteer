import {
  canContinueThreadOnPlacement,
  routeOnAccount,
  withSetting,
  type ModelSetting,
  composerExecutionSelection,
  lastExecutionSelection,
  accessModeOptions,
  accessModeUnavailableReason,
  placementForSelection,
  selectionForRoute,
  resolveExecutionSelection,
  runsChosenExecution,
  selectionForModel,
  threadPlacementOptions,
  unwrapRpcResult,
  type ExecutionSelection,
  type HostClient,
  type HostSnapshot,
  type ExecutionRoute,
  type ThreadPlacementOption,
  type ThreadSummary,
} from "@opensteer/client/host";
import { useHostSnapshot } from "@opensteer/client/react";
import type { ModelSelection, ThreadAccessMode } from "@opensteer/core";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { canRespondToRequests } from "@opensteer/client/host";
import { operationDetail } from "../client/mobile-client.js";
import {
  color,
  material,
  controlFontScaleLimit,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { startingPlacement } from "../thread/first-message.js";
import {
  cancelFirstMessagePickerAttempt,
  finishFirstMessagePickerAttempt,
} from "../thread/first-message-picker-attempt.js";
import {
  buildThreadModelPicker,
  settingsDisabledReason,
  type AccountRow,
  type ModelRow,
  type PickerStep,
  type ThreadModelPicker,
} from "../thread/settings/settings-controller.js";
import { useThreadMutation } from "../thread/thread-mutation-registry.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import { AppText, Notice, PrimaryButton, SecondaryButton, SwitchRow } from "../ui/primitives.js";
import { useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { EngineMark } from "../thread/settings/engine-mark.js";
import { Symbol } from "../ui/symbol.js";

export type ThreadSettingsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
  readonly conversation?: boolean;
}>;

export type NewThreadScreenProps = StaticScreenProps<{
  readonly conversation?: boolean;
  readonly deploymentId: string;
  /**
   * Set when the choice is for Chat's first message. Chat takes no default
   * account when several could run it; a new task takes the deployment's.
   */
  readonly home?: boolean;
  /** The Send whose choice this sheet answers, when Send opened it. */
  readonly pickerAttemptId?: string;
}>;

/** The route gate prevents an old sheet from ever subscribing to a replacement Host. */
export function ThreadSettingsScreen(props: ThreadSettingsScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId, threadId, conversation } = props.route.params;
  const { selection } = useMobileState();
  if (selection.deploymentId !== deploymentId || selection.hostClient === null) {
    return (
      <UnavailableSheet
        detail="This deployment is no longer open."
        onDone={() => navigation.goBack()}
      />
    );
  }
  return (
    <SubscribedThreadSettings
      conversation={conversation ?? false}
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      key={`${deploymentId}:${threadId}`}
      threadId={threadId}
    />
  );
}

function SubscribedThreadSettings(props: {
  readonly conversation: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly threadId: string;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const navigation = useNavigation();
  const userId = snapshot.user?.id ?? null;
  const thread = snapshot.threads.find(({ id }) => id === props.threadId) ?? null;
  if (thread === null) {
    return (
      <UnavailableSheet
        detail="It may have been deleted, or it belongs to another deployment."
        onDone={() => navigation.goBack()}
      />
    );
  }
  return (
    <ModelPickerForUser
      {...props}
      key={`${props.deploymentId}:${userId ?? "signed-out"}:${props.threadId}`}
      snapshot={snapshot}
      thread={thread}
    />
  );
}

interface PickerForUserProps {
  readonly conversation: boolean;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly snapshot: HostSnapshot;
  readonly thread: ThreadSummary;
  readonly threadId: string;
}

const firstStep: PickerStep = { kind: "engines" };

function ModelPickerForUser(props: PickerForUserProps): ReactNode {
  const navigation = useNavigation();
  const client = useMobileClient();
  const [step, setStep] = useState<PickerStep>(
    props.conversation ? { kind: "conversation" } : firstStep,
  );
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  // A choice that would start the AI fresh, held until the reader has read
  // what that means. Dismissing it changes nothing at all.
  const [review, setReview] = useState<ExecutionSwitchReview | null>(null);
  const mutationInFlight = useRef(false);
  const mounted = useRef(false);
  const scope = useMemo(
    () => ({
      deploymentId: props.deploymentId,
      threadId: props.threadId,
      userId: props.snapshot.user?.id ?? null,
    }),
    [props.deploymentId, props.snapshot.user?.id, props.threadId],
  );
  const { gate, owner } = useThreadMutation(scope);

  // Set on mount rather than at creation, so StrictMode's replayed effect
  // leaves a mounted sheet able to report its own failures.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const placements = useMemo(
    () =>
      threadPlacementOptions(props.snapshot.environments, props.snapshot.harnesses).filter(
        (placement) => placement.environmentId === props.thread.environmentId,
      ),
    [props.snapshot.environments, props.snapshot.harnesses, props.thread.environmentId],
  );
  const disabledReason = settingsDisabledReason({
    canRespond: canRespondToRequests(props.snapshot),
    hasRun: props.snapshot.runQueue.some((run) => run.threadId === props.threadId),
    mutationOwner: owner,
    kind: "thread",
    thread: props.thread,
  });
  const picker = useMemo(
    () =>
      buildThreadModelPicker({
        placements,
        preferences: props.snapshot.executionPreferences,
        query,
        step,
        subject: { kind: "thread", thread: props.thread },
      }),
    [placements, props.snapshot.executionPreferences, props.thread, query, step],
  );

  const goToStep = useCallback((next: PickerStep): void => {
    setStep(next);
    setQuery("");
    setFailure(null);
  }, []);

  const back = useCallback(() => goToStep(firstStep), [goToStep]);

  // Bound to focus, so a picker under another screen never takes its back press.
  useFocusEffect(
    useCallback(() => {
      if (step.kind === "engines" && review === null) return undefined;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (review !== null) setReview(null);
        else back();
        return true;
      });
      return () => subscription.remove();
    }, [back, review, step.kind]),
  );

  const close = useCallback((): void => {
    if (navigation.isFocused()) navigation.goBack();
  }, [navigation]);

  const liveMutationContext = useCallback(():
    | {
        readonly placements: readonly ThreadPlacementOption[];
        readonly thread: ThreadSummary;
      }
    | { readonly error: string } => {
    const selected = client.getSnapshot().selection;
    if (selected.deploymentId !== props.deploymentId || selected.hostClient !== props.hostClient) {
      return { error: "This deployment is no longer open." };
    }
    const snapshot = props.hostClient.getSnapshot();
    if (snapshot.user?.id !== props.snapshot.user?.id) {
      return { error: "The signed-in user changed. Choose the model again." };
    }
    const thread = snapshot.threads.find(({ id }) => id === props.threadId);
    if (thread === undefined) return { error: "This thread is no longer here." };
    const reason = settingsDisabledReason({
      canRespond: canRespondToRequests(snapshot),
      hasRun: snapshot.runQueue.some((run) => run.threadId === props.threadId),
      mutationOwner: null,
      kind: "thread",
      thread,
    });
    if (reason !== null) return { error: reason };
    return {
      placements: threadPlacementOptions(snapshot.environments, snapshot.harnesses).filter(
        (placement) => placement.environmentId === thread.environmentId,
      ),
      thread,
    };
  }, [client, props.deploymentId, props.hostClient, props.snapshot.user?.id, props.threadId]);

  /**
   * Applies the whole route after validating the live catalog. Option changes
   * keep the sheet open so the new value is read where it was set.
   */
  const dispatchRoute = useCallback(
    (
      requested: ExecutionRoute,
      change: {
        readonly busyKey: string;
        readonly closeOnSuccess: boolean;
        readonly optionValues?: ModelSelection["options"];
      },
      /** Set once the reader has read the consequence and confirmed it. */
      reviewed?: ExecutionSwitchReview,
    ): void => {
      if (mutationInFlight.current) return;
      const live = liveMutationContext();
      if ("error" in live) {
        setFailure(live.error);
        return;
      }
      // An option menu can outlive a selection changed by another client.
      // Its old value must never switch this thread back to the old account/model.
      if (
        change.optionValues !== undefined &&
        (live.thread.environmentId !== requested.placement.environmentId ||
          live.thread.harnessInstanceId !== requested.placement.harnessInstanceId ||
          live.thread.modelSelection.providerId !== requested.model.providerId ||
          live.thread.modelSelection.modelId !== requested.model.modelId)
      ) {
        setFailure("The selected model or account changed. Review its options and try again.");
        return;
      }
      const placement = live.placements.find(
        (candidate) =>
          candidate.environmentId === requested.placement.environmentId &&
          candidate.harnessInstanceId === requested.placement.harnessInstanceId,
      );
      if (!placement?.available) {
        setFailure("That AI account is not available right now. Choose another account.");
        return;
      }
      const descriptor = placement.models.find(
        (candidate) =>
          candidate.providerId === requested.model.providerId &&
          candidate.modelId === requested.model.modelId,
      );
      if (descriptor === undefined || descriptor.unavailableReason) {
        setFailure(
          descriptor?.unavailableReason ?? "That model is no longer available on this AI account.",
        );
        return;
      }
      const current: ExecutionSelection = {
        environmentId: live.thread.environmentId,
        harnessInstanceId: live.thread.harnessInstanceId,
        modelSelection: live.thread.modelSelection,
      };
      const route = { model: descriptor, placement };
      const selected = selectionForRoute(
        route,
        current,
        props.hostClient.getSnapshot().executionPreferences.history,
      );
      const next = {
        ...selected,
        modelSelection: selectionForModel(descriptor, {
          ...(change.optionValues ?? selected.modelSelection.options),
        }),
      };
      const startsFresh = !canContinueThreadOnPlacement(live.thread, placement);
      const accessReason = accessModeUnavailableReason(live.thread.accessMode, placement);
      if ((startsFresh || accessReason !== null) && reviewed === undefined) {
        setReview({
          change,
          engineName: placement.engineName,
          accountName: placement.accountName,
          currentEngineName:
            live.placements.find((p) => p.harnessInstanceId === live.thread.harnessInstanceId)
              ?.engineName ?? live.thread.harnessLabel,
          expectedProviderSessionId: live.thread.providerSessionId,
          expectedSelection: current,
          expectedAccessMode: live.thread.accessMode,
          kind: "switch",
          requested,
          startsFresh,
          accessReason,
          accessMode: accessReason === null ? live.thread.accessMode : null,
        });
        return;
      }
      if (
        reviewed !== undefined &&
        (live.thread.providerSessionId !== reviewed.expectedProviderSessionId ||
          !runsChosenExecution(
            live.thread,
            { accessMode: reviewed.expectedAccessMode, selection: reviewed.expectedSelection },
            live.placements,
          ))
      ) {
        setFailure("This conversation changed. Choose the model again to review it.");
        return;
      }
      const targetAccess = reviewed?.accessMode ?? live.thread.accessMode;
      const accessUnavailable = accessModeUnavailableReason(targetAccess, placement);
      if (accessUnavailable !== null) {
        setFailure(accessUnavailable);
        return;
      }
      const claim = gate.acquire("settings");
      if (claim === null) return;
      mutationInFlight.current = true;
      setApplyingKey(change.busyKey);
      setFailure(null);

      void (async () => {
        let validated = resolveExecutionSelection(next, live.placements);
        if (validated === null)
          throw new Error("That choice is no longer available. Choose another.");
        if (targetAccess !== live.thread.accessMode) {
          await props.hostClient.updateThreadAccess(props.threadId, targetAccess);
          const refreshed = liveMutationContext();
          if ("error" in refreshed) throw new Error(refreshed.error);
          const target = placementForSelection(refreshed.placements, next);
          validated = resolveExecutionSelection(next, refreshed.placements);
          if (!target?.available || validated === null) {
            throw new Error("That choice is no longer available. Choose another.");
          }
          const reason = accessModeUnavailableReason(targetAccess, target);
          if (reason !== null) throw new Error(reason);
          if (
            refreshed.thread.providerSessionId !== live.thread.providerSessionId ||
            !runsChosenExecution(
              refreshed.thread,
              { accessMode: targetAccess, selection: current },
              refreshed.placements,
            )
          ) {
            throw new Error("This conversation changed. Choose the model again to review it.");
          }
        }
        const execution = {
          harnessInstanceId: validated.harnessInstanceId,
          modelSelection: validated.modelSelection,
        };
        return reviewed === undefined
          ? props.hostClient.updateThreadExecution(props.threadId, execution)
          : props.hostClient.updateThreadExecution(props.threadId, execution, {
              expectedProviderSessionId: reviewed.expectedProviderSessionId,
            });
      })()
        .then(() => {
          if (change.optionValues === undefined) void Haptics.selectionAsync();
          if (change.closeOnSuccess) close();
        })
        .catch((error: unknown) => {
          if (mounted.current) {
            setFailure(operationDetail(error, "That change could not be applied."));
          }
        })
        .finally(() => {
          mutationInFlight.current = false;
          if (mounted.current) setApplyingKey(null);
          gate.release(claim);
        });
    },
    [close, gate, liveMutationContext, props.hostClient, props.threadId],
  );

  const chooseModel = useCallback(
    (row: ModelRow): void => {
      if (row.blockedReason !== null) {
        setFailure(row.blockedReason);
        return;
      }
      if (row.selected) {
        close();
        return;
      }
      dispatchRoute(row.route, { busyKey: row.key, closeOnSuccess: true });
    },
    [close, dispatchRoute],
  );

  const chooseAccount = useCallback(
    (row: AccountRow): void => {
      if (row.selected) return;
      if (row.action.kind === "blocked" || row.action.kind === "refresh") {
        setFailure(row.action.reason);
        return;
      }
      const route = routeOnAccount(
        row.placement,
        picker.currentRoute
          ? {
              environmentId: picker.currentRoute.placement.environmentId,
              harnessInstanceId: picker.currentRoute.placement.harnessInstanceId,
              modelSelection: props.thread.modelSelection,
            }
          : null,
        props.snapshot.executionPreferences.history,
      );
      if (route) dispatchRoute(route, { busyKey: row.key, closeOnSuccess: false });
    },
    [
      dispatchRoute,
      picker.currentRoute,
      props.thread.modelSelection,
      props.snapshot.executionPreferences.history,
    ],
  );

  const changeOption = useCallback(
    (id: string, value: boolean | string): void => {
      const variant = picker.currentRoute;
      if (variant === null) return;
      dispatchRoute(variant, {
        busyKey: `option:${id}`,
        closeOnSuccess: false,
        optionValues: withSetting(
          variant.model,
          props.thread.modelSelection.options,
          typeof value === "boolean" ? { id, on: value } : { id, value },
        ),
      });
    },
    [dispatchRoute, picker.currentRoute, props.thread.modelSelection.options],
  );

  const changeAccess = useCallback(
    (mode: ThreadAccessMode): void => {
      if (mutationInFlight.current) return;
      const live = liveMutationContext();
      if ("error" in live) {
        setFailure(live.error);
        return;
      }
      if (
        live.thread.harnessInstanceId !== props.thread.harnessInstanceId ||
        live.thread.accessMode !== props.thread.accessMode
      ) {
        setFailure("This conversation changed. Review its access and try again.");
        return;
      }
      const placement = live.placements.find(
        (candidate) => candidate.harnessInstanceId === live.thread.harnessInstanceId,
      );
      const reason = accessModeUnavailableReason(
        mode,
        placement ?? { accessModes: null, engineName: props.thread.harnessLabel },
      );
      if (reason !== null) {
        setFailure(reason);
        return;
      }
      if (mode === live.thread.accessMode) return;
      const claim = gate.acquire("settings");
      if (claim === null) return;
      mutationInFlight.current = true;
      setApplyingKey("access");
      setFailure(null);
      void props.hostClient
        .updateThreadAccess(props.threadId, mode)
        .then(() => {
          void Haptics.selectionAsync();
        })
        .catch((error: unknown) => {
          if (mounted.current)
            setFailure(operationDetail(error, "That access mode could not be applied."));
        })
        .finally(() => {
          mutationInFlight.current = false;
          if (mounted.current) setApplyingKey(null);
          gate.release(claim);
        });
    },
    [gate, liveMutationContext, props.hostClient, props.thread, props.threadId],
  );

  // The AI this conversation is on, offered as something to start over on. It
  // is the recovery for a native session whose start is uncertain, and it must
  // not need a detour through another engine and back.
  const currentPlacement =
    placements.find(
      (placement) => placement.harnessInstanceId === props.thread.harnessInstanceId,
    ) ?? null;
  const startFresh = useCallback((): void => {
    const variant = picker.currentRoute;
    const current =
      placements.find(
        (placement) => placement.harnessInstanceId === props.thread.harnessInstanceId,
      ) ?? null;
    if (variant === null || current === null || !current.available) {
      setFailure("This AI is not available right now, so it cannot be started fresh.");
      return;
    }
    if (runningHere(props.hostClient.getSnapshot(), props.threadId)) {
      setFailure("Finish or stop this response before starting fresh.");
      return;
    }
    setReview({
      accountName: current.accountName,
      change: { busyKey: "fresh", closeOnSuccess: true },
      currentEngineName: current.engineName,
      engineName: current.engineName,
      expectedProviderSessionId: props.thread.providerSessionId,
      kind: "fresh",
      requested: variant,
      startsFresh: true,
      accessReason: accessModeUnavailableReason(props.thread.accessMode, current),
      accessMode:
        accessModeUnavailableReason(props.thread.accessMode, current) === null
          ? props.thread.accessMode
          : null,
      expectedAccessMode: props.thread.accessMode,
      expectedSelection: {
        environmentId: props.thread.environmentId,
        harnessInstanceId: props.thread.harnessInstanceId,
        modelSelection: props.thread.modelSelection,
      },
    });
  }, [picker.currentRoute, placements, props.hostClient, props.thread, props.threadId]);

  if (review !== null) {
    return (
      <ExecutionSwitchReviewPanel
        onCancel={() => setReview(null)}
        onConfirm={(accessMode) => {
          const confirmed = { ...review, accessMode };
          setReview(null);
          dispatchRoute(confirmed.requested, confirmed.change, confirmed);
        }}
        review={review}
      />
    );
  }

  return (
    <ModelPickerList
      accessMode={props.thread.accessMode}
      accessPlacement={currentPlacement}
      onChangeAccess={changeAccess}
      applyingKey={applyingKey}
      disabledReason={applyingKey === null ? disabledReason : "Updating thread settings…"}
      failure={failure}
      hostClient={props.hostClient}
      onFailure={setFailure}
      footer={
        picker.step.kind === "conversation" && currentPlacement !== null ? (
          <View style={styles.freshStart}>
            <SecondaryButton
              disabled={disabledReason !== null}
              label={`Start fresh with ${currentPlacement.engineName}`}
              onPress={startFresh}
            />
            <AppText role="caption" tone="muted">
              Keeps this conversation. The AI starts a new session.
            </AppText>
          </View>
        ) : null
      }
      onAccount={chooseAccount}
      onBack={step.kind === "engines" ? null : back}
      onChangeOption={changeOption}
      onChangeQuery={setQuery}
      onClose={close}
      onDismissFailure={() => setFailure(null)}
      onModel={chooseModel}
      onEngine={(driverKind) => goToStep({ kind: "engines", driverKind })}
      onConversation={() => goToStep({ kind: "conversation" })}
      picker={picker}
      query={query}
    />
  );
}

/**
 * A choice that ends this conversation's native session, held for review.
 * Everything it names is a fact the picker already had; nothing is invented.
 * `fresh` is the same consequence asked for on the AI already in use.
 */
interface ExecutionSwitchReview {
  readonly accountName: string;
  readonly change: {
    readonly busyKey: string;
    readonly closeOnSuccess: boolean;
    readonly optionValues?: ModelSelection["options"];
  };
  readonly currentEngineName: string;
  readonly engineName: string;
  readonly expectedProviderSessionId: string | null;
  readonly kind: "fresh" | "switch";
  readonly requested: ExecutionRoute;
  readonly startsFresh: boolean;
  readonly accessReason: string | null;
  readonly accessMode: ThreadAccessMode | null;
  readonly expectedAccessMode: ThreadAccessMode;
  readonly expectedSelection: ExecutionSelection;
}

/** A Run that has not finished is what a switch has to wait for. */
function runningHere(snapshot: HostSnapshot, threadId: string): boolean {
  return snapshot.runQueue.some((run) => run.threadId === threadId);
}

/**
 * The review step, in the picker rather than over it.
 *
 * It says what is kept and what starts over, and nothing else: no claim that
 * memory transfers, that nothing changes, or that the new engine has caught
 * up. Keeping the current AI is the first, plainest action.
 */
function ExecutionSwitchReviewPanel(props: {
  readonly onCancel: () => void;
  readonly onConfirm: (accessMode: ThreadAccessMode) => void;
  readonly review: ExecutionSwitchReview;
}): ReactNode {
  const { review } = props;
  const fresh = review.kind === "fresh";
  const [accessMode, setAccessMode] = useState(review.accessMode);
  return (
    <View style={styles.review}>
      <AppText role="displaySmall">
        {fresh
          ? `Start fresh with ${review.engineName}?`
          : `Use ${review.engineName} for this conversation?`}
      </AppText>
      {review.startsFresh ? (
        <AppText role="secondary" tone="muted">
          Your messages stay here. {review.engineName} starts fresh, with recent messages, your
          shared notes, and access to earlier conversation.
        </AppText>
      ) : null}
      <AppText role="secondary" tone="muted">
        {review.accountName}
      </AppText>
      {review.accessReason === null ? null : (
        <>
          <AppText role="secondary" tone="danger">
            {review.accessReason}. Choose an access mode.
          </AppText>
          {accessModeOptions
            .filter(
              (option) =>
                accessModeUnavailableReason(option.mode, review.requested.placement) === null,
            )
            .map((option) => (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ selected: accessMode === option.mode }}
                key={option.mode}
                onPress={() => setAccessMode(option.mode)}
                style={styles.control}
              >
                <AppText role="body">{option.label}</AppText>
                {accessMode === option.mode ? <Symbol name="checkmark" tint={color.ember} /> : null}
              </Pressable>
            ))}
        </>
      )}
      <PrimaryButton
        disabled={accessMode === null}
        label={fresh ? "Start fresh" : `Use ${review.engineName}`}
        onPress={() => {
          if (accessMode !== null) props.onConfirm(accessMode);
        }}
      />
      <Pressable accessibilityRole="button" onPress={props.onCancel} style={styles.reviewCancel}>
        <AppText role="secondaryMedium" tone="ember">
          {fresh ? "Keep this session" : `Keep ${review.currentEngineName}`}
        </AppText>
      </Pressable>
    </View>
  );
}

interface CurrentSettingsProps {
  readonly accessMode: ThreadAccessMode;
  readonly accessPlacement: ThreadPlacementOption | null;
  readonly onChangeAccess: (mode: ThreadAccessMode) => void;
}

function ModelPickerList(
  props: CurrentSettingsProps & {
    readonly applyingKey: string | null;
    readonly disabledReason: string | null;
    readonly failure: string | null;
    readonly footer: ReactNode;
    readonly hostClient: HostClient;
    readonly onAccount: (row: AccountRow) => void;
    readonly onBack: (() => void) | null;
    readonly onChangeOption: (id: string, value: boolean | string) => void;
    readonly onChangeQuery: (query: string) => void;
    readonly onClose: () => void;
    readonly onDismissFailure: () => void;
    readonly onFailure: (failure: string | null) => void;
    readonly onModel: (row: ModelRow) => void;
    readonly onEngine: (driverKind: string) => void;
    readonly onConversation: () => void;
    readonly picker: ThreadModelPicker;
    readonly query: string;
  },
): ReactNode {
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const refreshing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const chooseAccount = useCallback(
    (row: AccountRow): void => {
      if (row.action.kind !== "refresh") {
        props.onAccount(row);
        return;
      }
      if (refreshing.current || props.disabledReason !== null) return;
      refreshing.current = true;
      setRefreshingKey(row.key);
      props.onFailure(null);
      void (async () => {
        unwrapRpcResult(
          await props.hostClient.rpc["harness.catalog.refresh"]({
            environmentId: row.placement.environmentId,
            harnessInstanceId: row.placement.harnessInstanceId,
          }),
        );
        await props.hostClient.refresh();
      })()
        .catch((error: unknown) => {
          if (mounted.current)
            props.onFailure(operationDetail(error, "Models could not be refreshed."));
        })
        .finally(() => {
          refreshing.current = false;
          if (mounted.current) setRefreshingKey(null);
        });
    },
    [props.disabledReason, props.hostClient, props.onAccount, props.onFailure],
  );
  const [searching, setSearching] = useState(false);
  const column = useReadingColumn();
  const insets = useListContentInsets(space[24]);
  const { picker } = props;
  const conversation = picker.step.kind === "conversation";
  const disabled = props.disabledReason !== null || refreshingKey !== null;
  const access = accessModeOptions.find((o) => o.mode === props.accessMode);
  // The engines scroll sideways to the sheet's own edges, not the column's:
  // a row cut off by padding reads as broken rather than as more to scroll.
  const bleed = { marginLeft: -insets.paddingLeft, marginRight: -insets.paddingRight };
  const bleedContent = {
    gap: space[8],
    paddingLeft: insets.paddingLeft,
    paddingRight: insets.paddingRight,
    paddingVertical: space[12],
  };
  // The list is the sheet's direct child, as navigation.tsx requires: iOS sizes
  // that list to each detent, so anything pinned beside it would stay where
  // the smaller detent left it while the list ran on underneath. What this
  // conversation runs with is therefore a row in the list, not a footer.
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, column, insets]}
    >
      <SheetBar
        title={conversation ? "This conversation" : "AI"}
        {...(conversation
          ? {}
          : {
              onSearch: () => {
                if (searching) props.onChangeQuery("");
                setSearching((v) => !v);
              },
            })}
        subtitle={null}
        onBack={props.onBack}
        onClose={props.onClose}
      />
      {props.disabledReason ? <AppText tone="muted">{props.disabledReason}</AppText> : null}
      {props.failure ? (
        <Notice
          title="That did not change"
          detail={props.failure}
          action={{ label: "Dismiss", onPress: props.onDismissFailure }}
        />
      ) : null}
      {conversation ? (
        <>
          <AppText role="title">Access</AppText>
          {accessModeOptions.map((option) => {
            const reason = accessModeUnavailableReason(
              option.mode,
              props.accessPlacement ?? { accessModes: null, engineName: "This engine" },
            );
            return (
              <Pressable
                key={option.mode}
                accessibilityRole="radio"
                accessibilityState={{
                  selected: option.mode === props.accessMode,
                  disabled: disabled || reason !== null,
                }}
                disabled={disabled || reason !== null}
                onPress={() => props.onChangeAccess(option.mode)}
                style={styles.row}
              >
                <View style={styles.rowCopy}>
                  <AppText>{option.label}</AppText>
                  <AppText role="caption" tone="muted">
                    {reason ?? option.description}
                  </AppText>
                </View>
                {option.mode === props.accessMode ? <Symbol name="checkmark" /> : null}
              </Pressable>
            );
          })}
          <AppText role="title">Account</AppText>
          {picker.accounts.map((row) => (
            <Pressable
              key={row.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: row.selected, disabled }}
              disabled={disabled}
              onPress={() => chooseAccount(row)}
              style={styles.row}
            >
              <View style={styles.rowCopy}>
                <AppText>{row.title}</AppText>
                <AppText role="caption" tone={row.exhausted ? "danger" : "muted"}>
                  {row.detail}
                </AppText>
              </View>
              {row.selected ? <Symbol name="checkmark" /> : null}
            </Pressable>
          ))}
          {props.footer}
        </>
      ) : (
        <>
          {searching ? (
            <TextInput
              accessibilityLabel="Search models"
              placeholder="Search models"
              value={props.query}
              onChangeText={props.onChangeQuery}
              style={styles.searchField}
              maxFontSizeMultiplier={controlFontScaleLimit}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="This conversation"
            onPress={props.onConversation}
            style={({ pressed }) => [styles.conversationRow, pressed && styles.rowPressed]}
          >
            <Symbol
              name={props.accessMode === "full-access" ? "lock.open" : "lock"}
              size={15}
              tint={color.muted}
            />
            <AppText numberOfLines={1} role="secondary" style={styles.rowCopy} tone="muted">
              {access?.label ?? props.accessMode} ·{" "}
              {picker.accounts.find((a) => a.selected)?.title ?? "Choose account"}
            </AppText>
            <Symbol name="chevron.right" size={13} tint={color.muted} />
          </Pressable>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={bleed}
            contentContainerStyle={bleedContent}
          >
            {[...picker.menu.ready, ...picker.menu.unavailable].map((engine) => {
              const selected = picker.menu.browsed?.driverKind === engine.driverKind;
              return (
                <Pressable
                  key={engine.driverKind}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Engine: ${engine.name}${engine.note ? `, ${engine.note}` : ""}`}
                  onPress={() => props.onEngine(engine.driverKind)}
                  style={({ pressed }) => [
                    styles.chip,
                    selected && styles.chipSelected,
                    pressed && styles.chipPressed,
                    engine.status !== "ready" && styles.dimmed,
                  ]}
                >
                  <EngineMark
                    driverKind={engine.driverKind}
                    tint={selected ? color.text : color.textSoft}
                  />
                  <AppText role="secondaryMedium" tone={selected ? "default" : "soft"}>
                    {engine.name}
                  </AppText>
                </Pressable>
              );
            })}
          </ScrollView>
          {picker.unavailableCurrent ? (
            <Notice
              title={picker.unavailableCurrent.title}
              detail={picker.unavailableCurrent.detail}
              tone="neutral"
            />
          ) : null}
          {picker.menu.blocked ? (
            <View style={styles.review}>
              <AppText tone="muted">{picker.menu.blocked.detail}</AppText>
              <SecondaryButton
                label={
                  picker.menu.blocked.availability === "authentication-required"
                    ? "Sign in"
                    : "Check again"
                }
                disabled={disabled}
                onPress={() => {
                  const placement = picker.menu.blocked!;
                  chooseAccount({
                    key: placement.harnessInstanceId,
                    placement,
                    title: placement.accountName,
                    detail: placement.detail,
                    selected: false,
                    exhausted: false,
                    action: { kind: "refresh", reason: placement.detail },
                  });
                }}
              />
            </View>
          ) : null}
          {picker.models.map((row) => (
            <Pressable
              key={row.key}
              accessibilityRole="radio"
              accessibilityState={{
                selected: row.selected,
                disabled: disabled || row.blockedReason !== null,
              }}
              disabled={disabled || row.blockedReason !== null}
              onPress={() => props.onModel(row)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowCopy}>
                <AppText role="secondaryMedium">{row.title}</AppText>
                {row.detail ? (
                  <AppText numberOfLines={1} role="caption" tone="muted">
                    {row.detail}
                  </AppText>
                ) : null}
              </View>
              {row.selected ? (
                <Symbol name="checkmark" size={15} tint={color.ember} weight="semibold" />
              ) : null}
            </Pressable>
          ))}
          {picker.options.length ? (
            <View
              style={{
                borderTopWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
                paddingTop: 16,
              }}
            >
              {picker.options.map((option) => (
                <OptionField
                  key={option.id}
                  option={option}
                  busy={props.applyingKey === `option:${option.id}`}
                  disabledReason={props.disabledReason}
                  onChange={props.onChangeOption}
                />
              ))}
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

/**
 * Which AI a first message starts its Thread on, chosen before that Thread
 * exists. Each choice is recorded as this person's latest, which is what the
 * first message reads back; nothing is started here — the message does that.
 */
export function NewThreadScreen(props: NewThreadScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId, home = false, pickerAttemptId, conversation } = props.route.params;
  const { selection } = useMobileState();
  const unavailable = selection.deploymentId !== deploymentId || selection.hostClient === null;
  useEffect(() => {
    if (unavailable && pickerAttemptId !== undefined) {
      cancelFirstMessagePickerAttempt(pickerAttemptId);
    }
  }, [pickerAttemptId, unavailable]);
  if (unavailable || selection.hostClient === null) {
    return (
      <UnavailableSheet
        detail="This deployment is no longer open."
        onDone={() => navigation.goBack()}
      />
    );
  }
  return (
    <SubscribedNewThread
      conversation={conversation ?? false}
      deploymentId={deploymentId}
      home={home}
      hostClient={selection.hostClient}
      key={`${deploymentId}:${home ? "home" : "task"}`}
      {...(pickerAttemptId === undefined ? {} : { pickerAttemptId })}
    />
  );
}

function SubscribedNewThread(props: {
  readonly conversation: boolean;
  readonly deploymentId: string;
  readonly home: boolean;
  readonly hostClient: HostClient;
  readonly pickerAttemptId?: string;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const navigation = useNavigation();
  const client = useMobileClient();
  const [chosen, setChosen] = useState<ExecutionSelection | null>(null);
  const [step, setStep] = useState<PickerStep>(
    props.conversation ? { kind: "conversation" } : firstStep,
  );
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const pickerUserId = useRef(snapshot.user?.id ?? null);
  const acceptedChoice = useRef<ExecutionSelection | null>(null);
  const pendingChoice = useRef<Promise<ExecutionSelection | null> | null>(null);
  const preferences = snapshot.executionPreferences;
  const placements = useMemo(
    () => threadPlacementOptions(snapshot.environments, snapshot.harnesses),
    [snapshot.environments, snapshot.harnesses],
  );
  const remembered = lastExecutionSelection(preferences);
  const resolved = composerExecutionSelection({
    chosen,
    defaultPlacement: startingPlacement(
      props.home ? "home" : "task",
      snapshot,
      placements.filter((placement) => placement.available),
    ),
    placements,
    remembered,
  });
  const displayed = resolved ?? chosen ?? remembered;
  const disabledReason = settingsDisabledReason({
    canRespond: canRespondToRequests(snapshot),
    kind: "draft",
  });
  const picker = useMemo(
    () =>
      buildThreadModelPicker({
        placements,
        preferences,
        query,
        step,
        subject: { kind: "draft", selection: displayed },
      }),
    [displayed, placements, preferences, query, step],
  );

  const finishAttempt = useCallback(() => {
    if (props.pickerAttemptId === undefined) return;
    const current = client.getSnapshot().selection;
    if (
      current.deploymentId !== props.deploymentId ||
      current.hostClient !== props.hostClient ||
      props.hostClient.getSnapshot().user?.id !== pickerUserId.current
    ) {
      cancelFirstMessagePickerAttempt(props.pickerAttemptId);
      return;
    }
    finishFirstMessagePickerAttempt(
      props.pickerAttemptId,
      pendingChoice.current ?? acceptedChoice.current,
    );
  }, [client, props.deploymentId, props.hostClient, props.pickerAttemptId]);
  useEffect(() => {
    mounted.current = true;
    const leaving = navigation.addListener("beforeRemove", (event) => {
      if (event.data.action.type === "GO_BACK" || event.data.action.type === "POP") {
        finishAttempt();
      } else if (props.pickerAttemptId !== undefined) {
        cancelFirstMessagePickerAttempt(props.pickerAttemptId);
      }
    });
    return () => {
      mounted.current = false;
      leaving();
      // A native sheet may tear down without emitting a removal event. React
      // StrictMode replays cleanup and setup in one turn; only a real unmount
      // remains unmounted when this microtask runs.
      void Promise.resolve().then(() => {
        if (!mounted.current) finishAttempt();
      });
    };
  }, [finishAttempt, navigation, props.pickerAttemptId]);

  const close = useCallback(() => {
    finishAttempt();
    navigation.goBack();
  }, [finishAttempt, navigation]);
  const goToStep = useCallback((next: PickerStep): void => {
    setStep(next);
    setQuery("");
    setFailure(null);
  }, []);
  const back = useCallback(() => goToStep(firstStep), [goToStep]);

  useFocusEffect(
    useCallback(() => {
      if (step.kind === "engines") return undefined;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        back();
        return true;
      });
      return () => subscription.remove();
    }, [back, step.kind]),
  );

  const chooseRoute = useCallback(
    (
      requested: ExecutionRoute,
      change: {
        readonly busyKey: string;
        readonly optionValues?: ModelSelection["options"];
        readonly keepOpen?: boolean;
      },
    ): void => {
      if (working.current || disabledReason !== null) return;
      const selected = client.getSnapshot().selection;
      if (
        selected.deploymentId !== props.deploymentId ||
        selected.hostClient !== props.hostClient
      ) {
        setFailure("This deployment is no longer open.");
        return;
      }
      const live = props.hostClient.getSnapshot();
      if (live.user?.id !== pickerUserId.current) {
        setFailure("The signed-in user changed. Choose the model again.");
        return;
      }
      if (!canRespondToRequests(live)) {
        setFailure("Reconnect to choose thread settings.");
        return;
      }
      const livePlacements = threadPlacementOptions(live.environments, live.harnesses);
      const placement = livePlacements.find(
        (candidate) =>
          candidate.environmentId === requested.placement.environmentId &&
          candidate.harnessInstanceId === requested.placement.harnessInstanceId,
      );
      if (!placement?.available) {
        setFailure("That AI account is not available right now. Choose another account.");
        return;
      }
      const descriptor = placement.models.find(
        (candidate) =>
          candidate.providerId === requested.model.providerId &&
          candidate.modelId === requested.model.modelId,
      );
      if (descriptor === undefined || descriptor.unavailableReason) {
        setFailure(
          descriptor?.unavailableReason ?? "That model is no longer available on this AI account.",
        );
        return;
      }
      if (change.optionValues !== undefined && displayed !== null) {
        const latest = lastExecutionSelection(live.executionPreferences);
        if (
          latest !== null &&
          (latest.environmentId !== displayed.environmentId ||
            latest.harnessInstanceId !== displayed.harnessInstanceId ||
            latest.modelSelection.providerId !== displayed.modelSelection.providerId ||
            latest.modelSelection.modelId !== displayed.modelSelection.modelId)
        ) {
          setFailure("The selected model or account changed. Review its options and try again.");
          return;
        }
      }
      const selectedRoute = selectionForRoute(
        { model: descriptor, placement },
        displayed,
        live.executionPreferences.history,
      );
      const next: ExecutionSelection = {
        ...selectedRoute,
        modelSelection: selectionForModel(descriptor, {
          ...(change.optionValues ?? selectedRoute.modelSelection.options),
        }),
      };
      const validated = resolveExecutionSelection(next, livePlacements);
      if (validated === null) {
        setFailure("That choice is no longer available. Choose another.");
        return;
      }
      setChosen(validated);
      working.current = true;
      setApplyingKey(change.busyKey);
      setFailure(null);
      const outcome = props.hostClient.rememberExecution({ selection: validated }).then(
        () => {
          acceptedChoice.current = validated;
          if (mounted.current && change.optionValues === undefined && !change.keepOpen) close();
          if (change.optionValues === undefined) void Haptics.selectionAsync();
          return validated;
        },
        (error: unknown) => {
          acceptedChoice.current = null;
          if (mounted.current) {
            setChosen(null);
            setFailure(operationDetail(error, "That choice could not be remembered."));
          }
          return null;
        },
      );
      pendingChoice.current = outcome;
      void outcome.finally(() => {
        if (pendingChoice.current === outcome) pendingChoice.current = null;
        working.current = false;
        if (mounted.current) setApplyingKey(null);
      });
    },
    [client, disabledReason, displayed, close, props.deploymentId, props.hostClient],
  );

  const changeAccess = useCallback(
    (mode: ThreadAccessMode): void => {
      if (working.current) return;
      const selected = client.getSnapshot().selection;
      const live = props.hostClient.getSnapshot();
      if (
        selected.deploymentId !== props.deploymentId ||
        selected.hostClient !== props.hostClient ||
        live.user?.id !== pickerUserId.current
      ) {
        setFailure("The deployment or signed-in user changed. Reopen the draft to change access.");
        return;
      }
      if (!canRespondToRequests(live)) {
        setFailure("Reconnect to change access.");
        return;
      }
      const livePlacements = threadPlacementOptions(live.environments, live.harnesses);
      const liveSelection = composerExecutionSelection({
        chosen,
        defaultPlacement: startingPlacement(
          props.home ? "home" : "task",
          live,
          livePlacements.filter((p) => p.available),
        ),
        placements: livePlacements,
        remembered: lastExecutionSelection(live.executionPreferences),
      });
      const placement =
        liveSelection === null ? null : placementForSelection(livePlacements, liveSelection);
      const reason = accessModeUnavailableReason(
        mode,
        placement ?? { accessModes: null, engineName: "This engine" },
      );
      if (reason !== null) {
        setFailure(reason);
        return;
      }
      if (mode === live.executionPreferences.accessMode) return;
      working.current = true;
      setApplyingKey("access");
      setFailure(null);
      // Closing a Send-opened picker waits for the same Host acknowledgement
      // as model changes, so it cannot send under the previous access mode.
      const outcome = props.hostClient.rememberExecution({ accessMode: mode }).then(
        () => {
          acceptedChoice.current = liveSelection;
          void Haptics.selectionAsync();
          return liveSelection;
        },
        (error: unknown) => {
          acceptedChoice.current = null;
          if (mounted.current) setFailure(operationDetail(error, "Access could not be changed."));
          return null;
        },
      );
      pendingChoice.current = outcome;
      void outcome.finally(() => {
        if (pendingChoice.current === outcome) pendingChoice.current = null;
        working.current = false;
        if (mounted.current) setApplyingKey(null);
      });
    },
    [chosen, client, props.deploymentId, props.home, props.hostClient],
  );

  const chooseModel = useCallback(
    (row: ModelRow): void => {
      if (row.blockedReason !== null) {
        setFailure(row.blockedReason);
        return;
      }
      chooseRoute(row.route, { busyKey: row.key });
    },
    [chooseRoute],
  );
  const chooseAccount = useCallback(
    (row: AccountRow): void => {
      if (row.selected) return;
      if (row.action.kind === "blocked" || row.action.kind === "refresh") {
        setFailure(row.action.reason);
        return;
      }
      const route = routeOnAccount(row.placement, displayed, preferences.history);
      if (route) chooseRoute(route, { busyKey: row.key, keepOpen: true });
    },
    [chooseRoute, displayed, preferences.history],
  );
  const changeOption = useCallback(
    (id: string, value: boolean | string): void => {
      if (picker.currentRoute !== null) {
        chooseRoute(picker.currentRoute, {
          busyKey: `option:${id}`,
          optionValues: withSetting(
            picker.currentRoute.model,
            displayed?.modelSelection.options ?? {},
            typeof value === "boolean" ? { id, on: value } : { id, value },
          ),
        });
      }
    },
    [chooseRoute, picker.currentRoute, displayed],
  );
  return (
    <ModelPickerList
      accessMode={preferences.accessMode}
      accessPlacement={displayed === null ? null : placementForSelection(placements, displayed)}
      onChangeAccess={changeAccess}
      applyingKey={applyingKey}
      disabledReason={applyingKey === null ? disabledReason : "Updating thread settings…"}
      failure={failure}
      hostClient={props.hostClient}
      onFailure={setFailure}
      footer={
        <View style={styles.startThread}>
          {/* Each choice above is already recorded as this person's latest,
              so there is nothing left to apply here — only to go back to the
              message this choice is for. */}
          <PrimaryButton label="Done" onPress={close} />
        </View>
      }
      onAccount={chooseAccount}
      onBack={step.kind === "engines" ? null : back}
      onChangeOption={changeOption}
      onChangeQuery={setQuery}
      onClose={close}
      onDismissFailure={() => setFailure(null)}
      onModel={chooseModel}
      onEngine={(driverKind) => goToStep({ kind: "engines", driverKind })}
      onConversation={() => goToStep({ kind: "conversation" })}
      picker={picker}
      query={query}
    />
  );
}

function UnavailableSheet(props: {
  readonly detail: string;
  readonly onDone: () => void;
}): ReactNode {
  return (
    <ScrollView contentContainerStyle={[styles.unavailable, styles.content]}>
      <SheetBar onBack={null} onClose={props.onDone} subtitle={null} title="Model" />
      <Notice detail={props.detail} title="The model picker is unavailable" tone="neutral" />
    </ScrollView>
  );
}

function SheetBar(props: {
  readonly onSearch?: () => void;
  readonly onBack: (() => void) | null;
  readonly onClose: () => void;
  readonly subtitle: string | null;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.bar}>
      {props.onBack === null ? (
        <View style={styles.barButtonSpace} />
      ) : (
        <BarButton icon="chevron.left" label="Back" onPress={props.onBack} />
      )}
      <View accessibilityRole="header" style={styles.barTitle}>
        <AppText role="title">{props.title}</AppText>
        {props.subtitle === null ? null : (
          <AppText role="caption" tone="muted">
            {props.subtitle}
          </AppText>
        )}
      </View>
      {props.onSearch ? (
        <BarButton icon="magnifyingglass" label="Search all AIs" onPress={props.onSearch} />
      ) : null}
      <BarButton icon="xmark" label="Close model picker" onPress={props.onClose} />
    </View>
  );
}

function BarButton(props: {
  readonly icon: "chevron.left" | "xmark" | "magnifyingglass";
  readonly label: string;
  readonly onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      hitSlop={space[4]}
      onPress={props.onPress}
      style={({ pressed }) => [styles.barButton, pressed && styles.barButtonPressed]}
    >
      <Symbol name={props.icon} size={18} weight="semibold" />
    </Pressable>
  );
}

function OptionField(props: {
  readonly busy: boolean;
  readonly disabledReason: string | null;
  readonly onChange: (id: string, value: boolean | string) => void;
  readonly option: ModelSetting;
}): ReactNode {
  const { option } = props;
  if (option.kind === "switch") {
    return (
      <View>
        <View style={[styles.control, styles.toggle]}>
          <View style={styles.rowCopy}>
            <SwitchRow
              disabled={props.disabledReason !== null || props.busy}
              label={option.label}
              onChange={(next) => props.onChange(option.id, next)}
              value={option.on}
            />
          </View>
          {props.busy ? <ActivityIndicator color={color.ember} /> : null}
        </View>
        {option.description ? (
          <AppText role="caption" tone="muted">
            {option.description}
          </AppText>
        ) : null}
      </View>
    );
  }
  if (option.kind === "ladder")
    return (
      <ReasoningLadder
        option={option}
        disabled={props.disabledReason !== null || props.busy}
        onChange={props.onChange}
      />
    );
  // A native menu holds any number of values, where a segmented control
  // squeezes past four into labels nobody can read.
  return (
    <NativeMenu
      accessibilityHint={`Choose ${option.label.toLocaleLowerCase()}`}
      accessibilityLabel={`${option.label}: ${option.valueLabel}`}
      disabledReason={props.disabledReason}
      onPresent={noop}
      onSettle={noop}
      options={option.choices.map((value) => ({
        id: value.value,
        label: value.label,
        onPress: () => {
          if (value.value !== option.value) props.onChange(option.id, value.value);
        },
        selected: value.value === option.value,
      }))}
      style={styles.menuTrigger}
      title={option.label}
    >
      <View style={styles.control}>
        <AppText role="body" style={styles.rowCopy}>
          {option.label}
        </AppText>
        {props.busy ? (
          <ActivityIndicator color={color.ember} />
        ) : (
          <>
            <AppText role="body" style={styles.controlValue} tone="muted">
              {option.valueLabel}
            </AppText>
            <Symbol name="chevron.right" size={12} tint={color.muted} />
          </>
        )}
      </View>
    </NativeMenu>
  );
}

function noop(): void {}

function ReasoningLadder({
  option,
  disabled,
  onChange,
}: {
  option: Extract<ModelSetting, { kind: "ladder" }>;
  disabled: boolean;
  onChange: (id: string, value: string) => void;
}): ReactNode {
  const width = useRef(1);
  const [dragged, setDragged] = useState<number | undefined>(undefined);
  const step = dragged ?? option.step;
  const last = useRef(option.step);
  useEffect(() => {
    last.current = option.step;
    setDragged(undefined);
  }, [option.step]);
  const pick = (x: number) => {
    if (disabled) return;
    const step = Math.max(
      0,
      Math.min(
        option.steps.length - 1,
        Math.round((x / width.current) * (option.steps.length - 1)),
      ),
    );
    if (last.current === step) return;
    last.current = step;
    void Haptics.selectionAsync();
    setDragged(step);
  };
  return (
    <View style={{ gap: 8, paddingVertical: 12 }}>
      <View style={styles.control}>
        <AppText style={styles.rowCopy}>{option.label}</AppText>
        <AppText tone="muted">
          {dragged === undefined ? option.valueLabel : option.steps[dragged]?.label}
        </AppText>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={option.label}
        accessibilityValue={{
          min: 0,
          max: option.steps.length - 1,
          now: option.step ?? 0,
          text: option.valueLabel,
        }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) => {
          const step = Math.max(
            0,
            Math.min(
              option.steps.length - 1,
              (option.step ?? 0) + (event.nativeEvent.actionName === "increment" ? 1 : -1),
            ),
          );
          if (!disabled) {
            void Haptics.selectionAsync();
            onChange(option.id, option.steps[step]!.value);
          }
        }}
        onLayout={(event) => {
          width.current = event.nativeEvent.layout.width;
        }}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={(event) => pick(event.nativeEvent.locationX)}
        onResponderMove={(event) => pick(event.nativeEvent.locationX)}
        onResponderRelease={() => {
          if (last.current !== null && last.current !== option.step)
            onChange(option.id, option.steps[last.current]!.value);
          setDragged(undefined);
        }}
        onResponderTerminate={() => {
          last.current = option.step;
          setDragged(undefined);
        }}
        style={styles.track}
      >
        {/* Decoration never takes the touch: a press on the thumb would report
            its position inside the thumb, not along the track. */}
        <View pointerEvents="none" style={styles.rail} />
        {step === null ? null : (
          <View
            pointerEvents="none"
            style={[styles.fill, { width: `${(step / (option.steps.length - 1)) * 100}%` }]}
          />
        )}
        {option.steps.map((choice, index) => (
          <View
            key={choice.value}
            pointerEvents="none"
            style={[
              styles.tick,
              { left: `${(index / (option.steps.length - 1)) * 100}%` },
              step !== null && index <= step && styles.tickFilled,
            ]}
          />
        ))}
        {step === null ? null : (
          <View
            pointerEvents="none"
            style={[styles.thumb, { left: `${(step / (option.steps.length - 1)) * 100}%` }]}
          />
        )}
      </View>
      <View style={styles.control}>
        <AppText role="caption" tone="muted" style={styles.rowCopy}>
          Quicker
        </AppText>
        <AppText role="caption" tone="muted">
          Deeper
        </AppText>
      </View>
      {option.automatic ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: option.step === null, disabled }}
          disabled={disabled}
          onPress={() => {
            void Haptics.selectionAsync();
            onChange(option.id, option.automatic!.value);
          }}
          style={[styles.chip, option.step === null && material.selected]}
        >
          <AppText>{option.automatic.label}</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    backgroundColor: color.textSoft,
    borderRadius: 2,
    height: 4,
    left: 0,
    position: "absolute",
  },
  rail: { backgroundColor: color.lineStrong, borderRadius: 2, height: 4 },
  thumb: {
    backgroundColor: color.text,
    borderRadius: 11,
    height: 22,
    marginLeft: -11,
    position: "absolute",
    width: 22,
  },
  tick: {
    backgroundColor: color.muted,
    borderRadius: 2,
    height: 4,
    marginLeft: -2,
    position: "absolute",
    width: 4,
  },
  tickFilled: { backgroundColor: color.surface },
  track: { justifyContent: "center", minHeight: 44 },
  // Engines are quiet capsules; the one being browsed is lifted, not filled
  // with the accent, which belongs to the action that commits a choice.
  chip: {
    ...material.quiet,
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.full,
    borderWidth: 1,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[16] - 1,
  },
  chipPressed: { transform: [{ scale: 0.97 }] },
  chipSelected: { ...material.selected },
  conversationRow: {
    alignItems: "center",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
  },
  review: { gap: space[12], padding: space[16] },
  reviewCancel: { alignItems: "center", justifyContent: "center", minHeight: touchTarget },
  bar: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
  },
  // The system's own sheet buttons: a quiet disc, no rim.
  barButton: {
    ...material.quiet,
    alignItems: "center",
    borderRadius: radius.full,
    height: 36,
    justifyContent: "center",
    margin: (touchTarget - 36) / 2,
    width: 36,
  },
  barButtonPressed: { backgroundColor: material.selected.backgroundColor },
  barButtonSpace: { width: touchTarget },
  barTitle: { alignItems: "center", flex: 1, minWidth: 0, paddingHorizontal: space[4] },
  // The sheet owns the grabber; the list owns its clearance on every subpage.
  content: { paddingTop: space[24] },
  controlValue: { flexShrink: 1, textAlign: "right" },
  control: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    minHeight: 52,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  dimmed: { opacity: 0.62 },
  menuTrigger: { alignSelf: "stretch" },
  row: {
    alignItems: "center",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: space[12],
    minHeight: 52,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  rowCopy: { flex: 1, gap: space[2], minWidth: 0 },
  rowPressed: { ...material.quiet },
  // No line height: iOS lifts a text field's glyphs inside a fixed one.
  searchField: {
    color: color.text,
    fontSize: type.body.fontSize,
    minHeight: touchTarget,
    paddingVertical: space[8],
  },
  freshStart: { gap: space[8], paddingTop: space[24] },
  startThread: { paddingTop: space[24] },
  toggle: { paddingVertical: 0 },
  unavailable: { gap: space[12], padding: space[16] },
});
