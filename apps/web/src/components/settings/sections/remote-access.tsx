import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  DesktopConfigurePersonalRemoteAccessInputSchema,
  type DesktopConfigurePersonalRemoteAccessInput,
  type DesktopPersonalPairingCode,
  type DesktopPersonalRemoteAccessStatus,
  type OpensteerDesktopBridge,
  type PersonalRemoteAccessMode,
} from "@opensteer/protocol/desktop";
import { actionErrorMessage } from "../../../ui-utils.js";
import { useShell } from "../../app-shell.js";
import { deploymentMutationsBlockedReason } from "../../deployment-operation.js";
import { Icon } from "../../icon.js";
import { OptionRow } from "../../option-row.js";
import {
  canIssuePersonalPairingCode,
  copyPairingValue,
  initialPersonalRemoteAccessEditorState,
  isPairingCurrent,
  isRemoteAccessTransitioning,
  pairingHasExpired,
  reducePersonalRemoteAccessEditor,
  remoteAccessBusyLabel,
  remoteAccessChip,
  remoteAccessLabel,
  schedulePairingExpiry,
  type PersonalRemoteAccessEditorAction,
  type PersonalRemoteAccessEditorState,
} from "../remote-access-editor.js";
import { SettingsGroup, SettingsRow, formatWhen, type SettingsView } from "../primitives.js";
import {
  ComputersPointer,
  DevicesHeader,
  OtherDevicesGroup,
  useHomeComputer,
  useSessions,
} from "./devices.js";

const remoteAccessFootnote =
  "Turning remote access off signs out every device, drops the published address, and disconnects every reachable computer until it is on again.";

/**
 * Whether other devices can reach the Deployment on this computer, and who
 * currently does.
 *
 * The three choices are the whole model: nothing outside this machine, a
 * private tunnel through your Account, or an HTTPS address you run yourself.
 * Everything below the choices — the published address, pairing, the list of
 * devices — exists only because one of the last two is on. Turn it off and the
 * concept goes with it, which is exactly what the closing sentence promises.
 */
export function RemoteAccessSection({ view }: { readonly view: SettingsView }) {
  const { deploymentAccess, desktopBridge } = useShell();
  const bridge = supportsPersonalRemoteAccess(desktopBridge) ? desktopBridge : null;
  return (
    <>
      <DevicesHeader
        lead={`Open ${view.name} from your phone, a browser or another computer. Agents, files and sign-ins stay on ${view.name}.`}
        view={view}
      />
      {bridge ? (
        <PersonalRemoteAccessSettings
          blockedReason={deploymentMutationsBlockedReason(deploymentAccess)}
          bridge={bridge}
          canCancelOperation={
            deploymentAccess?.deployments
              .find(({ id }) => id === deploymentAccess.selectedDeploymentId)
              ?.availableActions.includes("cancel") ?? false
          }
          name={view.name}
        />
      ) : (
        <p className="settings-footnote">
          Remote access is configured on the computer that runs this deployment.
        </p>
      )}
      <ComputersPointer />
    </>
  );
}

