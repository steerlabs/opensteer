import { useEffect, useId, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  ComputerUseDataAppIdSchema,
  ComputerUseDataGrantSchema,
  type MachineSummary,
} from "@opensteer/protocol";
import { computerGlyph, deviceRemovalProfiles, hostsDeployment } from "@opensteer/client/computers";
import {
  canRespondToRequests,
  fullAccessOnThisMac,
  mutationIdempotencyKey,
} from "@opensteer/client/host";
import { isAgentPhone, ownsComputerApps } from "@opensteer/client/integrations";
import type { ComputerAppSetupSummary as ComputerAppSetupRequest } from "@opensteer/integration-core";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import {
  ComputerAppsSection,
  type ComputerAppApprovalInput,
  type ComputerAppRequestInput,
  useComputerAppData,
} from "../computer-apps/computer-apps-section.js";
import { useComputerAppApproval } from "../computer-apps/computer-app-approval.js";
import { AddPhoneDialog } from "../computers/add-phone-dialog.js";
import { DeviceArt } from "../computers/device-art.js";
import { HerePin } from "../computers/here-pin.js";
import { useHereId } from "../computers/here.js";
import { PhoneSection } from "../computers/phone-section.js";
import { useDeploymentName } from "../deployment-name.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { MacOsPermissionReviewDialog } from "../macos-permission-review-dialog.js";
import { MachineAccessSection } from "../machine-access/machine-access-section.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { RemoteAccessCard } from "../settings/sections/remote-access-card.js";
import { SettingsError } from "../settings/primitives.js";
import { deviceStatusLine, deviceSwitches, type DeviceCapability } from "./device-access.js";
import { DeviceAccessSwitches, useAccessSwitch } from "./device-access-switches.js";
import { deviceNotificationsOn, setDeviceNotifications } from "./device-preferences.js";
import { computerAppIdFromHash, devicesRoute } from "./device-routes.js";
import { useThisDevice } from "./this-device.js";

export function DevicePage() {
  const { deviceId } = useParams();
  const { openMobileNavigation, snapshot } = useShell();
  const deploymentName = useDeploymentName();
  const machine = snapshot.machines.find((candidate) => candidate.id === deviceId);
  if (!machine) {
    return (
      <div className="page device-page">
        <PageTopbar onOpenNavigation={openMobileNavigation} title="Device" />
        <div className="page__content device-page__content">
          <DevicesBackLink />
          <PageHeader title="Device not found" />
          <p className="card__empty">This device isn’t one of {deploymentName}’s any more.</p>
        </div>
      </div>
    );
  }
  return <DeviceDetail key={machine.id} machine={machine} />;
}

/** The sentence a removal asks, in the words design settled for every device. */
export function deviceRemovalCopy(input: {
  readonly machine: Pick<MachineSummary, "id" | "name" | "status">;
  readonly thisDevice: boolean;
  readonly profiles: Parameters<typeof deviceRemovalProfiles>[1];
}): { readonly title: string; readonly body: string; readonly confirm: string } {
  if (input.thisDevice)
    return {
      title: "Sign out and remove this Mac?",
      body: "Your agent can no longer use this Mac. Browser profiles kept here are deleted. Your files stay.",
      confirm: "Sign out and remove",
    };
  const profiles = deviceRemovalProfiles(input.machine, input.profiles);
  return {
    title: `Remove ${input.machine.name}?`,
    body: [
      "It is signed out and your agent can’t use it.",
      input.machine.status === "online" ? null : "It finishes the next time it connects.",
      input.machine.status === "online" ? profiles : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" "),
    confirm: "Remove",
  };
}

