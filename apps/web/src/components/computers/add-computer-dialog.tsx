import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import type { DesktopLocalExecutionStatus } from "@opensteer/protocol/desktop";
import {
  computerConnectionCommands,
  runnerDistribution,
} from "../../computers/connection-commands.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { useShell, type ShellContext } from "../app-shell.js";
import { Icon } from "../icon.js";

/**
 * How a computer joins, in the order somebody actually does it.
 *
 * A computer is always added from the computer itself, so the dialog opens
 * with the one in front of the reader when it can join, and otherwise gives
 * the steps to take on the other one. A Personal Opensteer admits no second
 * computer until other computers can reach it, so that is the first step —
 * and only while it is actually off. A machine with no screen joins from a
 * command that is kept out of the way because almost nobody needs it.
 */
export function AddComputerDialog({
  client,
  deploymentKind,
  deploymentName,
  homeName,
  hostedOnThisComputer,
  localExecutionAction,
  localExecutionError,
  localExecutionStatus,
  offer,
  onAddThisComputer,
  onClose,
  snapshot,
}: {
  readonly client: HostClient;
  readonly deploymentKind: "personal" | "server" | null;
  readonly deploymentName: string;
  /** The Mac a Personal Opensteer runs on. */
  readonly homeName: string;
  /** Whether this app supervises the Deployment on the computer it runs on. */
  readonly hostedOnThisComputer: boolean;
  readonly localExecutionAction: ShellContext["localExecutionAction"];
  readonly localExecutionError: string | null;
  readonly localExecutionStatus: DesktopLocalExecutionStatus | null;
  /** What joining would give this computer, or null when it cannot join. */
  readonly offer: { readonly runAgents: boolean } | null;
  readonly onAddThisComputer: (input: {
    readonly kind: "add";
    readonly name: string;
    readonly runAgents: boolean;
  }) => Promise<void>;
  readonly onClose: () => void;
  readonly snapshot: ShellContext["snapshot"];
}) {
  const { deploymentAccess, desktopBridge } = useShell();
  const accountAvailable = !desktopBridge || deploymentAccess?.account.available !== false;
  const adding = localExecutionAction?.kind === "add";
  const personal = deploymentKind === "personal";
  const reachable = usePersonalReachable({ hostedOnThisComputer, personal });

  return (
    <Dialog
      footer={
        <button className="btn" onClick={onClose} type="button">
          Done
        </button>
      }
      labelledBy="add-computer-title"
      onClose={onClose}
      title="Add a computer"
    >
      {offer && localExecutionStatus ? (
        <section className="add-computer__here">
          <span className="add-computer__here-glyph">
            <Icon name="pin" />
          </span>
          <span className="add-computer__here-body">
            <strong>{localExecutionStatus.computerName}</strong>
            <span>The computer you’re on now.</span>
          </span>
          <button
            className="btn btn--primary"
            disabled={adding}
            onClick={() =>
              void onAddThisComputer({
                kind: "add",
                name: localExecutionStatus.computerName,
                runAgents: offer.runAgents,
              }).catch(() => undefined)
            }
            type="button"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </section>
      ) : null}
      {offer && localExecutionError ? (
        <p className="notice notice--error" role="alert">
          {localExecutionError}
        </p>
      ) : null}

      <section className="add-computer__step">
        <h3>{offer ? "Another computer" : "Add it from that computer"}</h3>
        <ol className="add-computer__steps">
          {personal && reachable === false ? (
            <li>
              Turn on remote access for {homeName}, so other computers can reach it.{" "}
              {hostedOnThisComputer ? (
                <Link to="/settings/devices">Open Remote access</Link>
              ) : (
                <>It’s under Settings → Remote access in the Opensteer app on {homeName}.</>
              )}
            </li>
          ) : null}
          <li>
            Install Opensteer on the other computer{accountAvailable ? " and sign in" : ""}
            {personal && accountAvailable
              ? ` with your Opensteer account. Then open ${homeName}.`
              : `. Then open ${deploymentName}.`}
          </li>
          <li>
            On its Computers page, choose <strong>Add</strong>. It shows up here right away.
          </li>
        </ol>
        {personal ? (
          <p className="section__hint">
            {accountAvailable ? "No Opensteer account? " : ""}Create a pairing code under Remote
            access on {homeName}, and enter it on the other computer when you add {homeName} there.
          </p>
        ) : null}
      </section>

      {deploymentKind === "server" ? (
        <details className="add-computer__advanced">
          <summary>A server without a screen</summary>
          <HeadlessEnrollment client={client} snapshot={snapshot} />
        </details>
      ) : null}
    </Dialog>
  );
}

/**
 * Whether other computers can reach a Personal Opensteer right now.
 *
 * Only the app hosting it can ask. Anywhere else the answer is already known
 * in one direction — a device that reached it from elsewhere proves remote
 * access is on — and unknowable in the other, so the step is shown.
 */
function usePersonalReachable(input: {
  readonly hostedOnThisComputer: boolean;
  readonly personal: boolean;
}): boolean | null {
  const { deploymentAccess, desktopBridge, desktopDeployment, snapshot } = useShell();
  const reachedFromElsewhere =
    desktopDeployment?.access === "connect" ||
    desktopDeployment?.access === "private" ||
    (desktopBridge === null && snapshot.sessionSurface === "personal-remote");
  const [phase, setPhase] = useState<string | null>(null);
  const bridge =
    input.personal &&
    input.hostedOnThisComputer &&
    desktopBridge &&
    typeof desktopBridge.getPersonalRemoteAccessStatus === "function"
      ? desktopBridge
      : null;
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const update = (status: { readonly phase: string }) => {
      if (!cancelled) setPhase(status.phase);
    };
    const unsubscribe = bridge.onPersonalRemoteAccessStatusChanged(update);
    void bridge
      .getPersonalRemoteAccessStatus()
      .then(update)
      .catch(() => {
        if (!cancelled) setPhase("unavailable");
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge, deploymentAccess]);
  if (!input.personal) return null;
  if (reachedFromElsewhere) return true;
  return bridge ? (phase === null ? null : phase === "ready") : false;
}