function PersonalRemoteAccessSettings({
  blockedReason,
  bridge,
  canCancelOperation,
  name,
}: {
  readonly blockedReason: string | null;
  readonly bridge: OpensteerDesktopBridge;
  /** Whether the selected connection can still be cancelled. */
  readonly canCancelOperation: boolean;
  /** The Mac this Opensteer runs on, as the page names it. */
  readonly name: string;
}) {
  const [editor, setEditor] = useState<PersonalRemoteAccessEditorState>(
    initialPersonalRemoteAccessEditorState,
  );
  const editorRef = useRef(editor);
  const [pending, setPending] = useState<"cancel" | "configure" | "pairing" | null>(null);
  const [pairing, setPairing] = useState<DesktopPersonalPairingCode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const reportError = useCallback(
    (reason: unknown) => setActionError(actionErrorMessage(reason)),
    [],
  );

  const transitionEditor = useCallback((action: PersonalRemoteAccessEditorAction) => {
    const previous = editorRef.current;
    const next = reducePersonalRemoteAccessEditor(previous, action);
    if (next === previous) return false;
    editorRef.current = next;
    setEditor(next);
    if ("status" in action) {
      setPairing((current) => (isPairingCurrent(current, next.status) ? current : null));
    }
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const update = (next: DesktopPersonalRemoteAccessStatus) => {
      if (!cancelled) transitionEditor({ status: next, type: "status-observed" });
    };
    const unsubscribe = bridge.onPersonalRemoteAccessStatusChanged(update);
    void bridge.getPersonalRemoteAccessStatus().then(update).catch(reportError);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, reportError, transitionEditor]);

  useEffect(() => {
    if (!pairing) return;
    return schedulePairingExpiry(pairing.expiresAt, () => {
      setPairing((current) => (current === pairing ? null : current));
    });
  }, [pairing]);

  const status = editor.status;
  const { privateOrigin, selectedMode } = editor.draft;
  const transitioning = isRemoteAccessTransitioning(status);
  const busy = pending !== null || transitioning;
  const available = status !== null && status.phase !== "unavailable";
  const normalizedPrivateOrigin = privateOrigin.trim();
  const changed = editor.draft.dirty;
  const retrying =
    status?.retryable === true && (status.phase === "error" || status.phase === "offline");
  const canApply = available && !busy && !blockedReason && (changed || retrying);
  const canPair = canIssuePersonalPairingCode(status) && selectedMode === "private" && !changed;
  // The one way out of a half-finished turn-on. `linking-account` can sit
  // waiting on a browser sign-in indefinitely, and before this the whole
  // fieldset was disabled and only relaunching the app recovered.
  const canCancel = available && (transitioning || pending === "configure");

  function selectMode(mode: PersonalRemoteAccessMode) {
    transitionEditor({ mode, type: "mode-edited" });
    setPairing(null);
    setActionError(null);
  }

  function changePrivateOrigin(origin: string) {
    transitionEditor({ origin, type: "private-origin-edited" });
    setPairing(null);
    setActionError(null);
  }

  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canApply) return;
    const candidate: DesktopConfigurePersonalRemoteAccessInput = {
      mode: selectedMode,
      privateOrigin: selectedMode === "private" ? normalizedPrivateOrigin : null,
    };
    const input = DesktopConfigurePersonalRemoteAccessInputSchema.safeParse(candidate);
    if (!input.success) {
      setActionError("Enter a valid private HTTPS address.");
      return;
    }
    setPending("configure");
    setPairing(null);
    setActionError(null);
    void bridge
      .configurePersonalRemoteAccess(input.data)
      .then((next) => transitionEditor({ status: next, type: "apply-acknowledged" }))
      .catch(reportError)
      .finally(() => setPending(null));
  }

  /**
   * Stands the Deployment back down to Off from any in-flight phase.
   *
   * Turning Connect on can start an Account sign-in as a machine operation, so
   * cancelling means cancelling that operation *and* clearing the pending
   * intent the remote-access service is still holding — applying Off is what
   * clears it, and it is safe from every phase.
   */
  function cancel() {
    if (pending === "cancel") return;
    setPending("cancel");
    setPairing(null);
    setActionError(null);
    const abortOperation = canCancelOperation
      ? bridge.cancel().catch(() => undefined)
      : Promise.resolve();
    void abortOperation
      .then(() => bridge.configurePersonalRemoteAccess({ mode: "off", privateOrigin: null }))
      .then((next) => {
        transitionEditor({ mode: "off", type: "mode-edited" });
        transitionEditor({ status: next, type: "apply-acknowledged" });
      })
      .catch(reportError)
      .finally(() => setPending(null));
  }

  function issuePairingCode() {
    if (!canPair || busy) return;
    setPending("pairing");
    setActionError(null);
    void bridge
      .issuePersonalPairingCode()
      .then((next) => {
        const current = editorRef.current;
        if (isPairingCurrent(next, current.status) && !pairingHasExpired(next.expiresAt)) {
          setPairing(next);
        }
      })
      .catch(reportError)
      .finally(() => setPending(null));
  }

  return (
    <PersonalRemoteAccessForm
      actionError={actionError}
      applying={pending === "configure"}
      available={available}
      blockedReason={blockedReason}
      busy={busy}
      canApply={canApply}
      canCancel={canCancel}
      canPair={canPair}
      cancelling={pending === "cancel"}
      creatingPairing={pending === "pairing"}
      dirty={changed}
      name={name}
      onCancel={cancel}
      onChangeMode={selectMode}
      onChangePrivateOrigin={changePrivateOrigin}
      onIssuePairingCode={issuePairingCode}
      onPairingCopyError={reportError}
      onSubmit={configure}
      pairing={pairing}
      privateOrigin={privateOrigin}
      retrying={retrying}
      selectedMode={selectedMode}
      status={status}
    />
  );
}

