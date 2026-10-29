import {
  ComputerUseDataAppIdSchema,
  ComputerUseDataGrantSchema,
  type MachineSummary,
} from "@opensteer/protocol";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  computerGlyph,
  computerRole,
  computerRoleLabel,
  computersOverview,
  computerStatus,
  computerUses,
  hostsDeployment,
  serviceGlyph,
  serviceLabel,
  type ComputerGroup,
  type ComputersHome,
  type ComputerStatus,
  type ComputerUse,
} from "@opensteer/client/computers";
import { localJoinOffer, localRunnerStateLabel } from "../desktop/desktop-bridge.js";
import {
  canRespondToRequests,
  fullAccessButtonLabel,
  fullAccessDetail,
  fullAccessOnThisMac,
  fullDiskAccessLabel,
  mutationIdempotencyKey,
} from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { useShell, type LocalExecutionAction } from "./app-shell.js";
import { useDeploymentName } from "./deployment-name.js";
import {
  computerAppAnchorId,
  ComputerAppsSection,
  type ComputerAppApprovalInput,
  type ComputerAppRequestInput,
  useComputerAppData,
} from "./computer-apps/computer-apps-section.js";
import type { ComputerUseApprovalKeySetup } from "./computer-apps/computer-use-section.js";
import type { ComputerAppSetupRequest } from "@opensteer/integration-core";
import { AddComputerDialog } from "./computers/add-computer-dialog.js";
import { AddPhoneDialog } from "./computers/add-phone-dialog.js";
import { PhoneSection } from "./computers/phone-section.js";
import { ComputerUseMarks } from "./computers/computer-uses.js";
import { HerePin } from "./computers/here-pin.js";
import { computerIcon, DeviceArt, type PlaceArt } from "./computers/device-art.js";
import {
  computerAppRows,
  isAndroidPhone,
  isIphone,
  ownsComputerApps,
  phoneUseIntroduction,
  phoneUseState,
} from "@opensteer/client/integrations";
import { Icon } from "./icon.js";
import { machineAccessSummary } from "./machine-access/machine-access-editor.js";
import { MachineAccessSection } from "./machine-access/machine-access-section.js";
import { PageHeader, PageTopbar } from "./page-header.js";
import { MacOsPermissionReviewDialog } from "./macos-permission-review-dialog.js";

/**
 * Folders the computer holds that no Workspace claims. Nothing is offered to
 * remove them here: the folders are the person's, and the Host never acts on a
 * machine's inventory beyond reporting it.
 */
