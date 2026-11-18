import { computerTargetId } from "@opensteer/client/host";
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
  deviceMachine,
  fullAccessOnThisMac,
  mutationIdempotencyKey,
} from "@opensteer/client/host";
import {
  ownsComputerApps,
  phoneScreenDisconnectCopy,
  phoneScreenMac,
  phoneScreenRemovalCopy,
  phoneScreenStatus,
} from "@opensteer/client/integrations";
import { DeploymentIdSchema, DeviceIdSchema, TabTargetSchema } from "@opensteer/core";
import type { ComputerAppSetupSummary as ComputerAppSetupRequest } from "@opensteer/client/integrations";
import { act, failureWords } from "../use-action.js";
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
import { AddIphoneDialog, type ExistingIphoneTarget } from "./add-iphone-dialog.js";
import { useDeploymentName } from "../deployment-name.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { MacOsPermissionReviewDialog } from "../macos-permission-review-dialog.js";
import { MachineAccessSection } from "../machine-access/machine-access-section.js";
import { PageHeader, PageTopbar } from "../page-header.js";
import { useOptionalWorkspace } from "../workspace/workspace-context.js";
import { RemoteAccessCard } from "../settings/sections/remote-access-card.js";
import { SettingsError } from "../settings/primitives.js";
import {
  cancelDeviceSetup,
  deviceStatusLine,
  deviceSwitches,
  pendingEnrollmentId,
  type DeviceCapability,
} from "./device-access.js";
import {
  DeviceAccessNotice,
  DeviceAccessSwitchRow,
  DeviceAccessSwitches,
  useAccessSwitch,
} from "./device-access-switches.js";
import { deviceNotificationsOn, setDeviceNotifications } from "./device-preferences.js";
import { IphoneWifiRow } from "./iphone-wifi-row.js";
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
  const enrollmentId = pendingEnrollmentId(machine);
  if (enrollmentId)
    return <PendingDeviceDetail enrollmentId={enrollmentId} key={machine.id} machine={machine} />;
  return <DeviceDetail key={machine.id} machine={machine} />;
}

