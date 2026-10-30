import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_THREAD_ACCESS_MODE,
  type ExecutionPreferences,
  type ModelSelection,
  type ThreadAccessMode,
} from "@opensteer/core";
import {
  accessModeOptions,
  findRoute,
  executionUsageNotice,
  routeOnAccount,
  selectionForModel,
  selectionForRoute,
  type ExecutionRoute,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { AccessModeControl, accessModeGlyph } from "./access-mode-control.js";
import { Icon } from "./icon.js";
import type { ExecutionAccess } from "./execution-settings.js";
import { optionsSummary } from "@opensteer/client/host";
import { ModelPicker } from "./model-picker.js";
import { Popover } from "./popover.js";
import {
  switchConsequence,
  type AccessChange,
  type ExecutionSwitchReview,
  type ReviewedChoice,
} from "./execution-review.js";

interface ExecutionControlsProps {
  access?: ExecutionAccess | undefined;
  suppressUsageNotice?: boolean;
  /**
   * The current choice — picked this visit or remembered by the Host — when it
   * no longer resolves to an available placement. Nothing is applied over it,
   * so the picker keeps naming it and the composer stays blocked.
   */
  blocked?: ExecutionSelection | null;
  disabled?: boolean;
  /**
   * Applies a new selection (server call for an existing Thread, local state
   * for a composer that has not started one). Must handle its own errors —
   * the controls re-render from `selection`, so a failed apply reverts.
   *
   * `reviewed` is present only for a choice the reader reviewed and confirmed.
   */
  onApply: (
    selection: ExecutionSelection,
    reviewed?: ReviewedChoice,
  ) => Promise<boolean | void> | boolean | void;
  onAuthenticate?: ((placement: ThreadPlacementOption) => void) | undefined;
  onRefresh?: ((placement: ThreadPlacementOption) => Promise<void>) | undefined;
  placements: readonly ThreadPlacementOption[];
  preferences: ExecutionPreferences;
  /**
   * Decides what a candidate choice would do before it is applied. Without it
   * every choice applies straight away, which is right for a composer that has
   * not started a conversation yet: there is no session to lose.
   */
  review?: ((selection: ExecutionSelection) => ExecutionSwitchReview) | undefined;
  /**
   * Decides what starting the AI already in use over again would do. Present
   * only for a conversation that has one; the picker then offers that as an
   * explicit action, reviewed exactly like a change of engine.
   */
  reviewFresh?: (() => ExecutionSwitchReview) | undefined;
  /**
   * Nothing is chosen yet and something could be: the first pill is the
   * composer's primary action, "Choose AI", until a choice is made.
   */
  required?: boolean;
  /** Focused after an applied change, so the reader carries on writing. */
  returnFocusRef?: React.RefObject<HTMLTextAreaElement | null> | undefined;
  selection: ExecutionSelection | null;
}

/**
 * The composer row's execution choice as one control: the engine's mark and,
 * in words, the engine, the model and its reasoning level. Its menu holds the
 * rest — accounts, models, the model's options and the access mode. Access
 * joins it in the footer only when it differs from Full access.
 *
 * A choice that would end the conversation's current session, or that needs
 * a different access mode, is not applied on press. It opens a review in the
 * same place, naming what stays and what changes; only the reader's
 * confirmation applies it, carrying the session they reviewed.
 */
export function ExecutionControls({
  access,
  suppressUsageNotice = false,
  blocked = null,
  disabled = false,
  onApply,
  onAuthenticate,
  onRefresh,
  placements,
  preferences,
  required = false,
  review,
  reviewFresh,
  returnFocusRef,
  selection,
}: ExecutionControlsProps) {
  const [conversationRequest, setConversationRequest] = useState(0);
  const usage = suppressUsageNotice ? null : executionUsageNotice(placements, selection);
  const [pending, setPending] = useState(false);
  const [candidate, setCandidate] = useState<{
    readonly outcome: ExecutionSwitchReview;
    readonly selection: ExecutionSelection;
  } | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [noticeTarget, setNoticeTarget] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setNoticeTarget(
      rowRef.current?.closest(".composer")?.querySelector("[data-composer-notice]") ?? null,
    );
  }, []);
  const current = findRoute(placements, selection);
  // A choice that cannot run right now — remembered for a draft, or a Thread's
  // own — stays the pill's subject, named and marked, rather than "Choose AI".
  const stuck = blocked ?? (selection !== null && current === null ? selection : null);
  /** Cancel changes nothing at all, and hands the keyboard back to the pill. */
  const cancelReview = () => {
    setCandidate(null);
    rowRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  };

  const commit = async (next: ExecutionSelection, reviewed?: ReviewedChoice) => {
    setPending(true);
    try {
      await (reviewed ? onApply(next, reviewed) : onApply(next));
    } finally {
      setPending(false);
    }
  };

  /** Applies straight away, or opens the review the choice calls for. */
  const apply = async (next: ExecutionSelection) => {
    const outcome = review?.(next) ?? { kind: "compatible" as const };
    if (outcome.kind === "compatible") {
      await commit(next);
      return;
    }
    setCandidate({ outcome, selection: next });
  };

  const confirmReview = async (accessMode: ThreadAccessMode | null) => {
    const outcome = candidate?.outcome;
    if (
      !candidate ||
      !outcome ||
      (outcome.kind !== "fresh" && outcome.kind !== "incompatible" && outcome.kind !== "access")
    ) {
      return;
    }
    setCandidate(null);
    await commit(candidate.selection, {
      ...(accessMode !== null ? { accessMode } : {}),
      ...(outcome.kind !== "access"
        ? {
            continuation: {
              expectedProviderSessionId: outcome.expectedProviderSessionId,
              fresh: outcome.kind === "fresh",
            },
          }
        : {}),
    });
    // Apply returns the reader to what they were writing, with the draft,
    // quote, files and reading position exactly where they left them.
    returnFocusRef?.current?.focus();
  };

  /**
   * Starting over on the AI already in use. It changes no account, model or
   * option: the selection sent back is the one in force, and only the reviewed
   * session id makes it a new native session.
   */
  const startFresh = () => {
    if (!reviewFresh || !selection) return;
    setCandidate({ outcome: reviewFresh(), selection });
  };

  const chooseRoute = (route: ExecutionRoute) =>
    void apply(selectionForRoute(route, selection, preferences.history));

  const chooseAccount = (placement: ThreadPlacementOption) => {
    const route = routeOnAccount(placement, selection, preferences.history);
    if (route) chooseRoute(route);
  };

  const changeOptions = (options: ModelSelection["options"]) => {
    if (!selection || !current) return;
    void apply({ ...selection, modelSelection: selectionForModel(current.model, options) });
  };

  const controlsDisabled = disabled || pending;
  // Full access needs no reminder in the footer.
  const accessWorthSeeing = access !== undefined && access.mode !== DEFAULT_THREAD_ACCESS_MODE;
  const options = current && selection ? current.model.options : [];
  const notice = usage ? (
    <div className="composer-usage" role="status">
      {usage.accountTitle} is out of {usage.engineName} usage
      {usage.resetsAt ? ` until ${usage.resetsAt}` : ""}.{" "}
      {usage.canSwitch ? (
        <button
          type="button"
          disabled={controlsDisabled}
          onClick={() => setConversationRequest((value) => value + 1)}
        >
          Switch account
        </button>
      ) : null}
    </div>
  ) : null;
  return (
    <div className="exec-controls" ref={rowRef}>
      {noticeTarget ? createPortal(notice, noticeTarget) : notice}
      <ModelPicker
        conversationRequest={conversationRequest}
        onAccount={chooseAccount}
        blocked={stuck}
        disabled={controlsDisabled}
        // Offered on the AI in use as well as beside the others: recovering an
        // uncertain native session must not need a detour through another
        // engine and back.
        freshStart={
          reviewFresh && current
            ? { label: `Start fresh with ${current.placement.engineName}`, onSelect: startFresh }
            : undefined
        }
        history={preferences.history}
        onAuthenticate={onAuthenticate}
        onRefresh={onRefresh}
        onSelect={chooseRoute}
        placements={placements}
        required={required && selection === null && blocked === null}
        selection={selection}
        settings={{
          access: access ?? null,
          current: current
            ? `${current.placement.engineName} · ${current.model.displayName}`
            : null,
          options:
            current && selection && options.length > 0
              ? {
                  model: current.model,
                  onChange: changeOptions,
                  values: selection.modelSelection.options,
                }
              : null,
        }}
        summary={
          current && selection && options.length > 0
            ? optionsSummary(current.model, selection.modelSelection.options)
            : null
        }
      />
      {access && accessWorthSeeing ? (
        <AccessModeControl
          disabled={controlsDisabled}
          engine={access.engine}
          mode={access.mode}
          onApply={access.onApply}
        />
      ) : null}
      {candidate && rowRef.current ? (
        <Popover
          anchor={rowRef.current}
          className="popover--review"
          label="Review this change"
          onClose={cancelReview}
          role="dialog"
        >
          <ExecutionSwitchReviewPanel
            onCancel={cancelReview}
            onConfirm={(accessMode) => void confirmReview(accessMode)}
            outcome={candidate.outcome}
            pending={pending}
          />
        </Popover>
      ) : null}
    </div>
  );
}