export function unlinkedFoldersLabel(count: number): string {
  return count === 1
    ? "1 folder on this computer is not linked to a Workspace"
    : `${count} folders on this computer are not linked to a Workspace`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What removal actually costs. Threads placed here lose the computer they run
 * on, and Workspaces kept on its disk lose the only machine that can read their
 * files — neither is recoverable by re-adding a computer, so both counts are
 * named rather than implied.
 */
export function machineRemovalStakes(machine: MachineSummary): string | null {
  const stakes: string[] = [];
  if (machine.pinnedThreads > 0) {
    stakes.push(`${plural(machine.pinnedThreads, "Thread runs", "Threads run")} here`);
  }
  if (machine.localWorkspaces > 0) {
    stakes.push(
      `${plural(machine.localWorkspaces, "Workspace keeps its files", "Workspaces keep their files")} on its disk`,
    );
  }
  if (stakes.length === 0) return null;
  return `${stakes.join(" and ")}, and will have nowhere to run until you move them.`;
}

/** The stakes, asked as the question the browser puts before the command. */
export function machineRemovalPrompt(machine: MachineSummary): string {
  const stakes = machineRemovalStakes(machine);
  return `Remove ${machine.name}? Agents will no longer be able to use it.${stakes ? ` ${stakes}` : ""}`;
}

/**
 * The enrolled machine this desktop is running on.
 *
 * A lent computer has a local Runner slot that names itself. The computer
 * hosting a Personal Deployment deliberately has no such slot: the desktop's
 * positive `onThisComputer` fact identifies that Deployment's Main instead. A
 * browser knows neither, so it never claims to be anywhere.
 */
export function currentDeviceMachineId(input: {
  readonly deploymentKind: "personal" | "server" | null;
  readonly hostsDeploymentOnThisComputer: boolean;
  readonly localRunnerId: string | null;
  readonly machines: readonly MachineSummary[];
}): string | null {
  if (input.localRunnerId !== null) return input.localRunnerId;
  if (!input.hostsDeploymentOnThisComputer || input.deploymentKind !== "personal") return null;
  return (
    input.machines.find((machine) => hostsDeployment(machine, input.deploymentKind))?.id ?? null
  );
}

function StatusText({ status }: { readonly status: ComputerStatus }) {
  return (
    <span className="computer-status">
      <span aria-hidden className={`computer-status__dot computer-status__dot--${status.tone}`} />
      {status.label}
    </span>
  );
}

const pageDescription =
  "Where your Opensteer runs, and the other computers its agents can work on and use.";

export function ComputersPage() {
  const {
    desktopBridge,
    desktopDeployment,
    hostClient,
    localExecutionAction,
    localExecutionError,
    localExecutionStatus,
    openMobileNavigation,
    performLocalExecutionAction,
    reportActionError,
    snapshot,
  } = useShell();
  const deploymentName = useDeploymentName();
  const deploymentKind = snapshot.deploymentShape?.kind ?? null;
  const hereId = currentDeviceMachineId({
    deploymentKind,
    hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
    localRunnerId: localExecutionStatus?.runner.runnerId ?? null,
    machines: snapshot.machines,
  });
  const [fullAccessOffered, setFullAccessOffered] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingPhone, setAddingPhone] = useState(false);
  const apps = useComputerAppData(hostClient, snapshot.machineRevision);
  const overview = computersOverview({
    cloud: snapshot.identityConfig?.deployment.cloud ?? false,
    deploymentKind,
    deploymentName,
    hereId,
    machines: snapshot.machines,
    publicOrigin: snapshot.identityConfig?.publicOrigin ?? null,
  });
  const administrator = snapshot.user?.instanceRole === "administrator";
  // The offer stands only where this desktop has a Runner slot for the
  // Deployment on screen and has not used it. The Personal Deployment hosted
  // on this very computer has no slot at all — its Runner is the Main — so no
  // offer is ever made there.
  const offer = localJoinOffer({ deploymentKind, status: localExecutionStatus });
  const homeName = overview.home.kind === "mac" ? overview.home.name : deploymentName;

  const macOsDesktop = desktopBridge !== null && localExecutionStatus?.platform === "macos";
  /**
   * Joins, and then — on a Mac that has not been asked yet — offers the grant.
   *
   * The offer is made after the add has settled and never as part of it: a Mac
   * belongs to the Deployment whether or not anybody answers this, and a
   * failure to read the grant is reported rather than swallowed.
   */
  async function addThisComputer(action: LocalExecutionAction) {
    await performLocalExecutionAction(action);
    if (action.kind !== "add") return;
    setAdding(false);
    if (!macOsDesktop || !desktopBridge) return;
    try {
      const { granted } = await desktopBridge.checkFullDiskAccess();
      if (!granted) setFullAccessOffered(true);
    } catch (reason) {
      reportActionError(reason);
    }
  }

  function usesOf(machine: MachineSummary): readonly ComputerUse[] {
    return computerUses(machine, apps.data);
  }

  return (
    <div className="page computers-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title="Computers" />
      <div className="page__content computers-page__content">
        <PageHeader description={pageDescription} title="Computers" />
        <HomeCard
          connection={snapshot.connection}
          hereId={hereId}
          home={overview.home}
          services={overview.services}
          uses={
            overview.home.kind === "mac" && overview.home.machine
              ? usesOf(overview.home.machine)
              : []
          }
        />
        {offer && localExecutionStatus ? (
          <JoinOffer
            adding={localExecutionAction?.kind === "add"}
            computerName={localExecutionStatus.computerName}
            error={localExecutionError}
            homeName={deploymentKind === "personal" ? homeName : null}
            onAdd={() =>
              void addThisComputer({
                kind: "add",
                name: localExecutionStatus.computerName,
                runAgents: offer.runAgents,
              }).catch(() => undefined)
            }
            runAgents={offer.runAgents}
          />
        ) : null}
        {overview.groups.map((group) =>
          group.machines.length === 0 && group.id !== overview.addTo ? null : (
            <ComputerGroupSection
              group={group}
              hereId={hereId}
              homeName={homeName}
              key={group.id}
              onAdd={group.id === overview.addTo ? () => setAdding(true) : null}
              onAddPhone={group.id === overview.addTo ? () => setAddingPhone(true) : null}
              offered={offer !== null}
              appsLoaded={apps.data !== null}
              usesOf={usesOf}
            />
          ),
        )}
        {apps.error ? (
          <p className="notice notice--error" role="alert">
            {apps.error}
          </p>
        ) : null}
        {/* A Personal Opensteer's services are the app's own business; a
            server's administrator may need to rename or retire one. */}
        {administrator && deploymentKind === "server" && overview.services.length > 0 ? (
          <Services client={hostClient} services={overview.services} />
        ) : null}
        {/* The question people most often bring here belongs next door:
            computers are what agents use, devices are where you open Opensteer. */}
        <p className="settings-footnote">
          {deploymentKind === "personal" ? (
            <>
              To open {homeName} on your phone or another device, use{" "}
              <Link to="/settings/devices">Remote access</Link>.
            </>
          ) : (
            <>
              The browsers and apps you open Opensteer from are under{" "}
              <Link to="/settings/devices">Signed-in devices</Link>.
            </>
          )}
        </p>
      </div>
      {adding ? (
        <AddComputerDialog
          client={hostClient}
          deploymentKind={deploymentKind}
          deploymentName={deploymentName}
          hostedOnThisComputer={desktopDeployment?.onThisComputer === true}
          homeName={homeName}
          localExecutionAction={localExecutionAction}
          localExecutionError={localExecutionError}
          localExecutionStatus={localExecutionStatus}
          offer={offer}
          onAddThisComputer={addThisComputer}
          onClose={() => setAdding(false)}
          snapshot={snapshot}
        />
      ) : null}
      {addingPhone ? (
        <AddPhoneDialog
          client={hostClient}
          deploymentKind={deploymentKind}
          deploymentName={deploymentName}
          desktopBridge={desktopBridge}
          homeName={homeName}
          onClose={() => setAddingPhone(false)}
        />
      ) : null}
      {fullAccessOffered && desktopBridge ? (
        <MacOsPermissionReviewDialog
          bridge={desktopBridge}
          cancelLabel="Not now"
          onClose={() => setFullAccessOffered(false)}
          onError={reportActionError}
        />
      ) : null}
    </div>
  );
}

/** The Deployment this window is looking at, in the words it is named by. */
/**
 * Where this Opensteer runs, drawn as the object it is. It is the top of the
 * page and never a row: the Mac a Personal Opensteer lives on is not one
 * computer among the others, and Opensteer Cloud or a server is not a
 * computer anybody added.
 */
