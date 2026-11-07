import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  chatExecutionDecision,
  chatExecutionSelection,
  executionSelectionForPlacement,
  lastExecutionSelection,
  placementForSelection,
  type ExecutionSelection,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { EngineMark } from "../model-picker.js";
import { ProviderLogo } from "../provider-brand.js";
import { ErrorNotice } from "../onboarding-card.js";
import { setupAiRows, type SetupAiRow, type SetupPlan } from "./setup-ai.js";
import { SetupFooter, SetupFrame } from "./setup-frame.js";
import { SetupList, SetupRow } from "./setup-list.js";
import { usePlanAccount } from "./use-plan-account.js";

/**
 * Step one: the AI the person already pays for. Rows come from what this
 * computer reports, so a sign-in finished in a browser, a CLI installed in a
 * terminal, or a change made in Settings simply shows up here.
 */
export function SetupAiStep({
  onBack,
  onNext,
  progress,
}: {
  readonly onBack?: (() => void) | undefined;
  readonly onNext: () => void;
  readonly progress: { readonly count: number; readonly index: number };
}) {
  const {
    desktopBridge,
    executionPreferences,
    hostClient,
    openHarnessAuthentication,
    placements,
    refreshHarnessCatalog,
    snapshot,
  } = useShell();
  const { more, rows } = useMemo(
    () => setupAiRows(placements, snapshot.environments),
    [placements, snapshot.environments],
  );
  const main = snapshot.environments.find((environment) => environment.kind === "main") ?? null;
  // Right after this computer starts, its Runner has not said which engines
  // it has. That is a wait, not an empty computer.
  const discovering = main !== null && main.connected && main.harnessDrivers.length === 0;
  const offline = main !== null && !main.connected;
  const ready = rows.flatMap((row) => (row.kind === "ready" ? [row.placement] : []));
  const home = snapshot.threads.find(({ id }) => id === snapshot.homeThreadId);
  const existing = home
    ? {
        environmentId: home.environmentId,
        harnessInstanceId: home.harnessInstanceId,
        modelSelection: home.modelSelection,
      }
    : null;
  const [chosen, setChosen] = useState<ExecutionSelection | null>(null);
  const remembered = lastExecutionSelection(executionPreferences);
  const decided = chatExecutionDecision({ chosen, existing, remembered });
  const selection =
    chatExecutionSelection({ chosen, existing, placements: ready, remembered }) ??
    (decided === null && ready[0] ? executionSelectionForPlacement(ready[0]) : null);
  const selected = selection ? (placementForSelection(ready, selection) ?? null) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [installing, setInstalling] = useState<readonly string[]>([]);
  const plans = usePlanAccount({
    client: hostClient,
    harnesses: snapshot.harnesses,
    onAuthenticate: openHarnessAuthentication,
    placements,
  });

  // Coming back to this window is when a sign-in finished in a browser or a
  // CLI installed in a terminal should show: look again then, and only then.
  useEffect(() => {
    const check = () => {
      for (const placement of placements) {
        if (
          placement.environmentKind === "main" &&
          placement.availability === "authentication-required"
        ) {
          void refreshHarnessCatalog(placement).catch(() => undefined);
        }
      }
      void desktopBridge?.recheckLocalEngines().catch(() => undefined);
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [desktopBridge, placements, refreshHarnessCatalog]);

  const act = (row: SetupAiRow) => {
    if (row.kind !== "plan") return;
    const { action, plan } = row;
    if (action.kind === "sign-in") {
      openHarnessAuthentication?.(
        action.placement,
        action.methodId ? { methodId: action.methodId } : undefined,
      );
    } else if (action.kind === "add") {
      plans.add(plan, action.environmentId);
    } else if (action.kind === "get") {
      setInstalling((current) => (current.includes(plan.id) ? current : [...current, plan.id]));
      void openExternal(desktopBridge, action.installUrl);
    }
  };

  async function next() {
    if (saving) return;
    if (!selection) {
      onNext();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await hostClient.rememberExecution({ selection });
      onNext();
    } catch (reason) {
      setError(actionErrorMessage(reason));
      setSaving(false);
    }
  }

  const rowView = (row: SetupAiRow) => (
    <AiRow
      adding={row.kind === "plan" && plans.adding === row.plan.id}
      error={
        row.kind === "plan" && plans.error?.planId === row.plan.id ? plans.error.message : null
      }
      installing={row.kind === "plan" && installing.includes(row.plan.id)}
      key={row.key}
      onAct={() => act(row)}
      onChoose={(placement) => setChosen(executionSelectionForPlacement(placement))}
      row={row}
      selected={
        row.kind === "ready" && selected?.harnessInstanceId === row.placement.harnessInstanceId
      }
    />
  );

  return (
    <SetupFrame
      description="Sign in to the AI you already pay for, and pick one to start with."
      footer={
        <SetupFooter
          action={
            <button
              className="btn btn--primary"
              disabled={saving || !selected?.available}
              onClick={() => void next()}
              type="button"
            >
              {saving ? "Saving…" : "Continue"}
            </button>
          }
          onBack={onBack}
          onSkip={onNext}
        />
      }
      progress={progress}
      stepKey="ai"
      title="Your AI"
    >
      {discovering ? (
        <SetupList label="AI on this computer">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </SetupList>
      ) : (
        <>
          <SetupList label="AI on this computer">
            {rows.map(rowView)}
            {more.length > 0 ? (
              <SetupRow
                as="button"
                detail="Cursor, GitHub Copilot and others"
                icon={<Icon name="plus" />}
                onClick={() => setMoreOpen(true)}
                title="More AI"
                trailing={<Icon className="setup-row__chevron" name="chevron-right" />}
              />
            ) : null}
          </SetupList>
          {offline ? (
            <p className="setup-frame__note" role="status">
              <span aria-hidden className="spinner" /> Reconnecting to this computer…
            </p>
          ) : rows.length === 0 ? (
            <p className="setup-frame__note">
              No AI is available here yet. <Link to="/settings/ai">Add one in Settings</Link>
            </p>
          ) : null}
        </>
      )}
      <ErrorNotice message={error} />
      {moreOpen ? (
        <Dialog onClose={() => setMoreOpen(false)} title="More AI">
          <div className="setup-more">
            <SetupList label="More AI">{more.map(rowView)}</SetupList>
            <p className="setup-more__note">
              Using an API key or a model running on this computer?{" "}
              <Link onClick={() => setMoreOpen(false)} to="/settings/ai">
                Add it in Settings
              </Link>
            </p>
          </div>
        </Dialog>
      ) : null}
    </SetupFrame>
  );
}

function AiRow({
  adding,
  error,
  installing,
  onAct,
  onChoose,
  row,
  selected,
}: {
  readonly adding: boolean;
  readonly error: string | null;
  readonly installing: boolean;
  readonly onAct: () => void;
  readonly onChoose: (placement: ThreadPlacementOption) => void;
  readonly row: SetupAiRow;
  readonly selected: boolean;
}) {
  if (row.kind === "ready") {
    return (
      <SetupRow
        as="button"
        checked={selected}
        detail={row.detail}
        icon={
          row.providerId ? (
            <ProviderLogo providerId={row.providerId} />
          ) : (
            <EngineMark driverKind={row.placement.driverKind} />
          )
        }
        onClick={() => onChoose(row.placement)}
        role="radio"
        title={row.name}
        tone="ready"
        trailing={<span aria-hidden className="setup-radio" />}
      />
    );
  }
  const { action, plan } = row;
  const icon = <PlanMark plan={plan} />;
  if (error) {
    return (
      <SetupRow
        detail={<span role="alert">{error}</span>}
        icon={icon}
        title={plan.name}
        tone="attention"
        trailing={
          <button className="btn btn--small" onClick={onAct} type="button">
            Try again
          </button>
        }
      />
    );
  }
  if (action.kind === "working" || adding) {
    return (
      <SetupRow
        detail="Getting ready…"
        icon={icon}
        title={plan.name}
        trailing={<span aria-hidden className="spinner" />}
      />
    );
  }
  if (action.kind === "get") {
    return (
      <SetupRow
        detail={installing ? "Install it. It shows up here on its own." : "Not on this computer"}
        icon={icon}
        title={plan.name}
        tone="missing"
        trailing={
          <button className="btn btn--small" onClick={onAct} type="button">
            Get
          </button>
        }
      />
    );
  }
  return (
    <SetupRow
      detail="Not signed in"
      icon={icon}
      title={plan.name}
      trailing={
        <button className="btn btn--small" onClick={onAct} type="button">
          Sign in
        </button>
      }
    />
  );
}

function PlanMark({ plan }: { readonly plan: SetupPlan }) {
  return <ProviderLogo providerId={plan.providerId} />;
}

function SkeletonRow() {
  return (
    <SetupRow
      detail={<span aria-hidden className="skeleton setup-row__skeleton" />}
      icon={<span aria-hidden className="skeleton setup-row__skeleton-icon" />}
      title={
        <span aria-hidden className="skeleton setup-row__skeleton setup-row__skeleton--title" />
      }
      tone="missing"
    />
  );
}

async function openExternal(
  bridge: { openExternalUrl: (input: { url: string }) => Promise<unknown> } | null,
  url: string,
): Promise<void> {
  if (bridge) {
    await bridge.openExternalUrl({ url }).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