const accessLabel = (mode: ThreadAccessMode) =>
  accessModeOptions.find((option) => option.mode === mode)?.label ?? mode;

/**
 * The review step, in the same place the picker was. It states the
 * consequence and nothing more: it never claims memory transferred, that
 * nothing changes, or that the new engine has already caught up. When the
 * engine cannot keep the conversation's access mode, the reader picks one it
 * can here, so nothing is changed on their behalf.
 */
function ExecutionSwitchReviewPanel({
  onCancel,
  onConfirm,
  outcome,
  pending,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: (accessMode: ThreadAccessMode | null) => void;
  readonly outcome: ExecutionSwitchReview;
  readonly pending: boolean;
}) {
  // Nothing is chosen for the reader: confirming waits until they pick a mode.
  const [accessMode, setAccessMode] = useState<ThreadAccessMode | null>(null);
  if (outcome.kind === "compatible") return null;
  if (outcome.kind === "unavailable") {
    return (
      <div className="switch-review">
        <h2 className="switch-review__title">This AI can’t run right now</h2>
        <p className="switch-review__body">{outcome.detail}</p>
        <div className="switch-review__actions">
          <button className="btn" data-autofocus onClick={onCancel} type="button">
            Back
          </button>
        </div>
      </div>
    );
  }
  if (outcome.kind === "busy") {
    return (
      <div className="switch-review">
        <h2 className="switch-review__title">This conversation is still working</h2>
        <p className="switch-review__body">{outcome.reason}</p>
        <div className="switch-review__actions">
          <button className="btn" data-autofocus onClick={onCancel} type="button">
            Back
          </button>
        </div>
      </div>
    );
  }
  if (outcome.kind === "access") {
    return (
      <div className="switch-review">
        <h2 className="switch-review__title">
          {outcome.engineName} can’t run in {accessLabel(outcome.access.current)}
        </h2>
        <p className="switch-review__body">
          Choose how much {outcome.engineName} may do in this conversation.
        </p>
        <AccessChoice change={outcome.access} onChange={setAccessMode} value={accessMode} />
        <div className="switch-review__actions">
          <button className="btn btn--ghost" data-autofocus onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={pending || accessMode === null}
            onClick={() => onConfirm(accessMode)}
            type="button"
          >
            {pending ? "Changing…" : `Use ${outcome.engineName}`}
          </button>
        </div>
      </div>
    );
  }
  const fresh = outcome.kind === "fresh";
  return (
    <div className="switch-review">
      <h2 className="switch-review__title">
        {fresh
          ? `Start fresh with ${outcome.engineName}?`
          : `Use ${outcome.engineName} for this conversation?`}
      </h2>
      <p className="switch-review__body">{switchConsequence(outcome)}</p>
      <p className="switch-review__detail">{outcome.accountName}</p>
      {outcome.access ? (
        <>
          <p className="switch-review__body">
            {outcome.engineName} can’t run in {accessLabel(outcome.access.current)}. Choose how much
            it may do:
          </p>
          <AccessChoice change={outcome.access} onChange={setAccessMode} value={accessMode} />
        </>
      ) : null}
      <div className="switch-review__actions">
        <button className="btn btn--ghost" data-autofocus onClick={onCancel} type="button">
          {fresh ? "Keep this session" : `Keep ${outcome.currentEngineName}`}
        </button>
        <button
          className="btn btn--primary"
          disabled={pending || (outcome.access !== null && accessMode === null)}
          onClick={() => onConfirm(outcome.access ? accessMode : null)}
          type="button"
        >
          {pending ? "Changing…" : fresh ? "Start fresh" : `Use ${outcome.engineName}`}
        </button>
      </div>
    </div>
  );
}

/** The access modes the target engine enforces, as a radio group. */
function AccessChoice({
  change,
  onChange,
  value,
}: {
  readonly change: AccessChange;
  readonly onChange: (mode: ThreadAccessMode) => void;
  readonly value: ThreadAccessMode | null;
}) {
  return (
    <div aria-label="Access mode" className="switch-review__choices" role="radiogroup">
      {change.offered.map((mode) => {
        const option = accessModeOptions.find((candidate) => candidate.mode === mode);
        return (
          <button
            aria-checked={value === mode}
            className="picker__row"
            key={mode}
            onClick={() => onChange(mode)}
            role="radio"
            type="button"
          >
            <span className="picker__check">{value === mode ? <Icon name="check" /> : null}</span>
            <span className="picker__glyph">
              <Icon name={accessModeGlyph[mode]} />
            </span>
            <span className="picker__label-stack">
              <span className="picker__label">{option?.label ?? mode}</span>
              {option ? <span className="picker__detail">{option.description}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
