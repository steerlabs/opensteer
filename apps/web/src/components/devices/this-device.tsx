import { deploymentPolicy } from "@opensteer/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DeviceInitialAccess, MachineSummary } from "@opensteer/protocol";
import type {
  DesktopDeploymentSummary,
  DesktopDeviceMembership,
  DesktopLocalExecutionStatus,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";
import {
  applyDeviceAccess,
  deviceMembership,
  hostsDeployment,
  type DeviceMembership,
} from "@opensteer/client/computers";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { setUpThisDevice, type DeviceSetupStage, type FinishSetupCause } from "./device-setup.js";
import {
  deferredSetup,
  rememberDeferredSetup,
  rememberSetupStep,
  rememberedSetupStep,
  setDeviceNotifications,
  type DeviceSetupStep,
} from "./device-preferences.js";

/** What another computer offers when it joins; the Host fixes the exact ceiling. */
export const localEnrollmentModules = ["browser", "integrations", "messaging", "shell"] as const;

export interface DeviceSetupChoice {
  readonly name: string;
  readonly access: DeviceInitialAccess;
  readonly notifications: boolean;
}

export interface ThisDevice {
  readonly deploymentId: string;
  readonly hosting: boolean;
  readonly membership: DeviceMembership;
  /** This Mac's own device row, once the Host lists it. */
  readonly machine: MachineSummary | null;
  readonly machineId: string | null;
  readonly computerName: string;
  readonly homeName: string;
  readonly opensteerName: string;
  readonly devicesAvailable: boolean;
  /** The full-window setup step on screen, or null while the workspace shows. */
  readonly step: DeviceSetupStep | null;
  readonly stage: DeviceSetupStage | null;
  readonly cause: FinishSetupCause | null;
  readonly choice: DeviceSetupChoice | null;
  readonly openSetup: () => void;
  readonly goTo: (step: DeviceSetupStep | null) => void;
  readonly setUp: (choice: DeviceSetupChoice) => Promise<void>;
  readonly retryBind: () => Promise<void>;
  /** Sign out and remove this Mac: the one leave, which desktop main delivers. */
  readonly leave: () => Promise<void>;
}

const ThisDeviceContext = createContext<ThisDevice | null>(null);
export const ThisDeviceProvider = ThisDeviceContext.Provider;

/** This Mac as a device of the Opensteer on screen; null in a browser and on team servers. */
export function useThisDevice(): ThisDevice | null {
  return useContext(ThisDeviceContext);
}

/** The membership record desktop main reports, or what an older desktop's slot implies. */
export function membershipRecord(
  status: DesktopLocalExecutionStatus | null,
): DesktopDeviceMembership | null {
  if (!status) return null;
  if (status.membership) return { ...status.membership, enrolled: status.runner.enrolled };
  return {
    enrolled: status.runner.enrolled,
    generation: 0,
    runnerId: status.runner.runnerId,
    state: status.runner.enrolled ? "active" : "none",
  };
}

export function useThisDeviceLifecycle(input: {
  readonly bridge: OpensteerDesktopBridge | null;
  readonly deployment: DesktopDeploymentSummary | null;
  readonly hostClient: HostClient;
  readonly hostingRunnerId: string | null;
  readonly localStatus: DesktopLocalExecutionStatus | null;
  readonly onLocalStatus: (status: DesktopLocalExecutionStatus) => void;
  readonly snapshot: HostSnapshot;
}): ThisDevice | null {
  const { bridge, deployment, hostClient, localStatus, onLocalStatus, snapshot } = input;
  const deploymentId = deployment?.id ?? null;
  const hosting = deployment?.onThisComputer === true;
  const applicable =
    bridge !== null &&
    deployment !== null &&
    deploymentPolicy({ kind: deployment.kind }).services.personal &&
    (hosting || (localStatus !== null && localStatus.platform !== "windows"));
  const devicesAvailable = snapshot.devicesAvailable === true;
  const record = membershipRecord(localStatus);
  const machineId = hosting
    ? input.hostingRunnerId
    : (record?.runnerId ?? localStatus?.runner.runnerId ?? null);
  const machine = snapshot.machines.find((entry) => entry.id === machineId) ?? null;
  const home = snapshot.machines.find(hostsDeployment) ?? null;
  const opensteerName = snapshot.identityConfig?.deployment.name ?? deployment?.name ?? "Opensteer";
  const homeName = home?.name ?? opensteerName;

  const [step, setStep] = useState<DeviceSetupStep | null>(null);
  const [stage, setStage] = useState<DeviceSetupStage | null>(null);
  const [cause, setCause] = useState<FinishSetupCause | null>(null);
  const [choice, setChoice] = useState<DeviceSetupChoice | null>(null);
  const opened = useRef<string | null>(null);

  const membership = deviceMembership({
    applicable,
    hosting,
    authenticated: snapshot.session === "authenticated",
    membership: record,
    settingUp: stage !== null,
    finishSetupReason: cause ? cause.kind : null,
  });

  const goTo = useCallback(
    (next: DeviceSetupStep | null) => {
      setStep(next);
      if (deploymentId) rememberSetupStep(deploymentId, next);
    },
    [deploymentId],
  );

  // Opens setup once per Deployment: on a Mac that isn't a device yet, or
  // where an unfinished setup was left. A setup that couldn't finish opens
  // the workspace with its bar instead.
  useEffect(() => {
    if (!applicable || hosting || deploymentId === null || opened.current === deploymentId) return;
    if (record === null) return;
    opened.current = deploymentId;
    const deferred = deferredSetup(deploymentId);
    if (deferred === "use-from-anywhere") setCause({ kind: "use-from-anywhere", homeName });
    else if (deferred) setCause({ kind: deferred, detail: "" });
    const remembered = rememberedSetupStep(deploymentId);
    if (membership.state === "needs-setup" && !deferred) setStep("choose");
    else if (membership.state === "ready" && remembered && remembered !== "choose")
      setStep(remembered);
  }, [applicable, deploymentId, homeName, hosting, membership.state, record]);

  const bindThisDevice = useMemo(
    () => (bridge && deploymentId ? () => bridge.bindDeviceSession({ deploymentId }) : null),
    [bridge, deploymentId],
  );

  // Every new sign-in on an existing device binds that session to it.
  const boundFor = useRef<string | null>(null);
  if (snapshot.session !== "authenticated") boundFor.current = null;
  useEffect(() => {
    if (!bindThisDevice || !devicesAvailable || hosting || membership.state !== "ready") return;
    if (!machineId || boundFor.current === machineId) return;
    boundFor.current = machineId;
    void bindThisDevice().then(
      () => {
        if (deploymentId && deferredSetup(deploymentId) === "bind") {
          rememberDeferredSetup(deploymentId, null);
          setCause(null);
        }
      },
      (reason: unknown) => {
        if (deploymentId) rememberDeferredSetup(deploymentId, "bind");
        setCause({
          kind: "bind",
          detail: reason instanceof Error ? reason.message : "",
        });
      },
    );
  }, [bindThisDevice, deploymentId, devicesAvailable, hosting, machineId, membership.state]);

  const setUp = useCallback(
    async (next: DeviceSetupChoice) => {
      if (!bridge || !deploymentId) return;
      setChoice(next);
      setCause(null);
      setDeviceNotifications(deploymentId, next.notifications);
      const result = await setUpThisDevice(
        {
          remoteAccessMode: async () =>
            unwrapRpcResult(await hostClient.rpc["personal.remoteAccess.get"]({})).access.mode,
          prepare: (name) =>
            bridge.prepareDeviceSetup({ deploymentId, runnerName: name, runAgents: false }),
          mint: async ({ name, access, preparedIdentity }) => {
            const enrollment = await hostClient.dispatch({
              allowedModules: [...localEnrollmentModules],
              idempotencyKey: mutationIdempotencyKey("local-runner"),
              name,
              ...(access ? { access } : {}),
              ...(preparedIdentity ? { preparedIdentity } : {}),
              type: "runner.enrollment.createLocal",
            });
            if (enrollment.type !== "runner.enrollment.createLocal")
              throw new Error("This Mac didn’t finish joining.");
            return { token: enrollment.token };
          },
          setUp: async ({ token, name }) => {
            const status = await bridge.setUpDevice({
              deploymentId,
              enrollmentToken: token,
              runAgents: false,
              runnerName: name,
            });
            onLocalStatus(status);
            await hostClient.refresh();
            return { runnerId: status.membership?.runnerId ?? status.runner.runnerId };
          },
          applyAccess: async (runnerId, access) => {
            await applyDeviceAccess(hostClient, runnerId, access);
          },
          bind: async (runnerId) => {
            if (!bindThisDevice) return;
            boundFor.current = runnerId;
            await bindThisDevice();
          },
        },
        { name: next.name, access: next.access, devicesAvailable, homeName },
        setStage,
      );
      setStage(null);
      if (!result.ok) {
        rememberDeferredSetup(deploymentId, result.cause.kind);
        setCause(result.cause);
        goTo(null);
        return;
      }
      rememberDeferredSetup(deploymentId, null);
      if (next.notifications) void bridge.testNotification().catch(() => undefined);
      const macos = localStatus?.platform === "macos" && (next.access.apps || next.access.files);
      goTo(macos ? "macos" : "ready");
    },
    [
      bindThisDevice,
      bridge,
      deploymentId,
      devicesAvailable,
      goTo,
      homeName,
      hostClient,
      localStatus?.platform,
      onLocalStatus,
    ],
  );

  const retryBind = useCallback(async () => {
    if (record?.enrolled === false) {
      goTo("choose");
      return;
    }
    if (!bindThisDevice || !deploymentId) return;
    try {
      await bindThisDevice();
      rememberDeferredSetup(deploymentId, null);
      setCause(null);
    } catch (reason) {
      setCause({ kind: "bind", detail: reason instanceof Error ? reason.message : "" });
    }
  }, [bindThisDevice, deploymentId, record?.enrolled, goTo]);

  const leave = useCallback(async () => {
    if (!bridge || !deploymentId) return;
    rememberSetupStep(deploymentId, null);
    rememberDeferredSetup(deploymentId, null);
    await bridge.leaveDeployment({ deploymentId });
  }, [bridge, deploymentId]);

  const openSetup = useCallback(() => {
    if (!deploymentId) return;
    rememberDeferredSetup(deploymentId, null);
    setCause(null);
    goTo("choose");
  }, [deploymentId, goTo]);

  if (!applicable || deploymentId === null) return null;
  return {
    deploymentId,
    hosting,
    membership,
    machine,
    machineId,
    computerName: localStatus?.computerName ?? machine?.name ?? "This Mac",
    homeName,
    opensteerName,
    devicesAvailable,
    step,
    stage,
    cause:
      record?.state === "active" &&
      record.enrolled === false &&
      !cause &&
      membership.state === "finish-setup"
        ? { kind: "failed", detail: membership.reason }
        : cause,
    choice,
    openSetup,
    goTo,
    setUp,
    retryBind,
    leave,
  };
}