function DeviceDetail({ machine }: { readonly machine: MachineSummary }) {
  const { desktopBridge, desktopDeployment, hostClient, openMobileNavigation, snapshot } =
    useShell();
  const navigate = useNavigate();
  const deploymentName = useDeploymentName();
  const device = useThisDevice();
  const hereId = useHereId();
  const here = hereId !== null && machine.id === hereId;
  const home = hostsDeployment(machine);
  const phone = isAgentPhone(machine);
  const leavesHere = here && !home && device !== null;
  const homeName = snapshot.machines.find(hostsDeployment)?.name ?? deploymentName;
  const apps = useComputerAppData(hostClient, snapshot.machineRevision);
  const approval = useComputerAppApproval(hostClient);
  const access = useAccessSwitch(hostClient, machine);
  const focusDefinitionId = computerAppIdFromHash(useLocation().hash);
  const [name, setName] = useState(machine.name);
  const [renaming, setRenaming] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [permissionReview, setPermissionReview] = useState(false);
  const [pluggingIn, setPluggingIn] = useState(false);
  const removalTitleId = useId();
  useEffect(() => setName(machine.name), [machine.name]);

  const onThisMac = fullAccessOnThisMac({
    hostsDeployment: home,
    hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
    inDesktopApp: desktopBridge !== null,
    lentByThisDesktop: here && !home,
  });
  const switches = deviceSwitches(machine, snapshot.devicesAvailable === true);
  const removal = deviceRemovalCopy({
    machine,
    thisDevice: leavesHere,
    profiles: snapshot.browserProfiles,
  });

  async function saveName() {
    const next = name.trim();
    if (!next || next === machine.name) return;
    setSavingName(true);
    setError(null);
    try {
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey("device-rename"),
        machineId: machine.id,
        name: next,
        type: "machine.rename",
      });
      if (result.type !== "machine.rename") throw new Error("The rename didn’t finish.");
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
    if (result.type !== "integration.computer.setup.request")
      throw new Error("The setup request did not complete.");
  }

  async function cancelComputerAppSetup(request: ComputerAppSetupRequest): Promise<void> {
    const result = await hostClient.dispatch({
      idempotencyKey: mutationIdempotencyKey(`computer-app-setup-cancel:${request.definitionId}`),
      requestId: request.id,
      type: "integration.computer.setup.cancel",
    });
    if (result.type !== "integration.computer.setup.cancel")
      throw new Error("The setup request was not canceled.");
  }

  async function approveComputerAppAccess(input: ComputerAppApprovalInput): Promise<boolean> {
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
    if (current.type !== "integration.computer.setup.request")
      throw new Error("The setup request did not complete.");
    return approval.ask(current.request.id);
  }

  async function remove() {
    setRemoving(true);
    setError(null);
    try {
      if (leavesHere) {
        // Desktop main fences this Mac and delivers the signed leave; the
        // window then shows it signed out.
        await device?.leave();
        return;
      }
      const result = await hostClient.dispatch({
        idempotencyKey: mutationIdempotencyKey(`device-remove:${machine.id}`),
        machineId: machine.id,
        type: "machine.revoke",
      });
      if (result.type !== "machine.revoke") throw new Error("Removing it didn’t finish.");
      await hostClient.refresh();
      void navigate(devicesRoute);
    } catch (reason) {
      setError(actionErrorMessage(reason));
      setConfirmingRemoval(false);
    } finally {
      setRemoving(false);
    }
  }

  const appsEditor = apps.data ? (
    phone ? (
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
    ) : (
      <ComputerAppsSection
        computerUseLocal={
          onThisMac && desktopBridge
            ? { openPermissions: () => desktopBridge.openComputerUsePermissionsPanel() }
            : null
        }
        connections={apps.data.connections}
        definitions={apps.data.definitions}
        focusDefinitionId={focusDefinitionId}
        hostClient={hostClient}
        hostConnected={canRespondToRequests(snapshot)}
        localApproval={{
          approveAccess: approveComputerAppAccess,
          ...(onThisMac && desktopBridge
            ? {
                reviewPermission: async ({ access: wanted, definitionId, remedy }) => {
                  const app = ComputerUseDataAppIdSchema.safeParse(definitionId);
                  const grant = ComputerUseDataGrantSchema.safeParse(remedy);
                  if (!app.success || !grant.success) return;
                  await desktopBridge.openComputerAppSetup({
                    access: wanted,
                    definitionId: app.data,
                  });
                  await apps.reload();
                },
              }
            : {}),
        }}
        machine={machine}
        onCancelSetupRequest={cancelComputerAppSetup}
        onChanged={async () => {
          await apps.reload();
        }}
        onRequestSetup={requestComputerAppSetup}
        owned={ownsComputerApps({
          connections: apps.data.connections,
          hostsDeployment: home,
          machine,
        })}
        platform={apps.data.platform}
        setupRequests={apps.data.setupRequests.filter((request) => request.runnerId === machine.id)}
      />
    )
  ) : null;

  const editors: Partial<Record<DeviceCapability, React.ReactNode>> = {
    browser: (
      <Link className="device-uses__link" to="/settings/sign-ins/browsers">
        <Icon name="browser" />
        <span>Browser profiles and sign-ins</span>
        <Icon name="chevron-right" />
      </Link>
    ),
    apps: appsEditor,
    files:
      machine.access && !home ? (
        <MachineAccessSection
          access={machine.access}
          client={hostClient}
          deploymentName={deploymentName}
          desktopBridge={here ? desktopBridge : null}
          embedded
          machineId={machine.id}
          machineName={machine.name}
          machineRevision={snapshot.machineRevision}
          ownership={machine.ownership}
        />
      ) : null,
  };
  const elsewhere = (
    <p className="device-uses__hint">Allow it in System Settings on {machine.name}.</p>
  );
  const remedy: Partial<Record<DeviceCapability, React.ReactNode>> = {
    apps:
      onThisMac && desktopBridge ? (
        <button
          className="btn btn--small"
          onClick={() =>
            void desktopBridge.openComputerUsePermissionsPanel().catch(() => undefined)
          }
          type="button"
        >
          Open System Settings
        </button>
      ) : (
        elsewhere
      ),
    files:
      onThisMac && desktopBridge ? (
        <button className="btn btn--small" onClick={() => setPermissionReview(true)} type="button">
          Open System Settings
        </button>
      ) : (
        elsewhere
      ),
  };

  return (
    <div className="page device-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={machine.name} />
      <div className="page__content device-page__content">
        <DevicesBackLink />
        <header className="computer-header">
          <DeviceArt art={computerGlyph(machine)} />
          <div className="computer-header__body">
            {renaming ? (
              <span className="device-rename">
                <input
                  aria-label="Device name"
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
                <span className="device-page__name">{machine.name}</span>
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
              <span
                className={`computer-status${machine.status === "offline" ? " device-page__away" : ""}`}
              >
                <span
                  aria-hidden
                  className={`computer-status__dot computer-status__dot--${machine.status === "online" ? "online" : machine.status === "offline" ? "offline" : "waiting"}`}
                />
                {deviceStatusLine(machine)}
              </span>
              {here ? <HerePin /> : null}
            </p>
          </div>
        </header>

        <DeviceAccessSwitches
          editors={editors}
          machine={machine}
          notice={access.notice}
          onSet={(capability, on) => void access.set(capability, on)}
          pending={access.pending}
          remedy={remedy}
          switches={switches}
          thisDevice={here}
        />
        {apps.error ? <SettingsError message={apps.error} /> : null}

        {here && desktopDeployment ? (
          <NotificationsHere deploymentId={desktopDeployment.id} />
        ) : null}

        {home ? (
          <>
            <div id="use-from-anywhere">
              <RemoteAccessCard />
            </div>
            {snapshot.personalSettings ? (
              <section aria-labelledby="device-home-folder" className="settings-group">
                <h2 className="settings-group__title" id="device-home-folder">
                  Agent home folder
                </h2>
                <Link className="card card__row device-uses__link" to="/settings/general">
                  <Icon name="folder" />
                  <span className="card__row-body">
                    <span className="card__row-title device-page__path">
                      {snapshot.personalSettings.agentHome.path}
                    </span>
                  </span>
                  <Icon name="chevron-right" />
                </Link>
              </section>
            ) : null}
            <p className="settings-footnote">
              Your Opensteer lives on this Mac, so it can’t be removed.
            </p>
          </>
        ) : machine.revocable || leavesHere ? (
          <section aria-label="Remove" className="device-remove">
            <button
              className="btn btn--danger"
              disabled={removing}
              onClick={() => setConfirmingRemoval(true)}
              type="button"
            >
              {leavesHere ? "Sign out and remove this Mac" : "Remove"}
            </button>
          </section>
        ) : null}
        <SettingsError message={error} />
      </div>
      {confirmingRemoval ? (
        <Dialog
          footer={
            <>
              <button
                className="btn btn--ghost"
                disabled={removing}
                onClick={() => setConfirmingRemoval(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn--danger"
                disabled={removing}
                onClick={() => void remove()}
                type="button"
              >
                {removing ? "Removing…" : removal.confirm}
              </button>
            </>
          }
          labelledBy={removalTitleId}
          onClose={() => setConfirmingRemoval(false)}
          title={<span id={removalTitleId}>{removal.title}</span>}
        >
          <p>{removal.body}</p>
        </Dialog>
      ) : null}
      {pluggingIn ? (
        <AddPhoneDialog
          client={hostClient}
          deploymentName={deploymentName}
          desktopBridge={desktopBridge}
          homeName={homeName}
          onClose={() => setPluggingIn(false)}
          phoneName={machine.name}
        />
      ) : null}
      {approval.dialog}
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

/** Notifications belong to the device showing them, so only its own page has the switch. */
function NotificationsHere({ deploymentId }: { readonly deploymentId: string }) {
  const [on, setOn] = useState(() => deviceNotificationsOn(deploymentId));
  return (
    <section aria-labelledby="device-here-title" className="settings-group">
      <h2 className="settings-group__title" id="device-here-title">
        On this Mac
      </h2>
      <div className="card">
        <div className="card__row">
          <span className="card__row-body">
            <span className="card__row-title" id="device-notifications">
              Notifications
            </span>
            <span className="card__row-detail">Tell you when your agent needs you or finishes</span>
          </span>
          <span className="card__row-actions">
            <input
              aria-labelledby="device-notifications"
              checked={on}
              className="switch"
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setOn(next);
                setDeviceNotifications(deploymentId, next);
              }}
              role="switch"
              type="checkbox"
            />
          </span>
        </div>
      </div>
    </section>
  );
}

function DevicesBackLink() {
  return (
    <Link className="page__back" to={devicesRoute}>
      <Icon name="arrow-left" />
      Devices
    </Link>
  );
}