function HomeCard({
  connection,
  hereId,
  home,
  services,
  uses,
}: {
  readonly connection: "connected" | "connecting" | "offline";
  readonly hereId: string | null;
  readonly home: ComputersHome;
  readonly services: readonly MachineSummary[];
  readonly uses: readonly ComputerUse[];
}) {
  const machine = home.kind === "mac" ? home.machine : null;
  const art: PlaceArt =
    home.kind === "cloud"
      ? "cloud"
      : home.kind === "server"
        ? "server"
        : machine
          ? computerGlyph(machine)
          : "computer";
  const name =
    home.kind === "cloud" ? "Opensteer Cloud" : home.kind === "server" ? home.address : home.name;
  const line =
    home.kind === "mac"
      ? "Your Opensteer runs here, and so do its agents."
      : home.kind === "cloud"
        ? "Your Opensteer runs in Opensteer Cloud, always on."
        : "Your Opensteer runs on this server.";
  const status: ComputerStatus =
    home.kind === "mac"
      ? machine
        ? computerStatus(machine)
        : { label: "Starting", tone: "waiting" }
      : connection === "connected"
        ? { label: "Online", tone: "online" }
        : connection === "connecting"
          ? { label: "Connecting", tone: "waiting" }
          : { label: "Offline", tone: "offline" };
  const body = (
    <>
      <DeviceArt art={art} />
      <span className="computers-home__body">
        <span className="computers-home__name">
          {name}
          {machine && machine.id === hereId ? <HerePin /> : null}
        </span>
        <span className="computers-home__line">{line}</span>
      </span>
      <StatusText status={status} />
      {machine ? <Icon className="computers-home__chevron" name="chevron-right" /> : null}
    </>
  );
  const footer = uses.length > 0 || services.length > 0;
  return (
    <section aria-label="Where your Opensteer runs" className="computers-home">
      {machine ? (
        <Link className="computers-home__main" to={computerRoute(machine.id)}>
          {body}
        </Link>
      ) : (
        <div className="computers-home__main">{body}</div>
      )}
      {footer ? (
        <div className="computers-home__foot">
          {uses.length > 0 ? (
            <span className="computers-home__fact">
              <span className="computers-home__label">Agents can use</span>
              <ComputerUseMarks uses={uses} />
            </span>
          ) : null}
          {services.length > 0 ? (
            <span className="computers-home__fact">
              <span className="computers-home__label">Built in</span>
              {services.map((service) => (
                <span className="computers-home__service" key={service.id}>
                  <Icon name={serviceGlyph(service) === "browser" ? "globe" : "message"} />
                  {serviceLabel(service)}
                  <span
                    aria-label={computerStatus(service).label}
                    className={`computer-status__dot computer-status__dot--${computerStatus(service).tone}`}
                    role="img"
                  />
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The computer in front of the reader, offered by name. It is the one way a
 * desktop joins, so it sits where it is seen first rather than in a dialog.
 */
function JoinOffer({
  adding,
  computerName,
  error,
  homeName,
  onAdd,
  runAgents,
}: {
  readonly adding: boolean;
  readonly computerName: string;
  readonly error: string | null;
  /** The Mac a Personal Opensteer runs on; null on a server. */
  readonly homeName: string | null;
  readonly onAdd: () => void;
  readonly runAgents: boolean;
}) {
  return (
    <section aria-labelledby="computers-offer-title" className="computers-offer">
      <span className="computers-offer__glyph">
        <Icon name="pin" />
      </span>
      <span className="computers-offer__body">
        <h2 className="computers-offer__title" id="computers-offer-title">
          You’re on {computerName}
        </h2>
        <p className="computers-offer__detail">{joinOfferDetail({ homeName, runAgents })}</p>
        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </span>
      <button className="btn btn--primary" disabled={adding} onClick={onAdd} type="button">
        {adding ? "Adding…" : `Add ${computerName}`}
      </button>
    </section>
  );
}

export function joinOfferDetail(input: {
  readonly homeName: string | null;
  readonly runAgents: boolean;
}): string {
  if (input.homeName) {
    return `Add it and agents on ${input.homeName} can use its apps and folders. Nothing is shared until you choose.`;
  }
  return input.runAgents
    ? "Add it and agents can work right on it, with its own files, apps and sign-ins."
    : "Add it so agents can use its apps and folders, or work right on it. Nothing is shared until you choose.";
}

function ComputerGroupSection({
  appsLoaded,
  group,
  hereId,
  homeName,
  offered,
  onAdd,
  onAddPhone,
  usesOf,
}: {
  readonly appsLoaded: boolean;
  readonly group: ComputerGroup;
  readonly hereId: string | null;
  readonly homeName: string;
  /** Whether the computer in front of the reader is already offered above. */
  readonly offered: boolean;
  readonly onAdd: (() => void) | null;
  /** A phone joins the same group a person's own computers do. */
  readonly onAddPhone: (() => void) | null;
  readonly usesOf: (machine: MachineSummary) => readonly ComputerUse[];
}) {
  const titleId = `computers-${group.id}-title`;
  return (
    <section aria-labelledby={titleId} className="computers-group">
      <h2 className="computers-group__title" id={titleId}>
        {group.title}
        {group.machines.length > 0 ? (
          <span className="computers-group__count">{group.machines.length}</span>
        ) : null}
      </h2>
      <div className="computers-list">
        {group.machines.length === 0 && onAdd ? (
          <p className="computers-list__empty">
            {group.id === "others"
              ? `Agents on ${homeName} can also use the apps and folders on your other computers.`
              : "Add one of your computers so agents can use its apps and folders, or work right on it."}
          </p>
        ) : null}
        {group.machines.map((machine) => {
          const uses = usesOf(machine);
          return (
            <ComputerRow
              here={machine.id === hereId}
              key={machine.id}
              machine={machine}
              role={computerRole(machine, uses, appsLoaded)}
              uses={uses}
            />
          );
        })}
        {onAdd ? (
          <button className="computer-row computer-row--add" onClick={onAdd} type="button">
            <span className="computer-row__glyph">
              <Icon name="plus" />
            </span>
            {offered ? "Add a different computer" : "Add a computer"}
          </button>
        ) : null}
        {onAddPhone ? (
          <button className="computer-row computer-row--add" onClick={onAddPhone} type="button">
            <span className="computer-row__glyph">
              <Icon name="phone" />
            </span>
            Add a phone
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One computer, read left to right: what it is, what it does for agents, and
 * whether it is there right now. A computer that is away fades rather than
 * gaining another label.
 */
function ComputerRow({
  here,
  machine,
  role,
  uses,
}: {
  readonly here: boolean;
  readonly machine: MachineSummary;
  readonly role: ReturnType<typeof computerRole>;
  readonly uses: readonly ComputerUse[];
}) {
  const status = isAndroidPhone(machine) ? phoneStatus(machine) : computerStatus(machine);
  return (
    <Link
      className={`computer-row${status.tone === "offline" ? " computer-row--away" : ""}`}
      to={computerRoute(machine.id)}
    >
      <span className="computer-row__glyph">
        <Icon name={computerIcon(computerGlyph(machine))} />
      </span>
      <span className="computer-row__body">
        <span className="computer-row__name">
          {machine.name}
          {here ? <HerePin /> : null}
        </span>
        {machine.ownerName || role || uses.length > 0 ? (
          <span className="computer-row__line">
            {machine.ownerName ? (
              <span className="computer-row__owner">
                <span aria-hidden className="computer-row__avatar">
                  {machine.ownerName.trim().charAt(0).toUpperCase()}
                </span>
                {machine.ownerName}
              </span>
            ) : null}
            {role ? <span>{computerRoleLabel[role]}</span> : null}
            <ComputerUseMarks uses={uses} />
          </span>
        ) : null}
      </span>
      <StatusText status={status} />
      <Icon className="computer-row__chevron" name="chevron-right" />
    </Link>
  );
}

/**
 * The browser and messaging services a Deployment runs for itself. Nobody
 * adds one and almost nobody touches one, so administrators find them folded
 * away at the end, with everything they could do to one.
 */
function Services({
  client,
  services,
}: {
  readonly client: ReturnType<typeof useShell>["hostClient"];
  readonly services: readonly MachineSummary[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");

  async function rename(machine: MachineSummary) {
    if (!name.trim()) return;
    setBusy(machine.id);
    setError(null);
    try {
      const result = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey("machine-rename"),
        machineId: machine.id,
        name: name.trim(),
        type: "machine.rename",
      });
      if (result.type !== "machine.rename") throw new Error("Service rename did not complete.");
      await client.refresh();
      setRenaming(null);
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  async function remove(machine: MachineSummary) {
    if (!window.confirm(machineRemovalPrompt(machine))) return;
    setBusy(machine.id);
    setError(null);
    try {
      const result = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey("machine-remove"),
        machineId: machine.id,
        type: "machine.revoke",
      });
      if (result.type !== "machine.revoke") throw new Error("Service removal did not complete.");
      await client.refresh();
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  }

  return (
    <details className="computers-services">
      <summary>
        <h2>Built-in services</h2>
        <span>Opensteer runs these for you. You rarely need to change them.</span>
      </summary>
      <div className="computers-list">
        {services.map((machine) => (
          <div className="computer-row computer-row--static" key={machine.id}>
            <span className="computer-row__glyph">
              <Icon name={serviceGlyph(machine) === "browser" ? "globe" : "message"} />
            </span>
            <span className="computer-row__body">
              {renaming === machine.id ? (
                <span className="computers-inline-field">
                  <input
                    aria-label={`Name for ${machine.name}`}
                    autoFocus
                    className="text-input"
                    maxLength={120}
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                  />
                  <button
                    className="btn btn--small"
                    disabled={busy === machine.id || !name.trim()}
                    onClick={() => void rename(machine)}
                    type="button"
                  >
                    Save
                  </button>
                </span>
              ) : (
                <span className="computer-row__name">{machine.name}</span>
              )}
              <span className="computer-row__line">{serviceLabel(machine)}</span>
            </span>
            <StatusText status={computerStatus(machine)} />
            <span className="computer-row__actions">
              <button
                className="btn btn--ghost btn--small"
                disabled={busy !== null}
                onClick={() => {
                  setName(machine.name);
                  setRenaming(machine.id);
                }}
                type="button"
              >
                Rename
              </button>
              {machine.revocable ? (
                <button
                  className="btn btn--danger btn--small"
                  disabled={busy !== null}
                  onClick={() => void remove(machine)}
                  type="button"
                >
                  {busy === machine.id ? "Removing…" : "Remove"}
                </button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
}

/* ------------------------------------------------------------------------- *
 * One computer
 * ------------------------------------------------------------------------- */

export function ComputerDetailPage() {
  const { computerId } = useParams();
  const { openMobileNavigation, snapshot } = useShell();
  const deploymentName = useDeploymentName();
  const machine = snapshot.machines.find((candidate) => candidate.id === computerId);

  // A computer that is gone is a page that is gone: everything below reads one
  // machine and would have to defend against its absence on every line.
  if (!machine) {
    return (
      <div className="page computers-page">
        <PageTopbar onOpenNavigation={openMobileNavigation} title="Computer" />
        <div className="page__content computers-page__content">
          <PageHeader back={<ComputersBackLink />} title="Computer not found" />
          <p className="card__empty">This computer is not part of {deploymentName} any more.</p>
        </div>
      </div>
    );
  }
  return <ComputerDetail key={machine.id} machine={machine} />;
}

/**
 * Registers this desktop's approval key for a Mac whose page is open on that
 * Mac, whenever the Host holds none or another one. Approvals on the Mac are
 * signed with that key, and the Host accepts them only once its owner has
 * registered it from here, with their own session, at the Mac.
 */
function useRegisterComputerUseApprovalKey(
  machine: MachineSummary,
  onThisMac: boolean,
): ComputerUseApprovalKeySetup {
  const { desktopBridge, hostClient } = useShell();
  const [error, setError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [observedKeyId, setObservedKeyId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const registeredKeyId = machine.computerUse?.approvalKeyId;
  // An older Host sends no key at all, and has nothing to register one with.
  const supported =
    registeredKeyId !== undefined && machine.ownership !== "other" && machine.status === "online";
  useEffect(() => {
    if (!supported || !onThisMac || !desktopBridge) return;
    let cancelled = false;
    setRegistering(true);
    setError(null);
    void (async () => {
      const key = await desktopBridge.computerUseApprovalKey();
      if (cancelled) return;
      setObservedKeyId(key.keyId);
      if (key.keyId === registeredKeyId) return;
      await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`computer-use-approval-key:${machine.id}`),
        input: { publicKey: key.publicKey, runnerId: machine.id },
        type: "integration.computer.approval-key.set",
      });
      await hostClient.refresh();
    })()
      .catch((reason: unknown) => {
        if (!cancelled) setError(actionErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setRegistering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, desktopBridge, hostClient, machine.id, onThisMac, registeredKeyId, supported]);
  return {
    error,
    ready:
      !supported || !onThisMac
        ? registeredKeyId !== null
        : observedKeyId === registeredKeyId && !registering && error === null,
    retry: () => setAttempt((value) => value + 1),
  };
}

/**
 * The sentence under a computer's name: what it is to this Opensteer, in the
 * words of the person reading it.
 */
export function computerDetailLead(input: {
  readonly deploymentKind: "personal" | "server" | null;
  readonly deploymentName: string;
  readonly homeName: string;
  readonly machine: MachineSummary;
}): string {
  const { machine } = input;
  if (machine.status === "pending") {
    return isIphone(machine)
      ? `Waiting for ${machine.name} to connect. Open Opensteer on it to finish adding it.`
      : `Waiting for ${machine.name} to connect. Finish setting it up on that computer.`;
  }
  if (isAndroidPhone(machine)) return phoneUseIntroduction;
  if (isIphone(machine) && machine.ownership !== "other") {
    return `Agents can use only the apps turned on for ${machine.name}, and only while Opensteer is open on it.`;
  }
  if (hostsDeployment(machine, input.deploymentKind)) {
    return `Your Opensteer runs here. Keep ${machine.name} on and awake so agents can keep working while you’re away.`;
  }
  if (input.deploymentKind === "personal") {
    return `Agents work on ${input.homeName}. Choose what they can use on ${machine.name}.`;
  }
  if (machine.ownership === "other") {
    return `${machine.ownerName ?? "Its owner"} chooses what agents can use on ${machine.name}.`;
  }
  if (machine.ownership === "deployment") {
    return `A shared computer: agents from everyone in ${input.deploymentName} can work here.`;
  }
  return `Choose whether agents work on ${machine.name}, and what they can use on it.`;
}

function ComputerDetail({ machine }: { readonly machine: MachineSummary }) {
  const {
    desktopBridge,
    desktopDeployment,
    hostClient,
    localExecutionAction,
    localExecutionError,
    localExecutionStatus,
    openMobileNavigation,
    performLocalExecutionAction,
    snapshot,
  } = useShell();
  const navigate = useNavigate();
  const deploymentName = useDeploymentName();
  const deploymentKind = snapshot.deploymentShape?.kind ?? null;
  const hereId = currentDeviceMachineId({
    deploymentKind,
    hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
    localRunnerId: localExecutionStatus?.runner.runnerId ?? null,
    machines: snapshot.machines,
  });
  const [name, setName] = useState(machine.name);
  const [renaming, setRenaming] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [permissionReview, setPermissionReview] = useState(false);
  const [pluggingIn, setPluggingIn] = useState(false);
  const apps = useComputerAppData(hostClient, snapshot.machineRevision);
  // A link from the Apps settings names one app on this computer rather than
  // copying its editor, so the page brings that app's row into view.
  const focusDefinitionId = computerAppIdFromHash(useLocation().hash);
  // A rename somewhere else — or on this page — is the name this field shows.
  useEffect(() => {
    setName(machine.name);
  }, [machine.name]);
  const here = hereId !== null && machine.id === hereId;
  const mainRunner = hostsDeployment(machine, deploymentKind);
  // Whether this page runs in the desktop app on this very Mac — a lent one,
  // or the one hosting this Personal Deployment, which has no lent slot. It is
  // the one answer for everything only that Mac can do: open a macOS grant,
  // register the approval key, approve an app. It only decides which controls
  // the renderer offers; the desktop signs the exact Host-issued request with
  // its approval key, and the Host verifies that proof before it accepts any
  // new or wider access.
  const onThisMac = fullAccessOnThisMac({
    hostsDeployment: mainRunner,
    hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
    inDesktopApp: desktopBridge !== null,
    lentByThisDesktop: here && !mainRunner,
  });
  const computerUseApprovalKeySetup = useRegisterComputerUseApprovalKey(machine, onThisMac);
  // A phone lends only its screen: agents never work on it, it has no files or
  // commands to share, and no Mac permissions to give.
  const phone = isAndroidPhone(machine);
  // An iPhone lends only its own apps, which its apps section covers.
  const iphone = isIphone(machine);
  const homeName =
    snapshot.machines.find((candidate) => hostsDeployment(candidate, deploymentKind))?.name ??
    deploymentName;
  const runsAgentsSwitch = here && !mainRunner && machine.allowedModules.includes("agents");
  const removable = machine.revocable && !mainRunner;
  const busy = localExecutionAction !== null || removing;
  const stakes = machineRemovalStakes(machine);
  const status = phone ? phoneStatus(machine) : computerStatus(machine);
  /**
   * The macOS grant has exactly one place to be explained. When an app on this
   * computer is already asking for it — with the directions for that Mac — a
   * second block saying the same thing is a second instruction path, so the
   * app's own notice is the one that stands.
   */
  const appsAskingForFullDiskAccess = apps.data
    ? computerAppRows({
        connections: apps.data.connections,
        definitions: apps.data.definitions,
        machine,
      }).some(
        ({ state }) => state.kind === "permission-required" && state.remedy === "full-disk-access",
      )
    : false;

  async function saveName() {
    const next = name.trim();
    if (!next || next === machine.name) return;
    setSavingName(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey("computer-rename"),
        machineId: machine.id,
        name: next,
        type: "machine.rename",
      });
      if (result.type !== "machine.rename") throw new Error("Computer rename did not complete.");
      await hostClient.refresh();
      setRenaming(false);
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setSavingName(false);
    }
  }

  async function requestComputerAppSetup(input: ComputerAppRequestInput): Promise<void> {
    const result = await hostClient.dispatch({
      idempotencyKey: mutationIdempotencyKey(`computer-app-setup:${input.definitionId}`),
      input: {
        access: input.access,
        app: null,
        definitionId: input.definitionId,
        kind: "app",
        runnerId: input.runnerId,
      },
      type: "integration.computer.setup.request",
    });
    if (result.type !== "integration.computer.setup.request") {
      throw new Error("The setup request did not complete.");
    }
  }

  async function cancelComputerAppSetup(request: ComputerAppSetupRequest): Promise<void> {
    const result = await hostClient.dispatch({
      idempotencyKey: mutationIdempotencyKey(`computer-app-setup-cancel:${request.definitionId}`),
      requestId: request.id,
      type: "integration.computer.setup.cancel",
    });
    if (result.type !== "integration.computer.setup.cancel") {
      throw new Error("The setup request was not canceled.");
    }
  }

  async function approveComputerAppAccess(input: ComputerAppApprovalInput): Promise<boolean> {
    if (!desktopBridge) throw new Error("Opensteer Desktop is required to approve app access.");
    // The displayed request may have expired or been replaced since the page
    // loaded. The Host returns its current intent for this exact scope, pushes
    // it to this Mac, and the panel and the answer go through the Mac itself.
    const current = await hostClient.dispatch({
      idempotencyKey: mutationIdempotencyKey(`computer-app-setup:${input.definitionId}`),
      input: {
        access: input.access,
        app: null,
        definitionId: input.definitionId,
        kind: "app",
        runnerId: input.runnerId,
      },
      type: "integration.computer.setup.request",
    });
    if (current.type !== "integration.computer.setup.request") {
      throw new Error("The setup request did not complete.");
    }
    return (await desktopBridge.reviewComputerAppSetup({ setupRequestId: current.request.id }))
      .allowed;
  }

  /**
   * Leaves the page only once the computer has actually left the Deployment.
   *
   * Removal is two operations on this device — the Host forgets the computer,
   * then the desktop stops its Runner — and either can fail. Navigating back
   * to a list that still holds the row would say it worked; the page stays put
   * and names what went wrong instead, and Remove can be tried again.
   */
  async function remove() {
    if (!window.confirm(machineRemovalPrompt(machine))) return;
    setRemoving(true);
    setError(null);
    try {
      // The order is the shell's business: it revokes first, so a Runner is
      // never stopped for a computer the Host still holds.
      if (here) {
        await performLocalExecutionAction({ kind: "remove" });
      } else {
        const result = await hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey("computer-remove"),
          machineId: machine.id,
          type: "machine.revoke",
        });
        if (result.type !== "machine.revoke") throw new Error("Computer removal did not complete.");
        await hostClient.refresh();
      }
    } catch (reason) {
      setError(actionErrorMessage(reason));
      return;
    } finally {
      setRemoving(false);
    }
    void navigate("/settings/computers");
  }

  return (
    <div className="page computers-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={machine.name} />
      <div className="page__content computers-page__content">
        <ComputersBackLink />
        <header className="computer-header">
          <DeviceArt art={computerGlyph(machine)} />
          <div className="computer-header__body">
            {renaming ? (
              <span className="computers-inline-field">
                <input
                  aria-label="Computer name"
                  autoFocus
                  className="text-input"
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveName();
                    if (event.key === "Escape") {
                      setName(machine.name);
                      setRenaming(false);
                    }
                  }}
                  value={name}
                />
                <button
                  className="btn btn--small btn--primary"
                  disabled={savingName || !name.trim() || name.trim() === machine.name}
                  onClick={() => void saveName()}
                  type="button"
                >
                  {savingName ? "Saving…" : "Save"}
                </button>
                <button
                  className="btn btn--small"
                  disabled={savingName}
                  onClick={() => {
                    setName(machine.name);
                    setRenaming(false);
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <h1 className="computer-header__name">
                {machine.name}
                <button
                  aria-label={`Rename ${machine.name}`}
                  className="icon-btn computer-header__rename"
                  onClick={() => setRenaming(true)}
                  type="button"
                >
                  <Icon name="pencil" />
                </button>
              </h1>
            )}
            <p className="computer-header__facts">
              <StatusText status={status} />
              {machine.ownerName ? (
                <span className="computer-header__owner">
                  {machine.ownerName}’s {phone || iphone ? "phone" : "computer"}
                </span>
              ) : null}
              {here ? <HerePin /> : null}
            </p>
          </div>
        </header>
        <p className="computer-lead">
          {computerDetailLead({ deploymentKind, deploymentName, homeName, machine })}
        </p>

        {/* Whether a teammate's computer lends itself to agents is theirs to
            decide, so their page only says so when agents do work there. */}
        {!phone &&
        !iphone &&
        deploymentKind === "server" &&
        machine.status !== "pending" &&
        (machine.ownership !== "other" || machine.modules.agents) ? (
          <section aria-labelledby="runs-agents-title" className="computers-section">
            <h2 className="visually-hidden" id="runs-agents-title">
              Agents work here
            </h2>
            <div className="card">
              {runsAgentsSwitch && localExecutionStatus ? (
                <label className="card__row">
                  <span className="card__row-glyph">
                    <Icon name="bolt" />
                  </span>
                  <span className="card__row-body">
                    <span className="card__row-title">Agents work here</span>
                    <span className="card__row-detail card__row-detail--wrap">
                      {runsAgentsDetail(machine.name)}
                    </span>
                  </span>
                  <span className="machine-access__grant-control">
                    <input
                      aria-label={`Agents work on ${machine.name}`}
                      checked={localExecutionStatus.runAgents}
                      className="switch"
                      disabled={busy || !localExecutionStatus.mayRunAgents}
                      // The shell records the message and the notice below
                      // renders it; the switch has nothing else to decide.
                      onChange={(event) =>
                        void performLocalExecutionAction({
                          kind: "set-run-agents",
                          runAgents: event.target.checked,
                        }).catch(() => undefined)
                      }
                      role="switch"
                      type="checkbox"
                    />
                  </span>
                </label>
              ) : (
                <div className="card__row">
                  <span className="card__row-glyph">
                    <Icon name="bolt" />
                  </span>
                  <span className="card__row-body">
                    <span className="card__row-title">
                      {machine.modules.agents ? "Agents work here" : "Agents don’t work here"}
                    </span>
                    <span className="card__row-detail card__row-detail--wrap">
                      {runsAgentsFact(machine)}
                    </span>
                  </span>
                </div>
              )}
              {runsAgentsSwitch && localExecutionStatus ? (
                <LocalReadiness
                  action={localExecutionAction}
                  deploymentName={deploymentName}
                  onAction={performLocalExecutionAction}
                  status={localExecutionStatus}
                />
              ) : null}
              {localExecutionError && here ? (
                <p className="notice notice--error" role="alert">
                  {localExecutionError}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {apps.data && phone ? (
          <PhoneSection
            connections={apps.data.connections}
            definitions={apps.data.definitions}
            hostClient={hostClient}
            hostConnected={canRespondToRequests(snapshot)}
            machine={machine}
            onChanged={async () => {
              await apps.reload();
              await hostClient.refresh();
            }}
            onPlugIn={() => setPluggingIn(true)}
          />
        ) : apps.data ? (
          <ComputerAppsSection
            hostConnected={canRespondToRequests(snapshot)}
            computerUseApprovalKeySetup={computerUseApprovalKeySetup}
            computerUseLocal={
              onThisMac && desktopBridge
                ? {
                    openPermissions: () => desktopBridge.openComputerUsePermissionsPanel(),
                    reviewSetup: async (setupRequestId) =>
                      (await desktopBridge.reviewComputerAppSetup({ setupRequestId })).allowed,
                  }
                : null
            }
            connections={apps.data.connections}
            definitions={apps.data.definitions}
            focusDefinitionId={focusDefinitionId}
            hostClient={hostClient}
            key={machine.id}
            localApproval={
              onThisMac && desktopBridge
                ? {
                    approveAccess: approveComputerAppAccess,
                    reviewPermission: async ({ access, definitionId, remedy }) => {
                      const app = ComputerUseDataAppIdSchema.safeParse(definitionId);
                      const grant = ComputerUseDataGrantSchema.safeParse(remedy);
                      if (!app.success || !grant.success || !desktopBridge) return;
                      // The helper holds every one of these grants; this Mac's
                      // setup panel takes each macOS step the access needs.
                      await desktopBridge.openComputerAppSetup({ access, definitionId: app.data });
                      await apps.reload();
                    },
                  }
                : null
            }
            machine={machine}
            onCancelSetupRequest={cancelComputerAppSetup}
            onChanged={async () => {
              await apps.reload();
            }}
            onRequestSetup={requestComputerAppSetup}
            owned={ownsComputerApps({
              connections: apps.data.connections,
              hostsDeployment: mainRunner,
              machine,
            })}
            platform={apps.data.platform}
            setupRequests={apps.data.setupRequests.filter(
              (request) => request.runnerId === machine.id,
            )}
            workspaces={snapshot.workspaces}
          />
        ) : null}
        {apps.error ? (
          <p className="notice notice--error" role="alert">
            {apps.error}
          </p>
        ) : null}

        {machine.access && !mainRunner && !phone && !iphone ? (
          <details className="computers-section computers-files">
            <summary>
              <h2>Files and commands</h2>
              <span>
                {machineAccessSummary(machine.access.policy, {
                  deploymentName,
                  machineName: machine.name,
                })}
              </span>
            </summary>
            <MachineAccessSection
              access={machine.access}
              client={hostClient}
              deploymentKind={deploymentKind}
              deploymentName={deploymentName}
              // The desktop can only name folders on the computer it runs on.
              desktopBridge={here ? desktopBridge : null}
              machineId={machine.id}
              machineName={machine.name}
              machineRevision={snapshot.machineRevision}
              ownership={machine.ownership}
            />
          </details>
        ) : null}

        {machine.fullDiskAccess === null ||
        appsAskingForFullDiskAccess ||
        phone ||
        iphone ? null : (
          <section aria-labelledby="macos-permissions-title" className="computers-section">
            <div className="section-heading">
              <div>
                <h2 id="macos-permissions-title">Mac permissions</h2>
              </div>
            </div>
            <div className="card">
              <div className="card__row">
                <span className="card__row-glyph">
                  <Icon name={machine.fullDiskAccess ? "check-circle" : "key"} />
                </span>
                <span className="card__row-body">
                  <span className="card__row-title">{fullDiskAccessLabel}</span>
                  <span className="card__row-detail card__row-detail--wrap">
                    {machine.status === "online"
                      ? fullAccessDetail({
                          granted: machine.fullDiskAccess,
                          machineName: machine.name,
                          onThisDevice: onThisMac,
                        })
                      : machine.fullDiskAccess
                        ? "Last reported on. Current status is unavailable while this computer is offline."
                        : "Last reported off. Current status is unavailable while this computer is offline."}
                  </span>
                </span>
                <span className="card__row-actions">
                  {!machine.fullDiskAccess && onThisMac && desktopBridge ? (
                    <button
                      className="btn btn--primary btn--small"
                      onClick={() => setPermissionReview(true)}
                      type="button"
                    >
                      {fullAccessButtonLabel}
                    </button>
                  ) : (
                    <span className={machine.fullDiskAccess ? "chip chip--ok" : "chip"}>
                      {machine.fullDiskAccess ? "On" : "Off"}
                    </span>
                  )}
                </span>
              </div>
            </div>
          </section>
        )}

        {machine.unlinkedLocalFolders > 0 ? (
          <p className="settings-footnote">{unlinkedFoldersLabel(machine.unlinkedLocalFolders)}.</p>
        ) : null}

        {removable ? (
          <section aria-label="Remove this computer" className="computer-remove">
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={() => void remove()}
              type="button"
            >
              {removing ? "Removing…" : `Remove ${machine.name}`}
            </button>
            <span className="computer-remove__detail">
              {stakes ??
                (phone
                  ? "Agents lose access to it, and its Agent Phone app stops working for this Opensteer."
                  : iphone
                    ? "Agents stop using its apps. Nothing on the iPhone is deleted."
                    : "Agents lose access to it. Nothing on the computer is deleted.")}
            </span>
          </section>
        ) : mainRunner ? (
          <p className="settings-footnote">
            {machine.name} can’t be removed, because your Opensteer runs on it.
          </p>
        ) : null}

        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {pluggingIn ? (
        <AddPhoneDialog
          client={hostClient}
          deploymentKind={deploymentKind}
          deploymentName={deploymentName}
          desktopBridge={desktopBridge}
          homeName={homeName}
          onClose={() => setPluggingIn(false)}
          phoneName={machine.name}
        />
      ) : null}
      {permissionReview && desktopBridge ? (
        <MacOsPermissionReviewDialog
          bridge={desktopBridge}
          onClose={() => setPermissionReview(false)}
          onError={(reason) => setError(actionErrorMessage(reason))}
        />
      ) : null}
    </div>
  );
}

/**
 * A phone that is there may still be unusable — paused by its owner, or its
 * accessibility service turned off — and its status says so in the phone's
 * own words rather than "Online".
 */
function phoneStatus(machine: MachineSummary): ComputerStatus {
  const state = phoneUseState(machine);
  switch (state.kind) {
    case "needs-update":
    case "offline":
      return computerStatus(machine);
    case "unavailable":
    case "permission-required":
      return { label: state.detail, tone: "waiting" };
    case "ready":
      return { label: "Online", tone: "online" };
  }
}

function computerRoute(machineId: string): string {
  return `/settings/computers/${encodeURIComponent(machineId)}`;
}

/**
 * The one route to one app on one computer.
 *
 * The Apps settings and this page show the same editor because they are the
 * same editor: the list over there links here by computer and definition
 * rather than carrying a second copy of the control that would have to be kept
 * in step.
 */
export function computerAppRoute(input: {
  readonly definitionId: string;
  readonly runnerId: string;
}): string {
  return `${computerRoute(input.runnerId)}#${computerAppAnchorId(input.definitionId)}`;
}

/** The definition a `#computer-app-…` fragment names, if it names one. */
export function computerAppIdFromHash(hash: string): string | null {
  const bare = hash.startsWith("#") ? hash.slice(1) : hash;
  const prefix = computerAppAnchorId("");
  return bare.startsWith(prefix) && bare.length > prefix.length ? bare.slice(prefix.length) : null;
}

function ComputersBackLink() {
  return (
    <Link className="page__back" to="/settings/computers">
      <Icon name="arrow-left" />
      Computers
    </Link>
  );
}

function runsAgentsDetail(machineName: string): string {
  return `New threads can run on ${machineName}, using its own files, apps and sign-ins.`;
}

/** Why agents do or do not work on a computer this page cannot switch. */
function runsAgentsFact(machine: MachineSummary): string {
  if (!machine.allowedModules.includes("agents")) {
    return `${machine.name} was added only to lend its apps and folders. To let agents work on it, remove it and add it again from ${machine.name}.`;
  }
  if (machine.modules.agents) return runsAgentsDetail(machine.name);
  return machine.ownership === "mine"
    ? `Turn this on in the Opensteer app on ${machine.name}.`
    : `Threads can’t be placed on ${machine.name}.`;
}

/**
 * What this computer has ready for the work placed on it. Cloud Workspaces are
 * an add-on, never a precondition: agents run here on folders of its own disk
 * whether or not PortableFS is set up.
 */
function LocalReadiness({
  action,
  deploymentName,
  onAction,
  status,
}: {
  readonly action: LocalExecutionAction | null;
  readonly deploymentName: string;
  readonly onAction: (action: LocalExecutionAction) => Promise<void>;
  readonly status: NonNullable<ReturnType<typeof useShell>["localExecutionStatus"]>;
}) {
  return (
    <div className="computers-readiness-block">
      <div className="computers-readiness">
        <ReadinessLine
          label="Agents on this computer"
          ready={status.runner.state === "running"}
          text={localRunnerStateLabel(status.runner.state)}
        />
        <ReadinessLine
          label={`${deploymentName}'s cloud Workspaces (optional)`}
          ready={status.portableFs.state === "ready-to-mount"}
          text={cloudWorkspaceText(status)}
        />
      </div>
      {status.portableFs.state === "missing" && status.portableFs.installAvailable ? (
        <div className="form-actions">
          <button
            className="btn btn--small"
            disabled={action !== null}
            onClick={() => void onAction({ kind: "install" }).catch(() => undefined)}
            type="button"
          >
            {action?.kind === "install"
              ? "Setting up…"
              : `Also work on ${deploymentName}'s cloud Workspaces from here`}
          </button>
        </div>
      ) : null}
      {status.portableFs.state === "needs-user-approval" ? (
        <div className="notice notice--warn">
          <strong>One Mac setting, only for cloud Workspaces</strong>
          <p>
            Agents already run here without it. In System Settings, open General → Login Items &amp;
            Extensions → File System Extensions, then enable PortableFS.
          </p>
          <div className="form-actions">
            <button
              className="btn btn--small"
              disabled={action !== null}
              onClick={() => void onAction({ kind: "open-setup" }).catch(() => undefined)}
              type="button"
            >
              Open setup
            </button>
            <button
              className="btn btn--primary btn--small"
              disabled={action !== null}
              onClick={() => void onAction({ kind: "acknowledge" }).catch(() => undefined)}
              type="button"
            >
              I enabled it
            </button>
          </div>
        </div>
      ) : null}
      {linuxFuseGuidance(status) ? (
        <div className="notice notice--warn">
          <strong>Cloud Workspaces need FUSE 3</strong>
          <p>
            Agents already run here without it. To also work on {deploymentName}&apos;s cloud
            Workspaces, install your distribution&apos;s FUSE 3 package. Ubuntu or Debian:{" "}
            <code>sudo apt install fuse3</code>. Fedora or RHEL: <code>sudo dnf install fuse3</code>
            .
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ReadinessLine({
  label,
  ready,
  text,
}: {
  readonly label: string;
  readonly ready: boolean;
  readonly text: string;
}) {
  return (
    <div className="computers-readiness__line">
      <span className={`status-dot ${ready ? "status-dot--running" : "status-dot--idle"}`} />
      <strong>{label}</strong>
      <span>{text}</span>
    </div>
  );
}

/**
 * Absent PortableFS is never a fault here — the computer still runs agents on
 * folders of its own — so the wording stays an invitation rather than a repair.
 */
function cloudWorkspaceText(
  status: NonNullable<ReturnType<typeof useShell>["localExecutionStatus"]>,
): string {
  switch (status.portableFs.state) {
    case "checking":
      return "Checking";
    case "installing":
      return "Setting up";
    case "missing":
      return "Not set up yet";
    case "needs-user-approval":
      return "Needs your approval";
    case "ready-to-mount":
      return "Ready";
    case "unsupported":
      return status.platform === "windows" ? "Not available on Windows" : "Not available";
    case "failed":
      return "Needs attention";
  }
}

function linuxFuseGuidance(
  status: NonNullable<ReturnType<typeof useShell>["localExecutionStatus"]>,
): boolean {
  return (
    status.platform === "linux" &&
    status.portableFs.state === "failed" &&
    status.portableFs.issue?.startsWith("fuse-") === true
  );
}