/**
 * The connection code a computer with no screen redeems.
 *
 * It stays exactly as capable as it was — both packagings, and the cloud
 * Workspace variants — and merely stops being the first thing the page offers.
 */
function HeadlessEnrollment({
  client,
  snapshot,
}: {
  readonly client: HostClient;
  readonly snapshot: ShellContext["snapshot"];
}) {
  const [name, setName] = useState("New computer");
  const [issued, setIssued] = useState<{
    readonly enrollmentId: string;
    readonly expiresAt: string;
    readonly token: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown(issued?.expiresAt ?? null);
  const connected = snapshot.machines.some(
    (machine) => machine.status === "online" && machine.enrollmentId === issued?.enrollmentId,
  );
  useEffect(() => {
    if (issued && connected) setIssued(null);
  }, [connected, issued]);
  const commands = useMemo(() => {
    if (!issued || !snapshot.deploymentShape || !snapshot.identityConfig) return null;
    return computerConnectionCommands({
      deploymentShape: snapshot.deploymentShape,
      enrollmentId: issued.enrollmentId,
      hostOrigin: snapshot.identityConfig.publicOrigin,
      name: name.trim(),
      runnerDistribution,
      token: issued.token,
    });
  }, [issued, name, snapshot.deploymentShape, snapshot.identityConfig]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.dispatch({
        // A headless computer somebody connects runs agents and can be reached
        // over SSH. A browser or messaging service is the Deployment's own and
        // is provisioned, not added here.
        allowedModules: ["agents", "shell"],
        idempotencyKey: mutationIdempotencyKey("computer-add"),
        name: name.trim(),
        type: "runner.enrollment.createLocal",
      });
      if (result.type !== "runner.enrollment.createLocal") {
        throw new Error("Computer connection code was not created.");
      }
      setIssued({
        enrollmentId: result.enrollmentId,
        expiresAt: result.expiresAt,
        token: result.token,
      });
      await client.refresh();
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="computers-add">
      <p className="section__hint">Run one command on that computer. Agents can then work on it.</p>
      <label className="field">
        <span className="field__label">Computer name</span>
        <input
          className="text-input"
          disabled={issued !== null}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      {!issued ? (
        <div className="form-actions">
          <button
            className="btn btn--primary"
            disabled={busy || !name.trim()}
            onClick={() => void create()}
            type="button"
          >
            {busy ? "Creating…" : "Create connection code"}
          </button>
        </div>
      ) : commands ? (
        <>
          <p className="computers-expiry">Connection code expires in {countdown}.</p>
          <p className="field__hint">
            Pick one. The difference is what the agents on that computer can reach.
          </p>
          <CopyBlock
            hint={containerPrerequisite}
            label={containerLabel}
            value={commands.container}
          />
          {commands.bareHost ? (
            <CopyBlock
              hint={bareHostPrerequisite}
              label={bareHostLabel}
              value={commands.bareHost}
            />
          ) : (
            <p className="field__hint">{bareHostUnavailable}</p>
          )}
          {commands.sharedStorage ? (
            <>
              <p className="field__hint">
                Either command gives the computer folders of its own. To also work on this
                deployment&apos;s cloud Workspaces from it, use the matching command below instead.
              </p>
              <CopyBlock
                hint={`${containerPrerequisite} Also needs FUSE and the PortableFS binary on that computer.`}
                label={`${containerLabel} — also cloud Workspaces`}
                value={commands.sharedStorage.container}
              />
              {commands.sharedStorage.bareHost ? (
                <CopyBlock
                  hint={`${bareHostPrerequisite} Also needs FUSE and the PortableFS binary on that computer.`}
                  label={`${bareHostLabel} — also cloud Workspaces`}
                  value={commands.sharedStorage.bareHost}
                />
              ) : null}
            </>
          ) : null}
          {new Date(issued.expiresAt).getTime() <= Date.now() ? (
            <button className="btn" onClick={() => setIssued(null)} type="button">
              Create a new code
            </button>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Container" and "Bare host" name the packaging, which is not the choice a
 * person is making. What separates them is what the agents on that computer
 * can reach, so the labels say that and the hint states the one thing each
 * needs installed before the command works.
 */
const containerLabel = "Runs in a container: agents get only what you mount";
const containerPrerequisite = "Needs Docker on that computer.";
const bareHostLabel = "Runs on this machine as you: agents get your files and sign-ins";
const bareHostPrerequisite =
  "Needs curl and tar on that computer; the command installs Opensteer itself.";
const bareHostUnavailable =
  "This build of Opensteer has no published runner download, so only the container setup is offered here.";

function CopyBlock({
  hint,
  label,
  value,
}: {
  readonly hint?: string;
  readonly label: string;
  readonly value: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="computers-copy-block">
      <div>
        <strong>{label}</strong>
        <button
          className="btn btn--ghost btn--small"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
          type="button"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint ? <small className="field__hint">{hint}</small> : null}
      <code>{value}</code>
    </div>
  );
}

function useCountdown(expiresAt: string | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return "0 min";
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
