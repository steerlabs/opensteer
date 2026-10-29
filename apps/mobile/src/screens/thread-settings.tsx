import {
  canContinueThreadOnPlacement,
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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { canRespondToRequests } from "@opensteer/client/host";
import { operationDetail } from "../client/mobile-client.js";
import { color, controlFontScaleLimit, radius, space, touchTarget, type } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { executionLabel, startingPlacement } from "../thread/first-message.js";
import {
  cancelFirstMessagePickerAttempt,
  finishFirstMessagePickerAttempt,
} from "../thread/first-message-picker-attempt.js";
import {
  buildThreadModelPicker,
  settingsDisabledReason,
  type AccountRow,
  type EngineRow,
  type ModelRow,
  type OptionControl,
  type PickerRow,
  type PickerStep,
  type ThreadModelPicker,
} from "../thread/settings/settings-controller.js";
import { useThreadMutation } from "../thread/thread-mutation-registry.js";
import { useMobileClient, useMobileState } from "../ui/mobile-client-context.js";
import {
  AppText,
  Notice,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SwitchRow,
} from "../ui/primitives.js";
import { useListContentInsets, useReadingColumn } from "../ui/screen.js";
import { Symbol } from "../ui/symbol.js";

export type ThreadSettingsScreenProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly threadId: string;
}>;

export type NewThreadScreenProps = StaticScreenProps<{
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
  const { deploymentId, threadId } = props.route.params;
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
      deploymentId={deploymentId}
      hostClient={selection.hostClient}
      key={`${deploymentId}:${threadId}`}
      threadId={threadId}
    />
  );
}

function SubscribedThreadSettings(props: {
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
  const [step, setStep] = useState<PickerStep>(firstStep);
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

  // A half-made choice whose model or account has left the catalog is not
  // carried into a different pair: the picker returns to the start and says why.
  useEffect(() => {
    if (picker.lostStep === null) return;
    setStep(firstStep);
    setQuery("");
    setFailure(picker.lostStep);
  }, [picker.lostStep]);

  const back = useCallback((): void => {
    const account = step.kind === "account-models" ? placementForSelection(placements, step) : null;
    goToStep(
      step.kind === "account-models" && step.returnTo === "accounts" && account !== null
        ? { kind: "accounts", driverKind: account.driverKind }
        : firstStep,
    );
  }, [goToStep, step, placements]);

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
          ...selected.modelSelection.options,
          ...change.optionValues,
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
          void Haptics.selectionAsync();
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
      if (row.action.kind === "blocked" || row.action.kind === "refresh") {
        setFailure(row.action.reason);
        return;
      }
      goToStep({
        environmentId: row.placement.environmentId,
        harnessInstanceId: row.placement.harnessInstanceId,
        kind: "account-models",
        returnTo: step.kind === "account-models" ? step.returnTo : "accounts",
      });
    },
    [goToStep, step],
  );

  const changeOption = useCallback(
    (id: string, value: boolean | string): void => {
      const variant = picker.currentRoute;
      if (variant === null) return;
      dispatchRoute(variant, {
        busyKey: `option:${id}`,
        closeOnSuccess: false,
        optionValues: { [id]: value },
      });
    },
    [dispatchRoute, picker.currentRoute],
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
      currentTitle={`Current · ${currentPlacement?.engineName ?? props.thread.harnessLabel} · ${props.thread.modelLabel}`}
      onChangeAccess={changeAccess}
      applyingKey={applyingKey}
      disabledReason={applyingKey === null ? disabledReason : "Updating thread settings…"}
      failure={failure}
      hostClient={props.hostClient}
      onFailure={setFailure}
      footer={
        picker.step.kind === "engines" && currentPlacement !== null ? (
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
      onEngine={(row) => goToStep(row.nextStep)}
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
  readonly currentTitle: string;
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
    readonly onEngine: (row: EngineRow) => void;
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
  const listInsets = useListContentInsets(space[24]);
  const column = useReadingColumn();
  const data = useMemo(() => displayItems(props.picker), [props.picker]);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<DisplayItem>) => (
      <PickerListItem
        busy={
          item.kind === "row" &&
          (props.applyingKey === item.row.key || refreshingKey === item.row.key)
        }
        disabled={props.disabledReason !== null || refreshingKey !== null}
        item={item}
        onAccount={chooseAccount}
        onModel={props.onModel}
        onEngine={props.onEngine}
      />
    ),
    [
      props.applyingKey,
      props.disabledReason,
      chooseAccount,
      props.onModel,
      props.onEngine,
      refreshingKey,
    ],
  );
  return (
    <FlatList
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.content, column, listInsets]}
      contentInsetAdjustmentBehavior="never"
      data={data}
      extraData={props.applyingKey}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      ListFooterComponent={<>{props.footer}</>}
      ListHeaderComponent={
        <PickerHeader
          accessMode={props.accessMode}
          accessPlacement={props.accessPlacement}
          currentTitle={props.currentTitle}
          onChangeAccess={props.onChangeAccess}
          applyingKey={props.applyingKey}
          disabledReason={props.disabledReason}
          failure={props.failure}
          onBack={props.onBack}
          onChangeOption={props.onChangeOption}
          onChangeQuery={props.onChangeQuery}
          onClose={props.onClose}
          onDismissFailure={props.onDismissFailure}
          picker={props.picker}
          query={props.query}
        />
      }
      nestedScrollEnabled
      renderItem={renderItem}
    />
  );
}

