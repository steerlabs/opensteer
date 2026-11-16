import type {
  ComputerViewNativeResult,
  DeviceDriverTarget,
  DeviceScreenDriverAssignment,
  HostIntegrationsCancel,
  HostIntegrationsComputerUse,
  HostIntegrationsComputerUseStopRecorded,
  HostIntegrationsComputerView,
  HostToIntegrationsModuleMessage,
  IntegrationsModuleEvent,
  IphoneScreenActResult,
  IphoneScreenDispatchActParams,
  IphoneScreenObservationResult,
  PhoneDisplayCloseParams,
  PhoneDisplayDispatchObserveParams,
  PhoneDisplayInstalledAppsParams,
  PhoneDisplayInstalledAppsResult,
  RunnerAuxiliaryFrameFence,
} from "@opensteer/protocol";
import type { RunnerTransportPolicy } from "@opensteer/runner-client";

type ScreenFrame<Frame> = Frame extends object
  ? Omit<Frame, keyof RunnerAuxiliaryFrameFence | "module"> & DeviceDriverTarget
  : never;

export type PhoneScreenDriverEvent = ScreenFrame<
  Extract<
    IntegrationsModuleEvent,
    {
      type:
        | "runner.integrations.device-status"
        | "runner.integrations.computer-use-event"
        | "runner.integrations.display.state"
        | "runner.integrations.display.input-result"
        | "runner.integrations.display.editing"
        | "runner.integrations.display.clipboard"
        | "runner.integrations.display.power-result"
        | "runner.integrations.display.source-ended";
    }
  >
>;
export type PhoneScreenDisplayFrame = ScreenFrame<
  Extract<
    HostToIntegrationsModuleMessage,
    {
      type:
        | "host.integrations.display.start"
        | "host.integrations.display.demand"
        | "host.integrations.display.stop"
        | "host.integrations.display.refresh"
        | "host.integrations.display.input"
        | "host.integrations.display.input-reset"
        | "host.integrations.display.power";
    }
  >
>;
export type PhoneScreenOwnerView = ScreenFrame<HostIntegrationsComputerView>;
export type PhoneScreenCancel = ScreenFrame<HostIntegrationsCancel>;
export type PhoneScreenStopRecorded = ScreenFrame<HostIntegrationsComputerUseStopRecorded>;
export type PhoneScreenContext = DeviceDriverTarget &
  Pick<
    HostIntegrationsComputerUse,
    "requestId" | "sessionId" | "runId" | "access" | "threadTitle"
  > & {
    readonly deadline: number;
    readonly signal: AbortSignal;
  };

export interface PhoneScreenDriver {
  connect(options: {
    readonly fence: RunnerAuxiliaryFrameFence;
    readonly emit: (event: PhoneScreenDriverEvent) => Promise<void>;
    readonly transport?: RunnerTransportPolicy;
  }): PhoneScreenDriverConnection;
  /** Invalidate every connection and finish releasing the driver's resources. */
  shutdown(): Promise<void> | void;
}

/** One integrations stream; old connections must never publish through a new connection's sink. */
export interface PhoneScreenDriverConnection {
  /** Invalidate omitted/replaced generations synchronously, including native work and data streams. */
  replaceAssignments(assignments: readonly DeviceScreenDriverAssignment[]): void;
  observe(
    context: PhoneScreenContext,
    params: PhoneDisplayDispatchObserveParams,
  ): Promise<IphoneScreenObservationResult>;
  act(
    context: PhoneScreenContext,
    params: IphoneScreenDispatchActParams,
  ): Promise<IphoneScreenActResult>;
  close(
    context: PhoneScreenContext,
    params: PhoneDisplayCloseParams,
  ): Promise<PhoneDisplayCloseParams>;
  installedApps(
    context: PhoneScreenContext,
    params: PhoneDisplayInstalledAppsParams,
  ): Promise<PhoneDisplayInstalledAppsResult>;
  ownerView(
    frame: PhoneScreenOwnerView,
    signal: AbortSignal,
    receivedAt: number,
  ): Promise<ComputerViewNativeResult>;
  display(frame: PhoneScreenDisplayFrame): void;
  cancel(frame: PhoneScreenCancel): void;
  stopRecorded(frame: PhoneScreenStopRecorded): void;
  /** Withdraw all authority synchronously; release every session and data attachment owned here. */
  detach(): void;
}
