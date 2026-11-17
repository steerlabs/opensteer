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
import { iphoneMacSupport, type IphoneMacSupport } from "./mac-support.js";

type Transaction = {
  owner: IphoneRunnerOwner;
  state: DesktopIphoneSetupStatus;
  record?: IphoneMapping;
  candidates: Map<string, string>;
  controller: AbortController;
  listeners: Set<(state: DesktopIphoneSetupStatus) => void>;
  cleanups: (() => void)[];
  macWatch?: () => void;
  xcodeApp?: string;
  xcodeRequested?: boolean;
  revealed?: string;
  wifiChoice?: "wifi" | "usb-only";
  result?: IphoneScreenAttachResult;
  work?: Promise<void>;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
const phoneWaits = new Set<DesktopIphoneSetupReason>([
  "trust-required",
  "trust-pending",
  "phone-locked",
  "developer-mode-required",
  "developer-mode-status-unknown",
  "phone-disconnected",
  "candidate-gone",
  "stale-native-epoch",
  "screen-off",
  "screen-state-unknown",
  "lock-state-unknown",
  "wake-on-phone-required",
]);
export class IphoneSetup {
  readonly #service: IphoneService;
  readonly #mac: IphoneMacSupport;
  #revision = 0;
  readonly #cancelled = new Set<(setupId: string) => void>();
  readonly #transactions = new Map<string, Transaction>();
  readonly #cancellations = new Map<string, { deploymentId: string; work: Promise<void> }>();
  constructor(service: IphoneService, mac: IphoneMacSupport = iphoneMacSupport) {
    this.#service = service;
    this.#mac = mac;
    service.onSlotInvalidated((deploymentId) => {
      void this.stopForSlot(deploymentId).catch(() => undefined);
    });
  }
  async begin(
    owner: IphoneRunnerOwner,
    target?: IphoneScreenAttachCommand["target"],
  ): Promise<DesktopIphoneSetupStatus> {
    await this.stopForSlot(owner.deploymentId);
    const pending = await this.#service.pending(owner);
    const resumed = pending?.attachTarget ?? target ?? null;
    const t: Transaction = {
      owner,
      state: {
        revision: ++this.#revision,
        setupId: pending?.setupId ?? randomUUID(),
        deploymentId: owner.deploymentId as DesktopIphoneSetupStatus["deploymentId"],
        stage: "mac",
        state: "working",
        reason: null,
        action: "none",
        candidates: [],
        phone: null,
        suggestedName: null,
        attachCommand: null,
        target: resumed,
        deviceId: pending?.deviceId ?? null,
        driverGeneration: pending?.driverGeneration ?? null,
        wifiEnabled: pending?.wifiEnabledByOpensteer ?? false,
      },
      candidates: new Map(),
      controller: new AbortController(),
      listeners: new Set(),
      cleanups: [],
      dirty: false,
      ...(pending ? { record: pending } : {}),
    };
    this.#transactions.set(t.state.setupId, t);
    t.cleanups.push(
      this.#service.onChanged(() => {
        if (
          t.state.state === "waiting" ||
          (t.state.stage === "connect" && t.state.state === "decide")
        )
          this.#wake(t);
      }),
    );
    const initial = this.#set(t, {});
    this.#wake(t);
    return initial;
  }
  async choose(setupId: string, candidateId: string): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    await this.#idle(t);
    if (t.state.stage !== "connect" || t.state.state !== "decide" || t.work)
      throw new IphoneServiceError("candidate-gone");
    const localId = t.candidates.get(candidateId);
    const candidate = this.#service.candidates().find((c) => c.localPhoneId === localId);
    if (!candidate || candidate.reason) throw new IphoneServiceError("candidate-gone");
    await this.#run(t, async () => {
      await this.#reserve(t, candidate.localPhoneId);
      await this.#drive(t);
    });
    return this.#snapshot(t);
  }
  async wifi(setupId: string, choice: "wifi" | "usb-only"): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    await this.#idle(t);
    if (t.state.stage !== "wifi" || t.work) throw new IphoneServiceError("no-session");
    t.wifiChoice = choice;
    await this.#run(t, () => this.#drive(t));
    return this.#snapshot(t);
  }
  async add(setupId: string, name?: string): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    await this.#idle(t);
    if (t.state.stage !== "add" || !t.record || t.work || t.record.phase === "bound")
      throw new IphoneServiceError("no-session");
    await this.#run(t, async () => {
      const record = t.record!;
      if (record.phase === "pending-attach") {
        if (
          name !== undefined &&
          record.attachTarget?.kind === "new" &&
          record.attachTarget.name !== name.trim()
        )
          throw new IphoneServiceError("attach-conflict");
      } else {
        const target =
          t.state.target?.kind === "existing"
            ? t.state.target
            : {
                kind: "new" as const,
                name: name ?? t.state.suggestedName ?? "iPhone screen",
              };
        const command = IphoneScreenAttachCommandSchema.parse({
          type: "iphone.screen.attach",
          idempotencyKey: record.setupId,
          driverRunnerId: record.runnerId,
          target,
        });
        const updated = {
          ...record,
          phase: "pending-attach" as const,
          attachTarget: command.target,
          userLabel: command.target.kind === "new" ? command.target.name : record.userLabel,
        };
        await this.#service.save(updated);
        t.record = updated;
        this.#active(t);
      }
      this.#set(t, {
        state: "working",
        reason: null,
        action: "none",
        attachCommand: this.#command(t),
      });
    });
    return this.#snapshot(t);
  }
  async help(
    setupId: string,
    action: "get-xcode" | "open-xcode" | "open-local-network",
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (
      t.state.action !== action &&
      !(action === "get-xcode" && t.state.reason === "xcode-installing")
    )
      throw new IphoneServiceError("no-session");
    await this.#mac.help(action, t.xcodeApp);
    this.#active(t);
    if (action === "get-xcode") {
      t.xcodeRequested = true;
      this.#set(t, { state: "waiting", reason: "xcode-installing", action: "none" });
    }
    this.#wake(t);
    return this.#snapshot(t);
  }
  async retry(setupId: string): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    await this.#idle(t);
    if (t.state.stage === "add" && t.record?.phase !== "bound" && !t.result)
      return this.add(setupId);
    await this.#run(t, () => this.#drive(t));
    return this.#snapshot(t);
  }
  async complete(
    setupId: string,
    value: IphoneScreenAttachResult,
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    await this.#idle(t);
    if (!t.record || t.record.phase !== "pending-attach" || t.work)
      throw new IphoneServiceError("no-session");
    t.result = IphoneScreenAttachResultSchema.parse(value);
    await this.#run(t, () => this.#drive(t));
    return this.#snapshot(t);
  }
  async failed(
    setupId: string,
    reason: DesktopIphoneSetupReason,
  ): Promise<DesktopIphoneSetupStatus> {
    const t = this.#get(setupId);
    if (t.state.stage !== "add" || t.record?.phase !== "pending-attach" || t.work)
      throw new IphoneServiceError("no-session");
    return this.#set(t, {
      state: "blocked",
      reason: DesktopIphoneSetupReasonSchema.parse(reason),
      action: "retry",
    });
  }
  async status(setupId: string): Promise<DesktopIphoneSetupStatus> {
    return this.#snapshot(this.#get(setupId));
  }
  subscribe(setupId: string, listener: (state: DesktopIphoneSetupStatus) => void): () => void {
    const t = this.#get(setupId);
    t.listeners.add(listener);
    listener(this.#snapshot(t));
    return () => {
      t.listeners.delete(listener);
    };
  }
  onCancelled(listener: (setupId: string) => void): () => void {
    this.#cancelled.add(listener);
    return () => {
      this.#cancelled.delete(listener);
    };
  }
  async cancel(setupId: string): Promise<void> {
    const pending = this.#cancellations.get(setupId);
    if (pending) return pending.work;
    const t = this.#transactions.get(setupId);
    if (!t) return;
    this.#transactions.delete(setupId);
    for (const listener of this.#cancelled) listener(setupId);
    t.controller.abort();
    this.#dispose(t);
    t.listeners.clear();
    const work = Promise.resolve()
      .then(async () => {
        await t.work;
        if (t.record) await this.#service.cancelSetup(t.record);
      })
      .finally(() => {
        this.#cancellations.delete(setupId);
      });
    this.#cancellations.set(setupId, { deploymentId: t.owner.deploymentId, work });
    return work;
  }
  async stopForSlot(deploymentId: string): Promise<void> {
    await Promise.all([
      ...[...this.#transactions.values()]
        .filter((t) => t.owner.deploymentId === deploymentId)
        .map((t) => this.cancel(t.state.setupId)),
      ...[...this.#cancellations.values()]
        .filter((t) => t.deploymentId === deploymentId)
        .map((t) => t.work),
    ]);
  }
  async stop(): Promise<void> {
    await Promise.all([
      ...[...this.#transactions.keys()].map((id) => this.cancel(id)),
      ...[...this.#cancellations.values()].map((t) => t.work),
    ]);
  }
  #dispose(t: Transaction): void {
    clearTimeout(t.timer);
    delete t.timer;
    t.macWatch?.();
    delete t.macWatch;
    for (const cleanup of t.cleanups.splice(0)) cleanup();
  }
  async #idle(t: Transaction): Promise<void> {
    while (t.work) await t.work;
    this.#active(t);
  }
  #wake(t: Transaction): void {
    if (t.controller.signal.aborted || t.state.state === "done") return;
    if (t.work) {
      t.dirty = true;
      return;
    }
    void this.#run(t, () => this.#drive(t));
  }
  #run(t: Transaction, operation: () => Promise<void>): Promise<void> {
    clearTimeout(t.timer);
    delete t.timer;
    const work = Promise.resolve()
      .then(async () => {
        try {
          this.#active(t);
          await operation();
          while (t.dirty && !t.controller.signal.aborted && t.state.state !== "blocked") {
            t.dirty = false;
            await this.#drive(t);
          }
        } catch (error) {
          if (!t.controller.signal.aborted) this.#failure(t, error);
        }
      })
      .finally(() => {
        delete t.work;
        const dirty = t.dirty;
        t.dirty = false;
        if (dirty && !t.controller.signal.aborted && t.state.state === "waiting") {
          this.#wake(t);
          return;
        }
        if (
          !t.controller.signal.aborted &&
          t.state.state === "waiting" &&
          t.state.stage !== "mac" &&
          t.state.stage !== "connect" &&
          t.state.reason !== "assignment-pending"
        )
          t.timer = setTimeout(() => this.#wake(t), 2000);
      });
    t.work = work;
    return work;
  }
  async #drive(t: Transaction): Promise<void> {
    const signal = t.controller.signal;
    while (true) {
      this.#active(t);
      const stage = t.state.stage;
      if (stage === "mac") {
        t.macWatch ??= this.#mac.watch(() => {
          if (t.state.state !== "blocked") this.#wake(t);
        });
        this.#working(t);
        await this.#service.discover();
        const support = await this.#mac.inspect();
        this.#active(t);
        const images = await this.#service.refreshImages(support.imageRoots, signal);
        this.#active(t);
        if (support.xcodeApps[0]) t.xcodeApp = support.xcodeApps[0];
        if (!support.xcodeApps.length || !images) {
          this.#set(t, {
            state: "waiting",
            reason: support.xcodeApps.length
              ? "xcode-setup-required"
              : support.xcodeInstalling || t.xcodeRequested
                ? "xcode-installing"
                : "xcode-missing",
            action: support.xcodeApps.length
              ? "open-xcode"
              : support.xcodeInstalling || t.xcodeRequested
                ? "none"
                : "get-xcode",
          });
          return;
        }
        t.macWatch();
        delete t.macWatch;
        if (t.record) this.#phone(t);
        this.#set(t, {
          stage: t.record ? (t.record.phase === "reserved" ? "trust" : "add") : "connect",
        });
      } else if (stage === "connect") {
        this.#candidates(t);
        const usable = [...t.candidates].filter(([, local]) =>
          this.#service.candidates().some((c) => c.localPhoneId === local && c.reason === null),
        );
        if (usable.length !== 1) {
          this.#set(t, {
            state: t.candidates.size ? "decide" : "waiting",
            reason: t.candidates.size ? null : "no-phone",
            action: t.candidates.size ? "choose-phone" : "none",
          });
          return;
        }
        await this.#reserve(t, usable[0]![1]);
      } else if (stage === "trust" || stage === "developer-mode" || stage === "prepare") {
        this.#working(t);
        t.record = await this.#service.reconnect(t.record!, signal);
        this.#active(t);
        this.#phone(t);
        const record = t.record;
        if (stage === "trust") {
          let inspection;
          try {
            inspection = await this.#service.inspect(record, signal);
          } catch (error) {
            if (
              !(error instanceof IphoneServiceError) ||
              !["trust-required", "trust-pending", "pairing-revoked"].includes(error.code)
            )
              throw error;
          }
          this.#active(t);
          if (!inspection || inspection.pairing !== "paired") {
            await this.#service.pair(record, signal);
            this.#active(t);
            inspection = await this.#service.inspect(record, signal);
            this.#active(t);
            if (inspection.pairing !== "paired") throw new IphoneServiceError("trust-pending");
          }
          if (!inspection.model.startsWith("iPhone"))
            throw new IphoneServiceError("unsupported-device");
          if (!(Number(inspection.osVersion.split(".")[0]) >= 27))
            throw new IphoneServiceError("unsupported-ios");
          this.#set(t, { stage: "developer-mode" });
        } else if (stage === "developer-mode") {
          const candidate = this.#service
            .candidates()
            .find((c) => c.localPhoneId === record.localPhoneId)!;
          const incarnation = `${candidate.localPhoneId}:${candidate.nativeEpoch}`;
          if (t.revealed !== incarnation) {
            await this.#service.revealDeveloperMode(record, signal);
            this.#active(t);
            t.revealed = incarnation;
          }
          const inspection = await this.#service.inspect(record, signal);
          this.#active(t);
          if (inspection.developerMode !== "enabled")
            throw new IphoneServiceError(
              inspection.developerMode === "disabled"
                ? "developer-mode-required"
                : "developer-mode-status-unknown",
            );
          this.#set(t, { stage: "prepare" });
        } else {
          const support = await this.#mac.inspect();
          this.#active(t);
          await this.#service.refreshImages(support.imageRoots, signal);
          this.#active(t);
          await this.#service.prepare(record, signal);
          this.#active(t);
          await this.#service.firstObserve(record, signal);
          this.#active(t);
          this.#set(t, { stage: "wifi", state: "decide", reason: null, action: "choose-wifi" });
        }
      } else if (stage === "wifi") {
        if (!t.wifiChoice) return;
        this.#working(t);
        t.record = await this.#service.setupWifi(
          t.record!,
          t.wifiChoice === "wifi" ? "enable" : "disable",
          signal,
        );
        this.#active(t);
        this.#set(t, {
          stage: "add",
          state: "decide",
          reason: null,
          action: "name-phone",
          wifiEnabled: t.record.wifiEnabledByOpensteer,
        });
      } else if (stage === "add") {
        if (t.result && t.record?.phase === "pending-attach") {
          this.#working(t);
          const record = {
            ...t.record,
            deviceId: t.result.deviceId,
            driverGeneration: t.result.generation,
            phase: "bound" as const,
          };
          try {
            await this.#service.finishSetup(t.record);
            this.#active(t);
            await this.#service.save(record);
          } catch {
            throw new IphoneServiceError("local-mapping-save-failed");
          }
          t.record = record;
          this.#active(t);
          this.#set(t, {
            attachCommand: null,
            deviceId: record.deviceId,
            driverGeneration: record.driverGeneration,
          });
        }
        if (t.record?.phase !== "bound") {
          if (t.record?.phase === "pending-attach")
            this.#set(t, {
              state: "decide",
              reason: null,
              action: "name-phone",
              attachCommand: this.#command(t),
            });
          return;
        }
        const confirmed = (await this.#service.targets(t.owner.deploymentId)).some(
          (target) =>
            target.deviceId === t.record?.deviceId &&
            target.driverGeneration === t.record?.driverGeneration,
        );
        this.#active(t);
        if (!confirmed) {
          this.#set(t, { state: "waiting", reason: "assignment-pending", action: "none" });
          return;
        }
        const record = { ...t.record, setupComplete: true };
        await this.#service.save(record);
        t.record = record;
        this.#active(t);
        this.#set(t, { stage: "done", state: "done", reason: null, action: "none" });
        this.#dispose(t);
        return;
      } else return;
    }
  }
  async #reserve(t: Transaction, localId: string): Promise<void> {
    this.#working(t);
    t.record = await this.#service.reserve(
      t.owner,
      localId,
      t.state.setupId,
      t.controller.signal,
      t.state.target,
    );
    this.#active(t);
    this.#phone(t);
    this.#set(t, { stage: "trust" });
  }
  #phone(t: Transaction): void {
    const candidate = this.#service
      .candidates()
      .find((c) => c.localPhoneId === t.record?.localPhoneId);
    if (!candidate) return;
    const clean = (value: string) => value.replace(/\p{Cc}/gu, "").slice(0, 160);
    this.#set(t, {
      phone: {
        name: clean(candidate.name),
        model: clean(candidate.model),
        osVersion: clean(candidate.osVersion),
      },
      suggestedName:
        t.state.target?.kind === "existing"
          ? t.record!.userLabel
          : t.state.target?.kind === "new"
            ? t.state.target.name
            : `${clean(candidate.name).trim().slice(0, 113) || "iPhone"} screen`,
    });
  }
  #command(t: Transaction): IphoneScreenAttachCommand {
    return IphoneScreenAttachCommandSchema.parse({
      type: "iphone.screen.attach",
      idempotencyKey: t.record!.setupId,
      driverRunnerId: t.record!.runnerId,
      target: t.record!.attachTarget ?? { kind: "new", name: t.record!.userLabel },
    });
  }
  #candidates(t: Transaction): void {
    const previous = new Map([...t.candidates].map(([id, local]) => [local, id]));
    t.candidates.clear();
    const clean = (value: string) => value.replace(/\p{Cc}/gu, "").slice(0, 160);
    this.#set(t, {
      candidates: this.#service
        .candidates()
        .filter((c) => c.transport === "usb")
        .map((c) => {
          const candidateId = previous.get(c.localPhoneId) ?? randomUUID();
          t.candidates.set(candidateId, c.localPhoneId);
          return {
            candidateId,
            trust: c.trust,
            name: clean(c.name),
            model: clean(c.model),
            osVersion: clean(c.osVersion),
            reason: c.reason,
          };
        }),
    });
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
  #working(t: Transaction): void {
    this.#set(t, { state: "working", reason: null, action: "none" });
  }
  #failure(t: Transaction, error: unknown): void {
    const parsed = DesktopIphoneSetupReasonSchema.safeParse(
      error instanceof IphoneServiceError ? error.code : "native-service-failed",
    );
    const reason = parsed.success ? parsed.data : "native-service-failed";
    this.#set(t, {
      state:
        phoneWaits.has(reason) || reason === "local-network-permission-required"
          ? "waiting"
          : "blocked",
      reason,
      action:
        reason === "local-network-permission-required"
          ? "open-local-network"
          : phoneWaits.has(reason)
            ? "none"
            : "retry",
    });
  }
  #snapshot(t: Transaction): DesktopIphoneSetupStatus {
    this.#active(t);
    return DesktopIphoneSetupStatusSchema.parse(t.state);
  }
  #set(t: Transaction, update: Partial<DesktopIphoneSetupStatus>): DesktopIphoneSetupStatus {
    this.#active(t);
    t.state = DesktopIphoneSetupStatusSchema.parse({
      ...t.state,
      ...update,
      revision: ++this.#revision,
    });
    const result = this.#snapshot(t);
    for (const listener of t.listeners) listener(result);
    return result;
  }
}