/**
 * Which AI a first message starts its Thread on, chosen before that Thread
 * exists. Each choice is recorded as this person's latest, which is what the
 * first message reads back; nothing is started here — the message does that.
 */
export function NewThreadScreen(props: NewThreadScreenProps): ReactNode {
  const navigation = useNavigation();
  const { deploymentId, home = false, pickerAttemptId } = props.route.params;
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
      deploymentId={deploymentId}
      home={home}
      hostClient={selection.hostClient}
      key={`${deploymentId}:${home ? "home" : "task"}`}
      {...(pickerAttemptId === undefined ? {} : { pickerAttemptId })}
    />
  );
}

function SubscribedNewThread(props: {
  readonly deploymentId: string;
  readonly home: boolean;
  readonly hostClient: HostClient;
  readonly pickerAttemptId?: string;
}): ReactNode {
  const { snapshot } = useHostSnapshot(props.hostClient);
  const navigation = useNavigation();
  const client = useMobileClient();
  const [chosen, setChosen] = useState<ExecutionSelection | null>(null);
  const [step, setStep] = useState<PickerStep>(firstStep);
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
  const back = useCallback(() => {
    const account = step.kind === "account-models" ? placementForSelection(placements, step) : null;
    goToStep(
      step.kind === "account-models" && step.returnTo === "accounts" && account !== null
        ? { kind: "accounts", driverKind: account.driverKind }
        : firstStep,
    );
  }, [goToStep, step, placements]);

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

  useEffect(() => {
    if (picker.lostStep === null) return;
    setStep(firstStep);
    setQuery("");
    setFailure(picker.lostStep);
  }, [picker.lostStep]);

  const chooseRoute = useCallback(
    (
      requested: ExecutionRoute,
      change: { readonly busyKey: string; readonly optionValues?: ModelSelection["options"] },
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
          ...selectedRoute.modelSelection.options,
          ...change.optionValues,
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
          if (mounted.current && change.optionValues === undefined) goToStep(firstStep);
          void Haptics.selectionAsync();
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
    [client, disabledReason, displayed, goToStep, props.deploymentId, props.hostClient],
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
      if (!row.selected) chooseRoute(row.route, { busyKey: row.key });
      else goToStep(firstStep);
    },
    [chooseRoute, goToStep],
  );
  const chooseAccount = useCallback(
    (row: AccountRow): void => {
      if (row.action.kind === "blocked" || row.action.kind === "refresh") {
        setFailure(row.action.reason);
        return;
      }
      goToStep({
        environmentId: row.placement.environmentId,
        harnessInstanceId: row.placement.harnessInstanceId,
        kind: "account-models",
        returnTo: step.kind === "account-models" ? step.returnTo : "accounts",
      });
    },
    [goToStep, step],
  );
  const changeOption = useCallback(
    (id: string, value: boolean | string): void => {
      if (picker.currentRoute !== null) {
        chooseRoute(picker.currentRoute, {
          busyKey: `option:${id}`,
          optionValues: { [id]: value },
        });
      }
    },
    [chooseRoute, picker.currentRoute],
  );
  return (
    <ModelPickerList
      accessMode={preferences.accessMode}
      accessPlacement={displayed === null ? null : placementForSelection(placements, displayed)}
      currentTitle={
        displayed === null
          ? "Current · Choose AI"
          : `Current · ${placementForSelection(placements, displayed)?.engineName ?? "Unavailable engine"} · ${executionLabel(placements, displayed)}`
      }
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
      onEngine={(row) => goToStep(row.nextStep)}
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
      <BarButton icon="xmark" label="Close model picker" onPress={props.onClose} />
    </View>
  );
}