/** Nothing has redeemed its setup token yet, so only the token can be retired. */
function PendingDeviceDetail({
  enrollmentId,
  machine,
}: {
  readonly enrollmentId: string;
  readonly machine: MachineSummary;
}) {
  const { hostClient, openMobileNavigation } = useShell();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      const outcome = await act(
        hostClient,
        { label: "cancel this setup", done: "cancelled", happened: "this setup was cancelled" },
        () => cancelDeviceSetup(hostClient, enrollmentId),
      );
      if (outcome === "joined") {
        setConfirming(false);
        setError(`${machine.name} already joined. Remove it from Devices instead.`);
        return;
      }
      void navigate(devicesRoute);
    } catch (reason) {
      setConfirming(false);
      setError(failureWords(reason));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="page device-page">
      <PageTopbar onOpenNavigation={openMobileNavigation} title={machine.name} />
      <div className="page__content device-page__content">
        <DevicesBackLink />
        <header className="computer-header">
          <DeviceArt art={computerGlyph(machine)} />
          <div className="computer-header__body">
            <h1 className="computer-header__name">
              <span className="device-page__name">{machine.name}</span>
            </h1>
            <p className="computer-header__facts">
              <span className="computer-status">
                <span aria-hidden className="computer-status__dot computer-status__dot--waiting" />
                {deviceStatusLine(machine)}
              </span>
            </p>
          </div>
        </header>
        <p className="settings-footnote">
          It joins once its setup finishes there. You can rename it and choose what your agent can
          use after that.
        </p>
        {machine.ownership === "mine" ? (
          <section aria-label="Cancel setup" className="device-remove">
            <button
              className="btn btn--danger"
              disabled={cancelling}
              onClick={() => setConfirming(true)}
              type="button"
            >
              Cancel setup
            </button>
          </section>
        ) : null}
        <SettingsError message={error} />
      </div>
      {confirming ? (
        <Dialog
          footer={
            <>
              <button
                className="btn btn--ghost"
                disabled={cancelling}
                onClick={() => setConfirming(false)}
                type="button"
              >
                Keep it
              </button>
              <button
                className="btn btn--danger"
                disabled={cancelling}
                onClick={() => void cancel()}
                type="button"
              >
                {cancelling ? "Cancelling…" : "Cancel setup"}
              </button>
            </>
          }
          labelledBy={titleId}
          onClose={() => setConfirming(false)}
          title={<span id={titleId}>{`Cancel setting up ${machine.name}?`}</span>}
        >
          <p>Its sign-in or connection command stops working. You can add it again any time.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

export function deviceRemovalCopy(input: {
  readonly machine: Pick<
    MachineSummary,
    "id" | "name" | "status" | "selfRunnerId" | "capabilities"
  >;
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
      profiles ?? "Browser profiles kept on it are deleted.",
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
  const phone = Boolean(deviceMachine(machine).phoneDisplay);
  const screenMac = phoneScreenMac(machine);
  const screen = phoneScreenStatus(machine);
  const screenMacHere = desktopBridge !== null && screenMac?.runnerId === hereId;
  const deploymentId = DeploymentIdSchema.safeParse(snapshot.deploymentId);
  const workspace = useOptionalWorkspace();
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
  const [confirming, setConfirming] = useState<"remove" | "disconnect" | null>(null);
  const [removing, setRemoving] = useState(false);
  const [permissionReview, setPermissionReview] = useState(false);
  const [pluggingIn, setPluggingIn] = useState(false);
  const [settingUpAgain, setSettingUpAgain] = useState<ExistingIphoneTarget | null>(null);
  const removalTitleId = useId();
  useEffect(() => setName(machine.name), [machine.name]);

  const onThisMac = fullAccessOnThisMac({
    hostsDeployment: home,
    hostsDeploymentOnThisComputer: desktopDeployment?.onThisComputer === true,
    inDesktopApp: desktopBridge !== null,
    lentByThisDesktop: here && !home,
  });
  const switches = deviceSwitches(machine, snapshot.devicesAvailable === true);
  const removal = screenMac
    ? phoneScreenRemovalCopy(machine.name, screenMac.name)
    : {
        label: leavesHere ? "Sign out and remove this Mac" : "Remove",
        ...deviceRemovalCopy({
          machine,
          thisDevice: leavesHere,
          profiles: snapshot.browserProfiles,
        }),
      };
  const disconnect = screenMac?.attached
    ? phoneScreenDisconnectCopy(machine.name, screenMac.name)
    : null;
  const confirmation = confirming === "disconnect" ? disconnect : confirming ? removal : null;
  const statusTone =
    screen?.tone ??
    (machine.status === "online" ? "online" : machine.status === "offline" ? "offline" : "waiting");
  const appsSwitch = switches.find((item) => item.capability === "apps");
  const driverGeneration = deviceMachine(machine).phoneDisplay?.driver?.generation;
  // A disconnected iPhone can be set up again on any of the person's Macs; one
  // that needs setup is fixed on the Mac that drives it, without detaching it.
  const fixSetup =
    screenMac &&
    screen?.needsSetup &&
    (!screenMac.attached || screenMacHere) &&
    driverGeneration !== undefined &&
    hostClient.iphoneSetup &&
    deploymentId.success
      ? () =>
          setSettingUpAgain({
            kind: "existing",
            deviceId: DeviceIdSchema.parse(machine.id),
            expectedGeneration: driverGeneration,
          })
      : null;

  const screenTab = TabTargetSchema.safeParse({ kind: "phone", computerId: machine.id });
  function openScreen() {
    if (!workspace || !screenTab.success) return;
    const show = workspace.nav.beginPlaceOperation();
    void act(
      hostClient,
      { label: "open this screen", done: "opened", happened: "this screen opened" },
      () => hostClient.openTab(screenTab.data),
    )
      .then((tab) => show({ kind: "tab", tabId: tab.tabId }))
      .catch((reason: unknown) => setError(failureWords(reason)));
  }

  async function disconnectScreen() {
    const generation = deviceMachine(machine).phoneDisplay?.driver?.generation;
    if (generation === undefined) return;
    setRemoving(true);
    setError(null);
    try {
      await act(
        hostClient,
        { label: "remove this screen", done: "removed", happened: "this screen was removed" },
        () =>
          hostClient.detachIphoneScreen({ deviceId: machine.id, expectedGeneration: generation }),
      );
      await hostClient.refresh();
      setConfirming(null);
    } catch (reason) {
      setError(failureWords(reason));
      setConfirming(null);
    } finally {
      setRemoving(false);
    }
  }

  async function saveName() {
    const next = name.trim();
    if (!next || next === machine.name) return;
    setSavingName(true);
    setError(null);
    try {
      const result = await act(
        hostClient,
        { label: "rename this device", done: "renamed", happened: "this device was renamed" },
        () =>
          hostClient.dispatch({
            idempotencyKey: mutationIdempotencyKey("device-rename"),
            machineId: machine.id,
            name: next,
            type: "machine.rename",
          }),
      );
      if (result.type !== "machine.rename") {
        setError("The rename didn’t finish.");
        return;
      }
      await hostClient.refresh();
      setRenaming(false);
    } catch (reason) {
      setError(failureWords(reason));
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
        await act(
          null,
          { label: "leave on this Mac", done: "left", happened: "this Mac left" },
          () => device?.leave(),
        );
        return;
      }
      const result = await act(
        hostClient,
        { label: "remove this device", done: "removed", happened: "this device was removed" },
        () =>
          hostClient.dispatch({
            idempotencyKey: mutationIdempotencyKey(`device-remove:${machine.id}`),
            machineId: machine.id,
            type: "machine.revoke",
          }),
      );
      if (result.type !== "machine.revoke") {
        setError("Removing it didn’t finish.");
        return;
      }
      await hostClient.refresh();
      void navigate(devicesRoute);
    } catch (reason) {
      setError(failureWords(reason));
      setConfirming(null);
    } finally {
      setRemoving(false);
    }
  }

  const appsEditor = apps.data ? (
    phone ? (
      <PhoneSection
        appsSwitch={
          screenMac && appsSwitch ? (
            <DeviceAccessSwitchRow
              item={appsSwitch}
              machine={machine}
              onSet={(capability, on) => void access.set(capability, on)}
              pending={access.pending}
              thisDevice={false}
            />
          ) : null
        }
        connections={apps.data.connections}
        definitions={apps.data.definitions}
        hostClient={hostClient}
        hostConnected={canRespondToRequests(snapshot)}
        machine={machine}
        onChanged={async () => {
          await apps.reload();
          await hostClient.refresh();
        }}
        onOpenScreen={workspace && screenTab.success ? openScreen : null}
        onPlugIn={() => setPluggingIn(true)}
        onFixSetup={fixSetup}
        wifiRow={
          screenMacHere && screenMac?.attached && hostClient.iphoneSetup && deploymentId.success ? (
            <IphoneWifiRow
              deploymentId={deploymentId.data}
              deploymentName={deploymentName}
              deviceId={machine.id}
              macName={screenMac.name}
              port={hostClient.iphoneSetup}
              revision={snapshot.machineRevision}
            />
          ) : null
        }
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
        setupRequests={apps.data.setupRequests.filter(
          (request) => computerTargetId(request) === machine.id,
        )}
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
                className={`computer-status${statusTone === "offline" ? " device-page__away" : ""}`}
              >
                <span
                  aria-hidden
                  className={`computer-status__dot computer-status__dot--${statusTone}`}
                />
                {deviceStatusLine(machine)}
              </span>
              {here ? <HerePin /> : null}
            </p>
          </div>
        </header>

        {screenMac ? (
          <>
            {appsEditor}
            {access.notice ? <DeviceAccessNotice notice={access.notice} /> : null}
          </>
        ) : (
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
        )}
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
            {disconnect ? (
              <button
                className="btn"
                disabled={removing}
                onClick={() => setConfirming("disconnect")}
                type="button"
              >
                {disconnect.label}
              </button>
            ) : null}
            <button
              className="btn btn--danger"
              disabled={removing}
              onClick={() => setConfirming("remove")}
              type="button"
            >
              {removal.label}
            </button>
          </section>
        ) : null}
        <SettingsError message={error} />
      </div>
      {confirmation ? (
        <Dialog
          footer={
            <>
              <button
                className="btn btn--ghost"
                disabled={removing}
                onClick={() => setConfirming(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn--danger"
                disabled={removing}
                onClick={() => void (confirming === "disconnect" ? disconnectScreen() : remove())}
                type="button"
              >
                {removing
                  ? confirming === "disconnect"
                    ? "Disconnecting…"
                    : "Removing…"
                  : confirmation.confirm}
              </button>
            </>
          }
          labelledBy={removalTitleId}
          onClose={() => setConfirming(null)}
          title={<span id={removalTitleId}>{confirmation.title}</span>}
        >
          <p>{confirmation.body}</p>
        </Dialog>
      ) : null}
      {settingUpAgain && hostClient.iphoneSetup && deploymentId.success ? (
        <AddIphoneDialog
          client={hostClient}
          deploymentId={deploymentId.data}
          deploymentName={deploymentName}
          existing={settingUpAgain}
          onClose={() => setSettingUpAgain(null)}
          port={hostClient.iphoneSetup}
        />
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
          onError={setError}
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
