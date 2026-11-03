import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AuthSessionSummary } from "@opensteer/core";
import {
  chatExecutionDecision,
  chatExecutionSelection,
  executionSelectionForPlacement,
  lastExecutionSelection,
  placementForSelection,
  unwrapRpcResult,
  type ExecutionSelection,
  type HostClient,
  type ThreadPlacementOption,
} from "@opensteer/client/host";
import {
  supportsPersonalAccountLink,
  usePersonalAccountLink,
} from "../../account/use-personal-account-link.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { AccountFix } from "../account-picker.js";
import { useShell } from "../app-shell.js";
import { Icon } from "../icon.js";
import { EngineMark } from "../model-picker.js";
import { ErrorNotice, OnboardingCard } from "../onboarding-card.js";
import { useNewPhoneSignIn, usePhoneSetup, type PhoneSetup } from "./phone-setup.js";
import { QrCode } from "./qr-code.js";
import { SetupList, SetupRow, SetupStatus } from "./setup-list.js";

/**
 * Setup, as one screen: this computer, the AI that does the work, and a phone.
 * Each row fills itself in from live state, so most people only press Start.
 * It opens on its own right after this computer is set up, and from the
 * computer menu any time after.
 */
export function SetupPage() {
  const {
    desktopBridge,
    desktopDeployment,
    executionPreferences,
    hostClient,
    openHarnessAuthentication,
    placements,
    refreshHarnessCatalog,
    snapshot,
  } = useShell();
  const navigate = useNavigate();
  const computerName =
    desktopDeployment?.name ?? snapshot.identityConfig?.deployment.name ?? "This computer";
  const local = useMemo(() => setupPlacements(placements), [placements]);
  // Right after this computer starts, its agents have not reported which AIs
  // they found yet. That is a wait, not an empty computer.
  const discovering =
    local.length === 0 &&
    snapshot.environments.some(
      (environment) => environment.kind === "main" && environment.harnessDrivers.length === 0,
    );
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
  // With nothing decided yet, setup offers the first ready AI rather than a
  // question: Start is then one press, and Change is right beside it.
  const selection =
    chatExecutionSelection({ chosen, existing, placements: local, remembered }) ??
    (decided === null ? firstReadySelection(local) : null);
  const selected = selection ? (placementForSelection(local, selection) ?? null) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A sign-in finished in a terminal or browser is only seen when asked for;
  // coming back to this window is the moment the person expects it to show.
  useEffect(() => {
    const check = () => {
      for (const placement of local) {
        if (placement.availability === "authentication-required") {
          void refreshHarnessCatalog(placement).catch(() => undefined);
        }
      }
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [local, refreshHarnessCatalog]);

  const onThisComputer =
    desktopBridge !== null &&
    desktopDeployment?.kind === "personal" &&
    desktopDeployment.onThisComputer;

  async function start() {
    if (!selection || saving) return;
    setSaving(true);
    setError(null);
    try {
      await hostClient.rememberExecution({ selection });
      void navigate("/", { replace: true });
    } catch (reason) {
      setError(actionErrorMessage(reason));
      setSaving(false);
    }
  }

  return (
    <OnboardingCard bare live title="Set up Opensteer">
      <div className="setup">
        <SetupList label="Setup">
          <SetupRow
            icon={<Icon name="laptop" />}
            title={computerName}
            trailing={
              snapshot.connection === "connected" ? (
                <SetupStatus label="Ready" state="ready" />
              ) : (
                <SetupStatus label="Reconnecting" state="working" />
              )
            }
          />
          <AiRow
            discovering={discovering}
            onAuthenticate={openHarnessAuthentication ?? undefined}
            onChoose={setChosen}
            onRefresh={refreshHarnessCatalog}
            placements={local}
            selected={selected}
          />
          {onThisComputer ? <PhoneRow hostClient={hostClient} /> : null}
        </SetupList>
        <ErrorNotice message={error} />
        <div className="setup__actions">
          <button
            className="btn btn--primary"
            disabled={!selected?.available || saving}
            onClick={() => void start()}
            type="button"
          >
            {saving ? "Starting…" : home ? "Done" : "Start"}
            {saving ? null : <Icon name="arrow-right" />}
          </button>
          {!selected?.available ? (
            <button
              className="btn btn--ghost"
              onClick={() => void navigate("/", { replace: true })}
              type="button"
            >
              Set up later
            </button>
          ) : null}
        </div>
      </div>
    </OnboardingCard>
  );
}

/**
 * The accounts this computer's own agents can use, runnable ones first. Setup
 * offers only what can be used or fixed from here — ready, waiting for a
 * sign-in, or getting ready — and falls back to the rest only when nothing
 * else exists, so the reason this computer has no AI is still visible. An
 * account that was turned off is a decision already made elsewhere.
 */
export function setupPlacements(
  placements: readonly ThreadPlacementOption[],
): ThreadPlacementOption[] {
  const here = placements
    .filter(
      (placement) => placement.environmentKind === "main" && placement.availability !== "disabled",
    )
    .map((placement, index) => ({ index, placement }))
    .sort(
      (left, right) =>
        Number(right.placement.available) - Number(left.placement.available) ||
        left.index - right.index,
    )
    .map(({ placement }) => placement);
  const usable = here.filter(
    (placement) =>
      placement.available ||
      placement.availability === "authentication-required" ||
      placement.availability === "preparing" ||
      placement.availability === "runtime-check",
  );
  return usable.length > 0 ? usable : here;
}

function firstReadySelection(
  placements: readonly ThreadPlacementOption[],
): ExecutionSelection | null {
  const ready = placements.find((placement) => placement.available);
  return ready ? executionSelectionForPlacement(ready) : null;
}

/** One short phrase for an account that cannot run yet. */
export function placementStanding(placement: ThreadPlacementOption): string {
  switch (placement.availability) {
    case "configured":
      return "Ready";
    case "authentication-required":
      return "Not signed in";
    case "preparing":
    case "runtime-check":
      return "Getting ready";
    case "missing":
      return "Not installed on this computer";
    case "disconnected":
      return "This computer is offline";
    default:
      return "Can’t run right now";
  }
}

function AiRow({
  discovering,
  onAuthenticate,
  onChoose,
  onRefresh,
  placements,
  selected,
}: {
  readonly discovering: boolean;
  readonly onAuthenticate: ((placement: ThreadPlacementOption) => void) | undefined;
  readonly onChoose: (selection: ExecutionSelection) => void;
  readonly onRefresh: (placement: ThreadPlacementOption) => Promise<void>;
  readonly placements: readonly ThreadPlacementOption[];
  readonly selected: ThreadPlacementOption | null;
}) {
  const [choosing, setChoosing] = useState(false);
  if (discovering) {
    return (
      <SetupRow
        detail="Looking for AIs on this computer…"
        icon={<Icon name="sparkles" />}
        title="AI"
        tone="waiting"
        trailing={<SetupStatus label="Looking for AIs" state="working" />}
      />
    );
  }
  if (selected?.available && !choosing) {
    return (
      <SetupRow
        detail={selected.accountName !== selected.engineName ? selected.accountName : null}
        icon={<EngineMark driverKind={selected.driverKind} />}
        title={selected.engineName}
        tone="ready"
        trailing={
          <>
            <SetupStatus label="Ready" state="ready" />
            {placements.length > 1 ? (
              <button
                aria-label="Change AI"
                className="btn btn--small btn--ghost"
                onClick={() => setChoosing(true)}
                type="button"
              >
                Change
              </button>
            ) : null}
          </>
        }
      />
    );
  }
  return (
    <SetupRow icon={<Icon name="sparkles" />} title="Choose an AI" tone="waiting">
      {placements.length === 0 ? (
        <p className="setup-row__detail">
          No AI was found on this computer.{" "}
          <Link to="/settings/ai-engines">Add one in Settings</Link>
        </p>
      ) : (
        <ul aria-label="AIs on this computer" className="setup-choices" role="radiogroup">
          {placements.map((placement) => (
            <li key={placement.harnessInstanceId}>
              <AiChoice
                onAuthenticate={onAuthenticate}
                onChoose={(next) => {
                  onChoose(next);
                  setChoosing(false);
                }}
                onRefresh={onRefresh}
                placement={placement}
                selected={selected?.harnessInstanceId === placement.harnessInstanceId}
              />
            </li>
          ))}
        </ul>
      )}
    </SetupRow>
  );
}

function AiChoice({
  onAuthenticate,
  onChoose,
  onRefresh,
  placement,
  selected,
}: {
  readonly onAuthenticate: ((placement: ThreadPlacementOption) => void) | undefined;
  readonly onChoose: (selection: ExecutionSelection) => void;
  readonly onRefresh: (placement: ThreadPlacementOption) => Promise<void>;
  readonly placement: ThreadPlacementOption;
  readonly selected: boolean;
}) {
  const name = (
    <span className="setup-choice__name">
      {placement.engineName}
      <span className="setup-choice__detail">
        {placement.available
          ? placement.accountName !== placement.engineName
            ? placement.accountName
            : "Ready"
          : placementStanding(placement)}
      </span>
    </span>
  );
  const mark = (
    <span aria-hidden className="setup-choice__mark">
      <EngineMark driverKind={placement.driverKind} />
    </span>
  );
  if (placement.available) {
    return (
      <button
        aria-checked={selected}
        className="setup-choice"
        onClick={() => onChoose(executionSelectionForPlacement(placement))}
        role="radio"
        type="button"
      >
        {mark}
        {name}
        <span aria-hidden className="setup-choice__radio" />
      </button>
    );
  }
  const working =
    placement.availability === "preparing" || placement.availability === "runtime-check";
  return (
    <div className="setup-choice" title={placement.detail || undefined}>
      {mark}
      {name}
      {working ? (
        <span aria-hidden className="spinner" />
      ) : (
        <AccountFix onAuthenticate={onAuthenticate} onRefresh={onRefresh} placement={placement} />
      )}
    </div>
  );
}

function PhoneRow({ hostClient }: { readonly hostClient: HostClient }) {
  const { deploymentAccess, desktopBridge, snapshot } = useShell();
  const link = usePersonalAccountLink(
    supportsPersonalAccountLink(desktopBridge) ? desktopBridge : null,
    deploymentAccess,
  );
  const phone = usePhoneSetup({
    deploymentAccess,
    deploymentId: snapshot.deploymentId,
    hostClient,
    link,
    portalOrigin: snapshot.identityConfig?.portalOrigin ?? null,
  });
  const showingCode = phone.started && phone.reach.kind === "reachable";
  const arrived = useNewPhoneSignIn(hostClient, showingCode);
  const known = useSignedInPhone(hostClient);
  if (phone.reach.kind === "unavailable") return null;
  const phoneIcon = <Icon name="phone" />;

  if (arrived) {
    return (
      <SetupRow
        icon={phoneIcon}
        title={arrived.deviceLabel}
        tone="ready"
        trailing={<SetupStatus label="Signed in" state="ready" />}
      />
    );
  }
  if (!phone.started) {
    return known ? (
      <SetupRow
        icon={phoneIcon}
        title={known.deviceLabel}
        tone="ready"
        trailing={
          <>
            <SetupStatus label="Signed in" state="ready" />
            <button className="btn btn--small btn--ghost" onClick={phone.start} type="button">
              Add another
            </button>
          </>
        }
      />
    ) : (
      <SetupRow
        detail="Steer this computer from anywhere"
        icon={phoneIcon}
        title="Phone"
        tone="missing"
        trailing={
          <button className="btn btn--small" onClick={phone.start} type="button">
            Add
          </button>
        }
      />
    );
  }
  const cancel = (
    <button className="btn btn--small btn--ghost" onClick={phone.cancel} type="button">
      Cancel
    </button>
  );
  if (phone.phase.kind === "failed") {
    return (
      <SetupRow
        detail={<span role="alert">{phone.phase.message}</span>}
        icon={phoneIcon}
        title="Phone"
        tone="attention"
        trailing={
          <>
            <button className="btn btn--small" onClick={phone.start} type="button">
              Try again
            </button>
            {cancel}
          </>
        }
      />
    );
  }
  if (phone.reach.kind === "blocked" || phone.reach.kind === "private-network") {
    return (
      <SetupRow
        detail={
          phone.reach.kind === "blocked"
            ? phone.reach.message
            : "Remote access uses your private network. Pair a phone in Settings."
        }
        icon={phoneIcon}
        title="Phone"
        tone="attention"
        trailing={
          <Link className="btn btn--small" to="/settings/devices">
            Settings
          </Link>
        }
      />
    );
  }
  if (phone.reach.kind === "reachable") {
    return (
      <SetupRow icon={phoneIcon} title="Phone" tone="waiting" trailing={cancel}>
        <div className="setup-scan">
          <div className="setup-scan__code">
            <QrCode label="Code to open this computer on your phone" value={phone.reach.url} />
          </div>
          <div className="setup-scan__side">
            <span>Scan with your phone’s camera</span>
            <span className="setup-scan__wait" role="status">
              <span aria-hidden className="spinner" />
              Waiting for your phone…
            </span>
          </div>
        </div>
      </SetupRow>
    );
  }
  return (
    <SetupRow
      detail={phoneStepDetail(phone, deploymentAccess?.account.status ?? null)}
      icon={phoneIcon}
      title="Phone"
      tone="waiting"
      trailing={
        <>
          <SetupStatus label="Working" state="working" />
          {cancel}
        </>
      }
    />
  );
}

/** What the phone row is doing, while it is doing it. */
export function phoneStepDetail(
  phone: Pick<PhoneSetup, "phase" | "reach">,
  account: string | null,
) {
  if (phone.phase.kind === "linking" || phone.reach.kind === "needs-link") {
    return account === "authorizing"
      ? "Finish signing in in your browser"
      : "Adding this computer to your account…";
  }
  if (
    phone.phase.kind === "connecting" ||
    phone.reach.kind === "needs-connect" ||
    phone.reach.kind === "publishing"
  ) {
    return "Turning on remote access…";
  }
  return "Checking…";
}

/** The most recent phone already signed in here, read once when the row appears. */
function useSignedInPhone(hostClient: HostClient): AuthSessionSummary | null {
  const [phone, setPhone] = useState<AuthSessionSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    hostClient.rpc["sessions.list"]({})
      .then((result) => {
        if (cancelled) return;
        const phones = unwrapRpcResult(result).sessions.filter(
          (session) => !session.current && session.form === "mobile",
        );
        setPhone(phones[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hostClient]);
  return phone;
}