function BarButton(props: {
  readonly icon: "chevron.left" | "xmark";
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

function PickerHeader(
  props: CurrentSettingsProps & {
    readonly applyingKey: string | null;
    readonly disabledReason: string | null;
    readonly failure: string | null;
    readonly onBack: (() => void) | null;
    readonly onChangeOption: (id: string, value: boolean | string) => void;
    readonly onChangeQuery: (query: string) => void;
    readonly onClose: () => void;
    readonly onDismissFailure: () => void;
    readonly picker: ThreadModelPicker;
    readonly query: string;
  },
): ReactNode {
  const { picker } = props;
  return (
    <View style={styles.header}>
      <SheetBar
        onBack={props.onBack}
        onClose={props.onClose}
        subtitle={picker.subtitle}
        title={picker.title}
      />
      {props.disabledReason === null ? null : (
        <AppText role="caption" tone="muted">
          {props.disabledReason}
        </AppText>
      )}
      {props.failure === null ? null : (
        <Notice
          action={{ label: "Dismiss", onPress: props.onDismissFailure }}
          detail={props.failure}
          title="That did not change"
        />
      )}
      {picker.step.kind === "engines" ? (
        <View style={styles.header}>
          <AppText role="secondaryMedium" tone="muted">
            {props.currentTitle}
          </AppText>
          <RowGroup>
            {picker.options.map((option) => (
              <OptionField
                busy={props.applyingKey === `option:${option.id}`}
                disabledReason={props.disabledReason}
                key={option.id}
                onChange={props.onChangeOption}
                option={option}
              />
            ))}
            <AccessField
              accessMode={props.accessMode}
              busy={props.applyingKey === "access"}
              disabledReason={props.disabledReason}
              onChange={props.onChangeAccess}
              placement={props.accessPlacement}
            />
          </RowGroup>
        </View>
      ) : null}
      {picker.showSearch ? (
        <View style={styles.search}>
          <Symbol name="magnifyingglass" size={15} tint={color.muted} />
          <TextInput
            accessibilityLabel="Search models"
            autoCapitalize="none"
            autoCorrect={false}
            cursorColor={color.ember}
            maxFontSizeMultiplier={controlFontScaleLimit}
            onChangeText={props.onChangeQuery}
            placeholder="Search models"
            placeholderTextColor={color.muted}
            returnKeyType="search"
            selectionColor={color.ember}
            style={styles.searchField}
            value={props.query}
          />
          {props.query.length === 0 ? null : (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              onPress={() => props.onChangeQuery("")}
              style={styles.searchClear}
            >
              <Symbol name="xmark" size={13} tint={color.muted} />
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}

function AccessField(props: {
  readonly accessMode: ThreadAccessMode;
  readonly busy: boolean;
  readonly disabledReason: string | null;
  readonly onChange: (mode: ThreadAccessMode) => void;
  readonly placement: ThreadPlacementOption | null;
}): ReactNode {
  const label =
    accessModeOptions.find((option) => option.mode === props.accessMode)?.label ?? props.accessMode;
  return (
    <NativeMenu
      accessibilityHint="Changes what this thread may do without asking"
      accessibilityLabel={`Access: ${label}`}
      disabledReason={props.disabledReason}
      onPresent={noop}
      onSettle={noop}
      style={styles.menuTrigger}
      title="Access"
      options={accessModeOptions.map((option) => {
        const reason = accessModeUnavailableReason(
          option.mode,
          props.placement ?? { accessModes: null, engineName: "This engine" },
        );
        return {
          id: option.mode,
          label: reason === null ? option.label : `${option.label} — ${reason}`,
          disabled: reason !== null,
          selected: option.mode === props.accessMode,
          onPress: () => {
            if (reason === null && option.mode !== props.accessMode) props.onChange(option.mode);
          },
        };
      })}
    >
      <View style={styles.control}>
        <AppText role="body" style={styles.rowCopy}>
          Access
        </AppText>
        {props.busy ? (
          <ActivityIndicator color={color.ember} />
        ) : (
          <>
            <AppText role="body" style={styles.controlValue} tone="muted">
              {label}
            </AppText>
            <Symbol name="chevron.down" size={12} tint={color.muted} />
          </>
        )}
      </View>
    </NativeMenu>
  );
}

function OptionField(props: {
  readonly busy: boolean;
  readonly disabledReason: string | null;
  readonly onChange: (id: string, value: boolean | string) => void;
  readonly option: OptionControl;
}): ReactNode {
  const { option } = props;
  if (option.kind === "toggle") {
    return (
      <View style={[styles.control, styles.toggle]}>
        <View style={styles.rowCopy}>
          <SwitchRow
            disabled={props.disabledReason !== null || props.busy}
            label={option.label}
            onChange={(next) => props.onChange(option.id, next)}
            value={option.value}
          />
        </View>
        {props.busy ? <ActivityIndicator color={color.ember} /> : null}
      </View>
    );
  }
  // A native menu holds any number of values, where a segmented control
  // squeezes past four into labels nobody can read.
  return (
    <NativeMenu
      accessibilityHint={`Choose ${option.label.toLocaleLowerCase()}`}
      accessibilityLabel={`${option.label}: ${option.valueLabel}`}
      disabledReason={props.disabledReason}
      onPresent={noop}
      onSettle={noop}
      options={option.values.map((value) => ({
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
            <Symbol name="chevron.down" size={12} tint={color.muted} />
          </>
        )}
      </View>
    </NativeMenu>
  );
}

function noop(): void {}

type DisplayItem =
  | { readonly key: string; readonly kind: "heading"; readonly title: string }
  | {
      readonly first: boolean;
      readonly key: string;
      readonly kind: "row";
      readonly last: boolean;
      readonly row: PickerRow;
    }
  | { readonly key: string; readonly kind: "empty"; readonly message: string };

function displayItems(picker: ThreadModelPicker): DisplayItem[] {
  if (picker.emptyMessage !== null) {
    return [{ key: "empty", kind: "empty", message: picker.emptyMessage }];
  }
  return picker.sections.flatMap((section): DisplayItem[] => [
    ...(section.title === null
      ? []
      : [{ key: `heading:${section.id}`, kind: "heading" as const, title: section.title }]),
    ...section.rows.map((row, index) => ({
      first: index === 0,
      key: `${section.id}:${row.key}`,
      kind: "row" as const,
      last: index === section.rows.length - 1,
      row,
    })),
  ]);
}

const PickerListItem = memo(function PickerListItem(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly item: DisplayItem;
  readonly onAccount: (row: AccountRow) => void;
  readonly onEngine: (row: EngineRow) => void;
  readonly onModel: (row: ModelRow) => void;
}): ReactNode {
  const { item } = props;
  if (item.kind === "heading") {
    return (
      <AppText role="secondaryMedium" style={styles.sectionLabel} tone="muted">
        {item.title}
      </AppText>
    );
  }
  if (item.kind === "empty") {
    return (
      <View style={styles.empty}>
        <AppText role="secondary" tone="muted">
          {item.message}
        </AppText>
      </View>
    );
  }
  const { row } = item;
  const frame = [
    styles.rowFrame,
    item.first && styles.rowFirst,
    item.last && styles.rowLast,
    !item.last && styles.rowJoined,
  ];
  if (row.kind === "unavailable") {
    return (
      <View
        accessibilityState={{ disabled: true, selected: row.selected }}
        style={[frame, styles.row, styles.dimmed]}
      >
        <RowCopy detail={row.detail} detailTone="danger" title={row.title} />
        {row.selected ? <Symbol name="checkmark" tint={color.ember} /> : null}
      </View>
    );
  }
  if (row.kind === "account" && row.action.kind === "refresh") {
    return (
      <View style={[frame, styles.row]}>
        <RowCopy detail={row.detail} detailTone="danger" title={row.title} />
        <SecondaryButton
          disabled={props.disabled}
          label={props.busy ? "Checking…" : "Check again"}
          onPress={() => props.onAccount(row)}
        />
      </View>
    );
  }
  // A blocked row stays pressable to repeat its reason in the notice above,
  // but it reads as unavailable and never changes anything.
  const blocked =
    row.kind === "model"
      ? row.blockedReason !== null
      : row.kind === "account" && row.action.kind === "blocked";
  const leadsOn =
    row.kind === "engine" || (row.kind === "account" && row.action.kind === "choose-model");
  return (
    <Pressable
      accessibilityHint={leadsOn ? "Opens a second choice" : undefined}
      accessibilityRole={leadsOn ? "button" : "radio"}
      accessibilityLabel={row.kind === "engine" ? `Engine: ${row.title}, ${row.detail}` : undefined}
      accessibilityState={{
        busy: props.busy,
        disabled: props.disabled || blocked,
        selected: row.selected,
      }}
      disabled={props.disabled}
      onPress={() => {
        if (row.kind === "engine") props.onEngine(row);
        else if (row.kind === "model") props.onModel(row);
        else props.onAccount(row);
      }}
      style={({ pressed }) => [
        frame,
        styles.row,
        pressed && styles.pressed,
        blocked && styles.dimmed,
      ]}
    >
      <RowCopy detail={row.detail} detailTone={blocked ? "danger" : "muted"} title={row.title} />
      {props.busy ? (
        <ActivityIndicator color={color.ember} />
      ) : row.selected ? (
        <Symbol name="checkmark" tint={color.ember} />
      ) : leadsOn ? (
        <Symbol name="chevron.right" size={14} tint={color.muted} />
      ) : null}
    </Pressable>
  );
});

function RowCopy(props: {
  readonly detail: string | null;
  readonly detailTone: "danger" | "muted";
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.rowCopy}>
      <AppText role="body">{props.title}</AppText>
      {props.detail === null ? null : (
        <AppText role="caption" tone={props.detailTone}>
          {props.detail}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  review: { gap: space[12], padding: space[16] },
  reviewCancel: { alignItems: "center", justifyContent: "center", minHeight: touchTarget },
  bar: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
  },
  barButton: {
    alignItems: "center",
    borderRadius: radius.full,
    justifyContent: "center",
    minHeight: touchTarget,
    width: touchTarget,
    backgroundColor: color.surfaceElevated,
  },
  barButtonPressed: { backgroundColor: color.surfacePressed },
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
  empty: { alignItems: "center", paddingHorizontal: space[16], paddingVertical: space[32] },
  header: { gap: space[12], marginBottom: space[4] },
  menuTrigger: { alignSelf: "stretch" },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: 52,
    paddingHorizontal: space[14],
    paddingVertical: space[8],
  },
  rowCopy: { flex: 1, gap: space[2], minWidth: 0 },
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowFrame: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  rowJoined: { borderBottomWidth: 0 },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  search: {
    alignItems: "center",
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    minHeight: touchTarget,
    paddingLeft: space[12],
  },
  searchClear: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  // No line height: iOS lifts a text field's glyphs inside a fixed one.
  searchField: {
    color: color.text,
    flex: 1,
    fontSize: type.body.fontSize,
    minHeight: touchTarget,
    paddingVertical: space[8],
  },
  freshStart: { gap: space[8], paddingTop: space[24] },
  startThread: { paddingTop: space[24] },
  sectionLabel: {
    paddingBottom: space[6],
    paddingHorizontal: space[12],
    paddingTop: space[18],
  },
  toggle: { paddingVertical: 0 },
  unavailable: { gap: space[12], padding: space[16] },
});