function PersonalRemoteAccessForm({
  actionError = null,
  applying,
  available,
  blockedReason = null,
  busy,
  canApply,
  canCancel = false,
  canPair,
  cancelling = false,
  creatingPairing,
  dirty,
  name,
  onCancel,
  onChangeMode,
  onChangePrivateOrigin,
  onIssuePairingCode,
  onPairingCopyError,
  onSubmit,
  pairing,
  privateOrigin,
  retrying,
  selectedMode,
  status,
}: {
  readonly actionError?: string | null;
  readonly applying: boolean;
  readonly available: boolean;
  readonly blockedReason?: string | null;
  readonly busy: boolean;
  readonly canApply: boolean;
  /** Whether there is an in-flight change this form can stand back down. */
  readonly canCancel?: boolean;
  readonly canPair: boolean;
  readonly cancelling?: boolean;
  readonly creatingPairing: boolean;
  /** Whether the choices on screen differ from what is applied. */
  readonly dirty: boolean;
  readonly name: string;
  readonly onCancel?: (() => void) | undefined;
  readonly onChangeMode: (mode: PersonalRemoteAccessMode) => void;
  readonly onChangePrivateOrigin: (origin: string) => void;
  readonly onIssuePairingCode: () => void;
  readonly onPairingCopyError: (reason: unknown) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly pairing: DesktopPersonalPairingCode | null;
  readonly privateOrigin: string;
  readonly retrying: boolean;
  readonly selectedMode: PersonalRemoteAccessMode;
  readonly status: DesktopPersonalRemoteAccessStatus | null;
}) {
  // Off is never disabled while this Deployment can answer at all: it is the
  // way back from a turn-on that is still waiting on a browser sign-in.
  const choicesDisabled = !available || busy || blockedReason !== null;
  const reachable = status?.phase === "ready" && status.mode !== "off" ? status : null;
  const chip = remoteAccessChip(status);
  return (
    <>
      <form
        aria-labelledby="settings-remote-access-heading"
        className="card settings-remote-access"
        onSubmit={onSubmit}
      >
        <span className="visually-hidden" id="settings-remote-access-heading">
          Remote access
        </span>
        {/* Not a disabled fieldset: disabling the group was what wedged this
            form, because it took Off away at the exact moment Off was the only
            useful answer. Each choice states its own availability instead. */}
        <fieldset className="option-row-group settings-remote-access__choices">
          <legend className="visually-hidden">Remote access</legend>
          <RemoteAccessChoice
            checked={selectedMode === "off"}
            detail={`Only ${name} can open it.`}
            disabled={!available}
            mode="off"
            onChange={onChangeMode}
            title="Off"
          />
          <RemoteAccessChoice
            checked={selectedMode === "connect"}
            detail="Open it from anywhere through a private tunnel. Uses your Opensteer Account."
            disabled={choicesDisabled}
            mode="connect"
            onChange={onChangeMode}
            title="Opensteer Connect"
          />
          <RemoteAccessChoice
            checked={selectedMode === "private"}
            detail="You provide an HTTPS address on your own network, such as Tailscale."
            disabled={choicesDisabled}
            mode="private"
            onChange={onChangeMode}
            title="Private network"
          />
        </fieldset>
        {/* The trust boundary is said where Connect is chosen; once it is on,
            the card below says how to use it instead. */}
        {selectedMode === "connect" && (dirty || status?.mode !== "connect") ? (
          <div className="settings-connect-disclosure">
            <p className="settings-connect-disclosure__title">What Opensteer Connect does</p>
            <ul>
              <li>{name} must stay awake, with Opensteer running in the background.</li>
              <li>Traffic reaches {name} through Cloudflare, and TLS is terminated there.</li>
              <li>Files, agents, provider logins, and integrations stay on {name}.</li>
              <li>Each device you sign in with your Opensteer Account gets its own access.</li>
            </ul>
          </div>
        ) : null}
        {selectedMode === "private" ? (
          <div className="card__form settings-private-origin">
            <label className="field" htmlFor="settings-private-origin">
              <span className="field__label">Private HTTPS address</span>
              <input
                autoCapitalize="none"
                autoComplete="url"
                className="text-input"
                disabled={choicesDisabled}
                id="settings-private-origin"
                inputMode="url"
                onChange={(event) => onChangePrivateOrigin(event.target.value)}
                placeholder="https://mac-mini.tailnet.ts.net"
                required
                spellCheck={false}
                type="url"
                value={privateOrigin}
              />
              <span className="field__hint">
                Opensteer verifies this deployment’s exact signed identity before enabling this
                address.
              </span>
            </label>
          </div>
        ) : null}
        {!available ? (
          <p className="settings-capability-note" role="status">
            {status?.detail ?? "Checking remote access…"}
          </p>
        ) : status?.detail ? (
          <p
            aria-live={status.phase === "error" ? "assertive" : "polite"}
            className={`settings-capability-note${status.phase === "error" ? " is-error" : ""}`}
            role={status.phase === "error" ? "alert" : "status"}
          >
            {status.detail}
          </p>
        ) : null}
        {blockedReason ? (
          <p className="settings-capability-note" role="status">
            {blockedReason}
          </p>
        ) : null}
        <div className="settings-remote-access__actions">
          <span className={chip ? `chip ${chip}` : "chip"} role="status">
            {remoteAccessLabel(status)}
          </span>
          <div className="form-actions">
            {actionError ? (
              <p aria-live="assertive" className="form-actions__error" role="alert">
                {actionError}
              </p>
            ) : null}
            {canCancel && onCancel ? (
              <button className="btn" disabled={cancelling} onClick={onCancel} type="button">
                {cancelling ? "Cancelling…" : "Cancel and turn off"}
              </button>
            ) : null}
            <button className="btn btn--primary" disabled={!canApply} type="submit">
              {applying || isRemoteAccessTransitioning(status)
                ? remoteAccessBusyLabel(status)
                : retrying
                  ? "Try again"
                  : "Apply"}
            </button>
          </div>
        </div>
      </form>
      {/* How to use it is only worth saying once it is on, and only for the
          choice that is on rather than one half-picked above. */}
      {reachable && !dirty ? (
        <SettingsGroup heading="Connect a device" headingId="settings-connect-device-heading">
          {reachable.mode === "connect" ? (
            <>
              <SettingsRow
                detail={`Sign in to the Opensteer app with your Opensteer Account, then choose ${name}.`}
                icon="phone"
                title="On your phone or another computer"
              />
              <SettingsRow
                detail={`Sign in to your Opensteer Account on the web, then open ${name}.`}
                icon="browser"
                title="In a browser"
              />
            </>
          ) : (
            <>
              <SettingsRow
                action={
                  canPair ? (
                    <button
                      className="btn btn--small"
                      disabled={busy}
                      onClick={onIssuePairingCode}
                      type="button"
                    >
                      {creatingPairing ? "Creating…" : "Create pairing code"}
                    </button>
                  ) : undefined
                }
                detail="In Opensteer on the other device, choose Add a computer or server, then Another computer of yours › Use a pairing code, and enter the address and this one-use code."
                icon="key"
                title="Pair with a code"
              />
              {pairing && canPair ? (
                <div aria-labelledby="settings-pairing-heading" className="settings-pairing-code">
                  <span className="settings-pairing-code__label" id="settings-pairing-heading">
                    One-use pairing code
                  </span>
                  <span aria-live="polite" className="visually-hidden" role="status">
                    Pairing code created.
                  </span>
                  <span className="settings-pairing-code__values">
                    <PairingValue
                      actionLabel="Copy address"
                      label="Address"
                      onError={onPairingCopyError}
                      value={pairing.routeOrigin}
                    />
                    <PairingValue
                      actionLabel="Copy one-use code"
                      label="One-use code"
                      onError={onPairingCopyError}
                      value={pairing.code}
                    />
                  </span>
                  <span>One use · expires {formatWhen(pairing.expiresAt)}</span>
                </div>
              ) : null}
            </>
          )}
          {reachable.routeOrigin ? (
            <SettingsRow
              action={
                <CopyValue
                  actionLabel="Copy"
                  label="Address"
                  onError={onPairingCopyError}
                  value={reachable.routeOrigin}
                />
              }
              detail={<span className="card__row-mono">{reachable.routeOrigin}</span>}
              icon="globe"
              title="Address"
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {status && status.mode !== "off" ? <SignedInDevices name={name} /> : null}
    </>
  );
}

/**
 * Every device that can open this Opensteer from elsewhere, under the Mac that
 * never needs to be let in. Its app's own sign-ins are that Mac, not devices.
 */
function SignedInDevices({ name }: { readonly name: string }) {
  const sessions = useSessions();
  const home = useHomeComputer();
  return (
    <OtherDevicesGroup
      heading="Signed-in devices"
      home={{ here: true, icon: home.icon, name: home.name ?? name }}
      note={remoteAccessFootnote}
      sessions={sessions}
    />
  );
}

function RemoteAccessChoice({
  checked,
  detail,
  disabled,
  mode,
  onChange,
  title,
}: {
  readonly checked: boolean;
  readonly detail: string;
  readonly disabled: boolean;
  readonly mode: PersonalRemoteAccessMode;
  readonly onChange: (mode: PersonalRemoteAccessMode) => void;
  readonly title: string;
}) {
  return (
    <OptionRow
      as="radio"
      checked={checked}
      detail={detail}
      disabled={disabled}
      framed
      name="personal-remote-access"
      onSelect={() => onChange(mode)}
      title={title}
      value={mode}
    />
  );
}

function PairingValue(props: {
  readonly actionLabel: string;
  readonly label: string;
  readonly onError: (reason: unknown) => void;
  readonly value: string;
}) {
  return (
    <span className="settings-pairing-value">
      <span className="settings-pairing-value__label">{props.label}</span>
      <span className="settings-pairing-value__content">
        <code>{props.value}</code>
        <CopyValue
          actionLabel={props.actionLabel}
          label={props.label}
          onError={props.onError}
          value={props.value}
        />
      </span>
    </span>
  );
}

function CopyValue({
  actionLabel,
  label,
  onError,
  value,
}: {
  readonly actionLabel: string;
  readonly label: string;
  readonly onError: (reason: unknown) => void;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  function copy() {
    void copyPairingValue(value)
      .then(() => {
        setCopied(true);
        if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => {
          resetTimer.current = null;
          setCopied(false);
        }, 1_500);
      })
      .catch(onError);
  }

  return (
    <>
      <button
        aria-label={copied ? `${label} copied` : actionLabel}
        className="btn btn--small settings-pairing-value__copy"
        onClick={copy}
        type="button"
      >
        <Icon name={copied ? "check" : "copy"} />
        {copied ? "Copied" : actionLabel}
      </button>
      <span aria-live="polite" className="visually-hidden" role="status">
        {copied ? `${label} copied to clipboard.` : ""}
      </span>
    </>
  );
}

function supportsPersonalRemoteAccess(
  bridge: OpensteerDesktopBridge | null,
): bridge is OpensteerDesktopBridge {
  return (
    bridge !== null &&
    typeof bridge.configurePersonalRemoteAccess === "function" &&
    typeof bridge.getPersonalRemoteAccessStatus === "function" &&
    typeof bridge.issuePersonalPairingCode === "function" &&
    typeof bridge.onPersonalRemoteAccessStatusChanged === "function"
  );
}
