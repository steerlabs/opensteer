import { randomUUID } from "node:crypto";
import {
  IphoneScreenAttachCommandSchema,
  IphoneScreenAttachResultSchema,
  type IphoneScreenAttachResult,
  type IphoneScreenAttachCommand,
} from "@opensteer/protocol";
import {
  DesktopIphoneSetupReasonSchema,
  DesktopIphoneSetupStatusSchema,
  type DesktopIphoneSetupReason,
  type DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";
import type { IphoneRunnerOwner } from "@opensteer/protocol/iphone-bridge";
import { IphoneService } from "./iphone-service.js";
import { IphoneServiceError, type IphoneMapping } from "./iphone-store.js";

type Transaction = {
  owner: IphoneRunnerOwner;
  target?: IphoneScreenAttachCommand["target"] | undefined;
  state: DesktopIphoneSetupStatus;
  record?: IphoneMapping;
  candidates: Map<string, string>;
  controller: AbortController;
  paired: boolean;
  busy: boolean;
  listeners: Set<(state: DesktopIphoneSetupStatus) => void>;
};
export class IphoneSetup {
  readonly #service: IphoneService;
  readonly #transactions = new Map<string, Transaction>();
  constructor(service: IphoneService) {
    this.#service = service;
    service.onSlotInvalidated((deploymentId) => {
      for (const [id, transaction] of this.#transactions)
        if (transaction.owner.deploymentId === deploymentId) {
          this.#transactions.delete(id);
          transaction.controller.abort();
          transaction.candidates.clear();
          transaction.listeners.clear();
        }
    });
  }
  async begin(
    owner: IphoneRunnerOwner,
    target?: IphoneScreenAttachCommand["target"],
  ): Promise<DesktopIphoneSetupStatus> {
    for (const [id, transaction] of this.#transactions)
      if (transaction.owner.deploymentId === owner.deploymentId) await this.cancel(id);
    const pending = await this.#service.pending(owner);
    const setupId = pending?.setupId ?? randomUUID();
    const resumed = pending?.attachTarget ?? target;
    const transaction: Transaction = {
      owner,
      target: resumed,
      state: {
        setupId,
        deploymentId: owner.deploymentId as DesktopIphoneSetupStatus["deploymentId"],
        step: pending
          ? pending.phase === "bound"
            ? "confirm"
            : pending.phase === "pending-attach"
              ? "attach"
              : "trust"
          : "choose",
        reason: null,
        recoverable: true,
        personAction: "choose-phone",
        candidates: [],
        attachCommand: null,
        target: resumed ?? null,
        deviceId: pending?.deviceId ?? null,
        driverGeneration: pending?.driverGeneration ?? null,
        wifiEnabled: pending?.wifiEnabledByOpensteer ?? false,
      },
      candidates: new Map(),
      controller: new AbortController(),
      paired: false,
      busy: false,
      listeners: new Set(),
      ...(pending ? { record: pending } : {}),
    };
    this.#transactions.set(setupId, transaction);
    try {
      await this.#service.discover();
      this.#candidates(transaction);
    } catch (error) {
      this.#failure(transaction, error);
    }
    if (pending?.phase === "pending-attach") this.#command(transaction);
    return this.#publish(transaction);
  }
  async choose(setupId: string, candidateId: string): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (t.state.step !== "choose" || t.busy) throw new IphoneServiceError("candidate-gone");
    const localId = t.candidates.get(candidateId);
    if (!localId) throw new IphoneServiceError("candidate-gone");
    t.busy = true;
    try {
      t.record = await this.#service.reserve(
        t.owner,
        localId,
        setupId,
        t.controller.signal,
        t.target ?? null,
      );
      this.#active(t);
      t.state.step = "trust";
      t.state.reason = null;
      t.state.personAction = "unlock-and-trust";
    } catch (error) {
      this.#failure(t, error);
    } finally {
      t.busy = false;
      if (t.controller.signal.aborted && t.record) await this.#service.cancelSetup(t.record);
    }
    return this.#publish(t);
  }
  async advance(
    setupId: string,
    step: "trust" | "developer-mode" | "prepare" | "observe" | "attach",
    name?: string,
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (t.busy || !t.record || t.state.step !== step) throw new IphoneServiceError("no-session");
    t.busy = true;
    try {
      this.#active(t);
      const signal = t.controller.signal;
      if (step === "trust") {
        let inspection;
        try {
          inspection = await this.#service.inspect(t.record, signal);
        } catch (error) {
          if (
            !t.paired &&
            error instanceof IphoneServiceError &&
            ["trust-required", "trust-pending", "trust-denied", "pairing-revoked"].includes(
              error.code,
            )
          ) {
            await this.#service.pair(t.record, signal);
            t.paired = true;
            inspection = await this.#service.inspect(t.record, signal);
          } else throw error;
        }
        if (inspection.pairing !== "paired") {
          if (!t.paired) {
            await this.#service.pair(t.record, signal);
            t.paired = true;
          }
          throw new IphoneServiceError("trust-pending");
        }
        if (!inspection.model.startsWith("iPhone"))
          throw new IphoneServiceError("unsupported-device");
        if (inspection.osVersion.split(".")[0] !== "27")
          throw new IphoneServiceError("unsupported-ios");
        t.state.step = "developer-mode";
      } else if (step === "developer-mode") {
        const inspection = await this.#service.inspect(t.record, signal);
        if (inspection.developerMode !== "enabled")
          throw new IphoneServiceError(
            inspection.developerMode === "disabled"
              ? "developer-mode-required"
              : "developer-mode-status-unknown",
          );
        t.state.step = "prepare";
      } else if (step === "prepare") {
        await this.#service.prepare(t.record, signal);
        t.state.step = "observe";
      } else if (step === "observe") {
        await this.#service.firstObserve(t.record, signal);
        t.state.step = "wifi";
      } else {
        if (t.record.phase === "pending-attach") {
          if (
            name !== undefined &&
            t.record.attachTarget?.kind === "new" &&
            t.record.attachTarget.name !== name.trim()
          )
            throw new IphoneServiceError("attach-conflict");
          this.#command(t);
        } else {
          const target =
            t.target?.kind === "existing"
              ? t.target
              : {
                  kind: "new" as const,
                  name: name ?? (t.target?.kind === "new" ? t.target.name : t.record.userLabel),
                };
          const command = IphoneScreenAttachCommandSchema.parse({
            type: "iphone.screen.attach",
            idempotencyKey: t.record.setupId,
            driverRunnerId: t.record.runnerId,
            target,
          });
          const record: IphoneMapping = {
            ...t.record,
            phase: "pending-attach",
            attachTarget: command.target,
            userLabel: command.target.kind === "new" ? command.target.name : t.record.userLabel,
          };
          await this.#service.save(record);
          t.record = record;
          this.#active(t);
          this.#command(t);
        }
      }
      this.#active(t);
      t.state.reason = null;
      t.state.personAction = t.state.step === "wifi" ? "choose-wifi" : "continue";
    } catch (error) {
      this.#failure(t, error);
    } finally {
      t.busy = false;
    }
    return this.#publish(t);
  }
  async wifi(
    setupId: string,
    action: "enable" | "disable" | "pair" | "skip",
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (t.busy || !t.record || t.state.step !== "wifi") throw new IphoneServiceError("no-session");
    t.busy = true;
    try {
      t.record = await this.#service.setupWifi(
        t.record,
        action === "skip" ? "disable" : action,
        t.controller.signal,
      );
      t.state.wifiEnabled = t.record.wifiEnabledByOpensteer;
      this.#active(t);
      t.state.step = "attach";
      t.state.reason = null;
      t.state.personAction = "continue";
    } catch (error) {
      this.#failure(t, error);
    } finally {
      t.busy = false;
    }
    return this.#publish(t);
  }
  async complete(
    setupId: string,
    value: IphoneScreenAttachResult,
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (!t.record || t.record.phase !== "pending-attach" || t.busy)
      throw new IphoneServiceError("no-session");
    const result = IphoneScreenAttachResultSchema.parse(value);
    t.busy = true;
    try {
      this.#active(t);
      const record = {
        ...t.record,
        deviceId: result.deviceId,
        driverGeneration: result.generation,
        phase: "bound" as const,
      };
      await this.#service.finishSetup(t.record);
      await this.#service.save(record);
      t.record = record;
      t.state = {
        ...t.state,
        attachCommand: null,
        deviceId: result.deviceId,
        driverGeneration: result.generation,
        step: "confirm",
        reason: "assignment-pending",
        personAction: "continue",
      };
    } catch {
      this.#failure(t, new IphoneServiceError("local-mapping-save-failed"));
    } finally {
      t.busy = false;
    }
    return this.status(setupId);
  }
  async failed(
    setupId: string,
    reason: DesktopIphoneSetupReason,
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    t.state.reason = DesktopIphoneSetupReasonSchema.parse(reason);
    t.state.personAction = "retry";
    return this.#publish(t);
  }
  async status(setupId: string): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (t.state.step === "choose") this.#candidates(t);
    if (t.state.step === "confirm") {
      const confirmed = (await this.#service.targets(t.owner.deploymentId)).some(
        (target) =>
          target.deviceId === t.record?.deviceId &&
          target.driverGeneration === t.record?.driverGeneration,
      );
      if (confirmed) {
        if (t.record && !t.record.setupComplete) {
          const completed = { ...t.record, setupComplete: true };
          await this.#service.save(completed);
          t.record = completed;
        }
        t.state.step = "done";
        t.state.reason = null;
        t.state.personAction = "none";
      }
    }
    return this.#publish(t);
  }
  subscribe(setupId: string, listener: (state: DesktopIphoneSetupStatus) => void): () => void {
    const t = this.#get(setupId);
    t.listeners.add(listener);
    return () => {
      t.listeners.delete(listener);
    };
  }
  async cancel(setupId: string): Promise<void> {
    const t = this.#transactions.get(setupId);
    if (!t) return;
    this.#transactions.delete(setupId);
    t.controller.abort();
    t.candidates.clear();
    t.listeners.clear();
    if (t.record) await this.#service.cancelSetup(t.record);
  }
  async stopForSlot(deploymentId: string): Promise<void> {
    for (const [id, t] of this.#transactions)
      if (t.owner.deploymentId === deploymentId) await this.cancel(id);
  }
  async stop(): Promise<void> {
    await Promise.all([...this.#transactions.keys()].map((id) => this.cancel(id)));
  }
  #get(id: string): Transaction {
    const t = this.#transactions.get(id);
    if (!t) throw new IphoneServiceError("cancelled");
    return t;
  }
  #active(t: Transaction): void {
    if (t.controller.signal.aborted || this.#transactions.get(t.state.setupId) !== t)
      throw new IphoneServiceError("cancelled");
  }
  #command(t: Transaction): void {
    if (!t.record) return;
    t.state.attachCommand = IphoneScreenAttachCommandSchema.parse({
      type: "iphone.screen.attach",
      idempotencyKey: t.record.setupId,
      driverRunnerId: t.record.runnerId,
      target: t.record.attachTarget ?? { kind: "new", name: t.record.userLabel },
    });
  }
  #candidates(t: Transaction): void {
    const previous = new Map([...t.candidates].map(([id, local]) => [local, id]));
    t.candidates.clear();
    t.state.candidates = this.#service
      .candidates()
      .filter((c) => c.transport === "usb")
      .map((c) => {
        const candidateId = previous.get(c.localPhoneId) ?? randomUUID();
        t.candidates.set(candidateId, c.localPhoneId);
        const clean = (value: string) => value.replace(/\p{Cc}/gu, "").slice(0, 160);
        return {
          candidateId,
          name: clean(c.name),
          model: clean(c.model),
          osVersion: clean(c.osVersion),
          reason: c.reason,
        };
      });
    if (t.state.candidates.length === 0) t.state.reason = "no-phone";
  }
  #failure(t: Transaction, error: unknown): void {
    const reason = DesktopIphoneSetupReasonSchema.safeParse(
      error instanceof IphoneServiceError ? error.code : "native-service-failed",
    );
    t.state.reason = reason.success ? reason.data : "native-service-failed";
    t.state.personAction =
      t.state.reason === "developer-image-missing"
        ? "install-developer-image"
        : t.state.reason === "developer-mode-required"
          ? "enable-developer-mode"
          : ["trust-required", "trust-pending", "phone-locked"].includes(t.state.reason)
            ? "unlock-and-trust"
            : "retry";
  }
  #publish(t: Transaction): DesktopIphoneSetupStatus {
    const result = DesktopIphoneSetupStatusSchema.parse(t.state);
    for (const listener of t.listeners) listener(result);
    return result;
  }
}
