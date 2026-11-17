import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  iphoneNativeRosterSchema,
  iphoneNativeInspectionSchema,
  iphoneNativePhoneRefSchema,
  iphonePrivateIdentityResultSchema,
  iphoneRunnerParams,
  iphoneRunnerResults,
  type IphoneRunnerMethod,
  type IphoneRunnerParams,
  type IphoneRunnerResult,
  type IphoneRunnerOwner,
  type IphoneRunnerPort,
  type IphoneRunnerEvent,
} from "@opensteer/protocol/iphone-bridge";
import type { IphoneNativeTransport } from "./bridge-client.js";
import {
  DesktopIphoneSetupReasonSchema,
  type DesktopIphoneWifiStatusSchema,
} from "@opensteer/protocol/desktop";
import { IphoneStore, IphoneServiceError, type IphoneMapping } from "./iphone-store.js";

const empty = z.strictObject({});
type Candidate = z.infer<typeof iphoneNativeRosterSchema>["candidates"][number];
type Assignment = IphoneRunnerParams<"iphone.targets">["assignments"][number];
type Binding = { token: string; epoch: number; record: IphoneMapping };
type Session = {
  key: object;
  binding: Binding;
  sessionId: string;
  runId: string;
  access: "observe" | "control";
  controller: AbortController;
};
type Slot = { owner: IphoneRunnerOwner; assignments: readonly Assignment[]; key: object };
export interface IphoneServiceOptions {
  readonly store: IphoneStore;
  readonly startNative: () => Promise<{
    client: IphoneNativeTransport;
    images: { handle: string; build: string }[];
  }>;
  readonly supported?: boolean;
}
function sameOwner(a: IphoneRunnerOwner, b: IphoneRunnerOwner): boolean {
  return (
    a.deploymentId === b.deploymentId &&
    a.hostInstanceId === b.hostInstanceId &&
    a.runnerId === b.runnerId
  );
}
export class IphoneService {
  readonly store: IphoneStore;
  readonly #options: IphoneServiceOptions;
  readonly #slots = new Map<string, Slot>();
  readonly #bindings = new Map<string, Binding>();
  readonly #bindingWork = new Map<string, Promise<Binding>>();
  readonly #sessions = new Map<string, Session>();
  readonly #changed = new Set<() => void>();
  readonly #invalidatedSlots = new Set<(deploymentId: string) => void>();
  readonly #listeners = new Set<(deploymentId: string, event: IphoneRunnerEvent) => void>();
  readonly #cleanups = new Set<Promise<unknown>>();
  readonly #wifiWork = new Map<string, Promise<void>>();
  #records: IphoneMapping[] = [];
  #roster: Candidate[] = [];
  #revision = -1;
  #native: IphoneNativeTransport | undefined;
  #starting: Promise<IphoneNativeTransport> | undefined;
  #images: { handle: string; build: string }[] = [];
  #suspended = false;
  #nativeGeneration = 0;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #detachNative: (() => void)[] = [];
  constructor(options: IphoneServiceOptions) {
    this.#options = options;
    this.store = options.store;
  }
  get supported(): boolean {
    return this.#options.supported !== false;
  }
  async start(): Promise<void> {
    this.#records = await this.store.records();
    if (this.#records.length) await this.discover();
  }
  async discover(): Promise<void> {
    const generation = this.#nativeGeneration;
    const native = await this.#connect();
    const roster = await native.request("roster.get", {}, iphoneNativeRosterSchema);
    if (generation !== this.#nativeGeneration || native !== this.#native || this.#stopped) return;
    this.#reconcile(roster);
  }
  onChanged(listener: () => void): () => void {
    this.#changed.add(listener);
    return () => {
      this.#changed.delete(listener);
    };
  }
  async refreshImages(imageRoots: string[], signal: AbortSignal): Promise<boolean> {
    const native = await this.#connect();
    const { images } = await native.request(
      "images.refresh",
      { imageRoots },
      z.strictObject({
        images: z.array(z.strictObject({ handle: z.string(), build: z.string() })).max(8),
      }),
      { signal },
    );
    if (signal.aborted || native !== this.#native) throw new IphoneServiceError("cancelled");
    this.#images = images;
    return images.length > 0;
  }
  async revealDeveloperMode(record: IphoneMapping, signal: AbortSignal): Promise<void> {
    await (
      await this.#connect()
    ).request("setup.revealDeveloperMode", this.#ref(record), empty, { signal });
  }
  async reconnect(record: IphoneMapping, signal: AbortSignal): Promise<IphoneMapping> {
    const native = await this.#connect();
    for (const candidate of this.#roster) {
      const { udid } = await native.request(
        "phone.identity",
        { candidateId: candidate.localPhoneId },
        iphonePrivateIdentityResultSchema,
        { signal },
      );
      if (signal.aborted) throw new IphoneServiceError("cancelled");
      if (udid !== record.udid) continue;
      if (record.localPhoneId === candidate.localPhoneId) return record;
      const updated = { ...record, localPhoneId: candidate.localPhoneId };
      await this.save(updated);
      return updated;
    }
    throw new IphoneServiceError("phone-disconnected");
  }
  candidates(): readonly Candidate[] {
    return this.#roster;
  }
  onSlotInvalidated(listener: (deploymentId: string) => void): () => void {
    this.#invalidatedSlots.add(listener);
    return () => {
      this.#invalidatedSlots.delete(listener);
    };
  }
  ownerForSlot(deploymentId: string): IphoneRunnerOwner {
    const slot = this.#slots.get(deploymentId);
    if (!slot) throw new IphoneServiceError("runner-not-enrolled");
    return slot.owner;
  }
  async reserve(
    owner: IphoneRunnerOwner,
    candidateId: string,
    setupId: string,
    signal?: AbortSignal,
    target: IphoneMapping["attachTarget"] = null,
  ): Promise<IphoneMapping> {
    const native = await this.#connect();
    const candidate = this.#roster.find(({ localPhoneId }) => localPhoneId === candidateId);
    if (!candidate) throw new IphoneServiceError("candidate-gone");
    const { udid } = await native.request(
      "phone.identity",
      { candidateId },
      iphonePrivateIdentityResultSchema,
      signal ? { signal } : {},
    );
    if (signal?.aborted) throw new IphoneServiceError("cancelled");
    const previous = this.#records.find((r) => r.udid === udid && r.setupId !== setupId);
    if (previous && sameOwner(previous, owner)) {
      const assigned = this.#slots
        .get(owner.deploymentId)
        ?.assignments.some(
          (a) => a.deviceId === previous.deviceId && a.generation === previous.driverGeneration,
        );
      if (
        target?.kind !== "existing" ||
        previous.deviceId !== target.deviceId ||
        previous.phase !== "bound" ||
        (assigned &&
          this.#roster.find((c) => c.localPhoneId === previous.localPhoneId)?.capabilities
            ?.observe === null)
      )
        throw new IphoneServiceError("phone-already-added");
      // Re-setup replaces stale native ownership while preserving the Host Device.
      await this.#release(previous, true);
      await this.store.remove(previous);
      this.#records = await this.store.records();
    }
    if (signal?.aborted) throw new IphoneServiceError("cancelled");
    const record = await this.store.reserve({
      ...owner,
      udid,
      localPhoneId: candidateId,
      setupId,
      userLabel: previous?.userLabel ?? safeLabel(candidate.name),
      deviceId: null,
      driverGeneration: null,
      phase: "reserved",
      wifiEnabledByOpensteer: false,
      setupComplete: false,
      detachKey: null,
      attachTarget: target,
    });
    this.#records = await this.store.records();
    try {
      await this.#binding(record, signal);
      if (signal?.aborted) throw new IphoneServiceError("cancelled");
    } catch (error) {
      await this.#release(record, true);
      if (record.phase === "reserved") {
        await this.store.remove(record);
        this.#records = await this.store.records();
      }
      throw error;
    }
    return record;
  }
  async inspect(record: IphoneMapping, signal?: AbortSignal) {
    const native = await this.#connect();
    return native.request(
      "setup.inspect",
      this.#ref(record),
      iphoneNativeInspectionSchema,
      signal ? { signal } : {},
    );
  }
  async pair(record: IphoneMapping, signal: AbortSignal): Promise<void> {
    await (await this.#connect()).request("setup.pair", this.#ref(record), empty, { signal });
  }
  #wifiRecord(owner: IphoneRunnerOwner, deviceId: string): IphoneMapping {
    const record = this.#records.find(
      (r) => sameOwner(r, owner) && r.deviceId === deviceId && r.phase === "bound",
    );
    if (!record) throw new IphoneServiceError("candidate-gone");
    return record;
  }
  async wifiStatus(
    owner: IphoneRunnerOwner,
    deviceId: string,
  ): Promise<z.infer<typeof DesktopIphoneWifiStatusSchema>> {
    const record = this.#wifiRecord(owner, deviceId);
    const candidate = this.#roster.find((c) => c.localPhoneId === record.localPhoneId);
    return {
      enabled: record.wifiEnabledByOpensteer,
      transport: candidate?.transport ?? null,
      reason: candidate ? null : "phone-disconnected",
    };
  }
  async configureWifi(
    owner: IphoneRunnerOwner,
    deviceId: string,
    action: "enable" | "disable" | "pair",
    signal?: AbortSignal,
  ): Promise<z.infer<typeof DesktopIphoneWifiStatusSchema>> {
    const record = this.#wifiRecord(owner, deviceId);
    try {
      await this.setupWifi(record, action, signal);
      return { ...(await this.wifiStatus(owner, deviceId)), reason: null };
    } catch (error) {
      const reason = DesktopIphoneSetupReasonSchema.safeParse(
        error instanceof IphoneServiceError ? error.code : "native-service-failed",
      );
      return {
        ...(await this.wifiStatus(owner, deviceId)),
        reason: reason.success ? reason.data : "native-service-failed",
      };
    }
  }
  async setupWifi(
    record: IphoneMapping,
    action: "enable" | "disable" | "pair",
    signal?: AbortSignal,
  ): Promise<IphoneMapping> {
    if (this.#wifiWork.has(record.udid)) throw new IphoneServiceError("phone-in-use");
    const work = Promise.withResolvers<void>();
    this.#wifiWork.set(record.udid, work.promise);
    try {
      const native = await this.#connect();
      if (action === "disable") {
        await native.request("setup.withdrawWifi", this.#privateBindingRef(record), empty);
      } else {
        await this.#binding(record, signal);
        await native.request(
          action === "enable" ? "setup.enableWifi" : "setup.pairWifi",
          this.#ref(record),
          empty,
          signal ? { signal } : {},
        );
        if (action === "enable" && !record.wifiEnabledByOpensteer)
          await native.request(
            "setup.pairWifi",
            this.#ref(record),
            empty,
            signal ? { signal } : {},
          );
      }
      const current = this.#records.find(
        (r) =>
          r.udid === record.udid &&
          r.setupId === record.setupId &&
          sameOwner(r, record) &&
          r.phase !== "pending-detach",
      );
      if (!current || signal?.aborted) throw new IphoneServiceError("cancelled");
      const updated = { ...current, wifiEnabledByOpensteer: action !== "disable" };
      try {
        await this.save(updated);
      } catch {
        throw new IphoneServiceError("local-mapping-save-failed");
      }
      return updated;
    } catch (error) {
      if (action === "enable" && !record.wifiEnabledByOpensteer)
        await (
          await this.#connect()
        ).request("setup.withdrawWifi", this.#privateBindingRef(record), empty);
      throw error;
    } finally {
      this.#wifiWork.delete(record.udid);
      work.resolve();
    }
  }
  async prepare(record: IphoneMapping, signal: AbortSignal): Promise<void> {
    await this.#connect();
    const image = this.#images[0];
    if (!image) throw new IphoneServiceError("developer-image-missing");
    await (
      await this.#connect()
    ).request(
      "setup.prepareDeveloperServices",
      { ...this.#ref(record), imageHandle: image.handle },
      iphoneNativeInspectionSchema,
      { signal, timeoutMs: 120000 },
    );
  }
  async firstObserve(record: IphoneMapping, signal: AbortSignal): Promise<void> {
    const binding = await this.#binding(record, signal);
    const native = await this.#connect();
    const sessionId = record.setupId;
    try {
      const ref = await native.request(
        "session.open",
        { bindingToken: binding.token, sessionId, runId: sessionId, access: "observe" },
        iphoneNativePhoneRefSchema,
        { signal },
      );
      binding.epoch = ref.nativeEpoch;
      const observation = await native.request(
        "phone.observe",
        {
          bindingToken: binding.token,
          sessionId,
          nativeEpoch: binding.epoch,
          includeScreenshot: true,
        },
        iphoneRunnerResults["iphone.observe"],
        { signal },
      );
      if (observation.state.lock !== "unlocked")
        throw new IphoneServiceError(
          observation.state.lock === "locked" ? "phone-locked" : "lock-state-unknown",
        );
      if (observation.state.display !== "on")
        throw new IphoneServiceError(
          observation.state.display === "off" ? "screen-off" : "screen-state-unknown",
        );
      if (!observation.screenshot) throw new IphoneServiceError("screenshot-failed");
    } finally {
      await native.request("session.close", { bindingToken: binding.token, sessionId }, empty, {
        timeoutMs: 2000,
      });
    }
  }
  async save(record: IphoneMapping): Promise<void> {
    const previous = this.#records.find((r) => r.udid === record.udid);
    await this.store.save(record);
    this.#records = await this.store.records();
    const slot = this.#slots.get(record.deploymentId);
    if (
      record.phase === "bound" &&
      previous?.phase !== "bound" &&
      slot &&
      sameOwner(record, slot.owner) &&
      slot.assignments.some(
        (a) => a.deviceId === record.deviceId && a.generation === record.driverGeneration,
      )
    )
      await this.#probe(record);
  }
  async finishSetup(record: IphoneMapping): Promise<void> {
    await this.#release(record, true);
  }
  async cancelSetup(record: IphoneMapping): Promise<void> {
    if (record.phase !== "reserved" && record.phase !== "pending-attach") return;
    await this.#wifiWork.get(record.udid);
    await (
      await this.#connect()
    ).request("setup.withdrawWifi", this.#privateBindingRef(record), empty);
    await this.#release(record, true);
    if (record.phase === "reserved") await this.store.remove(record);
    else await this.store.save({ ...record, wifiEnabledByOpensteer: false });
    this.#records = await this.store.records();
  }
  async pending(owner: IphoneRunnerOwner): Promise<IphoneMapping | undefined> {
    this.#records = await this.store.records();
    return this.#records.find(
      (r) =>
        sameOwner(r, owner) &&
        (r.phase === "reserved" ||
          r.phase === "pending-attach" ||
          (r.phase === "bound" && !r.setupComplete)),
    );
  }
  async detach(owner: IphoneRunnerOwner, deviceId: string): Promise<IphoneMapping> {
    const record = this.#records.find((r) => sameOwner(r, owner) && r.deviceId === deviceId);
    if (!record) throw new IphoneServiceError("candidate-gone");
    // Authority is withdrawn before either local persistence or Host acknowledgement.
    record.phase = "pending-detach";
    record.detachKey ??= randomUUID();
    this.#invalidate(record, "cancelled");
    await this.save(record);
    await this.#release(record, true);
    return record;
  }
  pendingDetaches(owner: IphoneRunnerOwner): IphoneMapping[] {
    return this.#records.filter((r) => sameOwner(r, owner) && r.phase === "pending-detach");
  }
  async confirmDetach(
    owner: IphoneRunnerOwner,
    deviceId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const record = this.#records.find(
      (r) => sameOwner(r, owner) && r.deviceId === deviceId && r.phase === "pending-detach",
    );
    if (!record || (idempotencyKey !== undefined && record.detachKey !== idempotencyKey))
      throw new IphoneServiceError("no-session");
    try {
      await this.#release(record, true);
    } catch (error) {
      if (!(error instanceof IphoneServiceError) || error.code !== "owned-by-another-deployment")
        throw error;
    }
    await this.store.remove(record);
    this.#records = await this.store.records();
  }
  async targets(deploymentId: string): Promise<IphoneRunnerResult<"iphone.targets">["targets"]> {
    const slot = this.#slots.get(deploymentId);
    if (!slot) return [];
    return this.#records
      .filter(
        (r) =>
          r.phase === "bound" &&
          sameOwner(r, slot.owner) &&
          slot.assignments.some(
            (a) => a.deviceId === r.deviceId && a.generation === r.driverGeneration,
          ),
      )
      .map((r) => {
        const candidate = this.#roster.find((c) => c.localPhoneId === r.localPhoneId);
        return {
          deviceId: r.deviceId!,
          driverGeneration: r.driverGeneration!,
          nativeEpoch: candidate?.nativeEpoch ?? 0,
          ready: candidate?.capabilities?.observe === null,
          reason: candidate
            ? (candidate.reason ??
              (candidate.capabilities?.observe === null
                ? null
                : (candidate.capabilities?.observe ?? "not-initialized")))
            : "phone-disconnected",
          ...(candidate?.capabilities ? { capabilities: candidate.capabilities } : {}),
        };
      });
  }
  forSlot(owner: IphoneRunnerOwner): IphoneRunnerPort {
    const { deploymentId } = owner;
    return {
      connect: (emit) => {
        const key = {};
        let alive = true;
        const listener = (slot: string, event: IphoneRunnerEvent) => {
          if (alive && slot === deploymentId) emit(event);
        };
        this.#listeners.add(listener);
        return {
          request: async <M extends IphoneRunnerMethod>(
            method: M,
            input: IphoneRunnerParams<M>,
            options: { deadline: number; signal?: AbortSignal },
          ): Promise<IphoneRunnerResult<M>> => {
            if (!alive || this.#stopped) throw new IphoneServiceError("no-session");
            const params = iphoneRunnerParams[method].parse(input);
            if (method === "iphone.targets") {
              const update = iphoneRunnerParams["iphone.targets"].parse(params);
              const old = this.#slots.get(deploymentId);
              if (old && !sameOwner(old.owner, owner))
                for (const listener of this.#invalidatedSlots) listener(deploymentId);
              this.#slots.set(deploymentId, {
                owner,
                assignments: update.assignments,
                key,
              });
              for (const record of this.#records.filter((r) => r.deploymentId === deploymentId)) {
                if (!sameOwner(record, owner)) {
                  this.#invalidate(record, "no-session");
                  await this.#release(record, true);
                  await this.store.remove(record);
                  this.#records = await this.store.records();
                } else if (
                  record.phase === "bound" &&
                  !update.assignments.some(
                    (a) =>
                      a.deviceId === record.deviceId && a.generation === record.driverGeneration,
                  )
                ) {
                  this.#invalidate(record, "no-session");
                  if (
                    update.retainedDeviceIds &&
                    record.deviceId &&
                    !update.retainedDeviceIds.includes(record.deviceId)
                  ) {
                    await this.#wifiWork.get(record.udid);
                    await (
                      await this.#connect()
                    ).request("setup.withdrawWifi", this.#privateBindingRef(record), empty);
                    await this.#release(record, true);
                    await this.store.remove(record);
                    this.#records = await this.store.records();
                  } else this.#cleanup(this.#release(record, false));
                }
              }
              if (old && old.key !== key) this.#closeOwner(old.key);
              if (this.#records.some((r) => r.phase === "bound")) await this.discover();
              for (const record of this.#records.filter(
                (r) =>
                  sameOwner(r, owner) &&
                  r.phase === "bound" &&
                  update.assignments.some(
                    (a) => a.deviceId === r.deviceId && a.generation === r.driverGeneration,
                  ),
              ))
                await this.#probe(record);
              for (const listener of this.#changed) listener();
              return iphoneRunnerResults[method].parse({
                targets: await this.targets(deploymentId),
              }) as IphoneRunnerResult<M>;
            }
            const result = await this.#runtime(deploymentId, key, method, params, options);
            if (!alive && method !== "iphone.session.close" && method !== "iphone.cancel")
              throw new IphoneServiceError(
                "no-session",
                method === "iphone.perform" ? "unknown" : "not-started",
              );
            return iphoneRunnerResults[method].parse(result) as IphoneRunnerResult<M>;
          },
          close: () => {
            if (!alive) return;
            alive = false;
            this.#listeners.delete(listener);
            this.#closeOwner(key);
            if (this.#slots.get(deploymentId)?.key === key) {
              this.#slots.delete(deploymentId);
              for (const listener of this.#invalidatedSlots) listener(deploymentId);
            }
          },
        };
      },
    };
  }
  async #runtime(
    deploymentId: string,
    key: object,
    method: IphoneRunnerMethod,
    params: IphoneRunnerParams<IphoneRunnerMethod>,
    options: { deadline: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (!("deviceId" in params)) throw new IphoneServiceError("no-session");
    const slot = this.#slots.get(deploymentId);
    const record = this.#records.find(
      (r) =>
        slot &&
        sameOwner(r, slot.owner) &&
        r.phase === "bound" &&
        r.deviceId === params.deviceId &&
        r.driverGeneration === params.driverGeneration &&
        slot.assignments.some(
          (a) => a.deviceId === r.deviceId && a.generation === r.driverGeneration,
        ),
    );
    if (!record || slot?.key !== key) throw new IphoneServiceError("no-session");
    if (method === "iphone.media") return { available: false, reason: "unsupported" };
    const timeoutMs = Math.min(30000, Math.floor(options.deadline - Date.now()));
    if (timeoutMs <= 0 || options.signal?.aborted)
      throw new IphoneServiceError("deadline-exceeded");
    let session = this.#sessions.get(record.udid);
    if (method === "iphone.session.close" || method === "iphone.cancel") {
      if (session && session.key !== key) throw new IphoneServiceError("no-session");
      if (
        session &&
        "sessionId" in params &&
        (session.sessionId !== params.sessionId || session.runId !== params.runId)
      )
        throw new IphoneServiceError("no-session");
      if (session) {
        this.#end(session, "cancelled");
        await this.#drain();
      }
      return {};
    }
    if (method !== "iphone.session.open" && method !== "iphone.installedApps") {
      if (
        !session ||
        !("sessionId" in params) ||
        session.key !== key ||
        session.sessionId !== params.sessionId ||
        session.runId !== params.runId
      )
        throw new IphoneServiceError("no-session");
    }
    if (method === "iphone.session.open" && session) throw new IphoneServiceError("phone-in-use");
    const binding = await this.#binding(record);
    const native = await this.#connect();
    const authorized = () => {
      const live = this.#slots.get(deploymentId);
      return (
        !this.#stopped &&
        this.#native === native &&
        this.#bindings.get(record.udid) === binding &&
        live?.key === key &&
        sameOwner(record, live.owner) &&
        this.#records.some(
          (r) =>
            r.udid === record.udid &&
            r.phase === "bound" &&
            r.deviceId === record.deviceId &&
            r.driverGeneration === record.driverGeneration &&
            sameOwner(r, live.owner),
        ) &&
        live.assignments.some(
          (a) => a.deviceId === record.deviceId && a.generation === record.driverGeneration,
        )
      );
    };
    if (!authorized()) throw new IphoneServiceError("no-session");
    const remaining = Math.min(30000, Math.floor(options.deadline - Date.now()));
    if (remaining <= 0 || options.signal?.aborted)
      throw new IphoneServiceError("deadline-exceeded");
    const callOptions = {
      timeoutMs: remaining,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    if (method === "iphone.installedApps") {
      const p = iphoneRunnerParams[method].parse(params);
      const inventory = await native.request(
        "phone.installedApps",
        {
          bindingToken: binding.token,
          nativeEpoch: binding.epoch,
          ...(p.filter ? { filter: p.filter } : {}),
          limit: p.limit,
          offset: p.offset,
        },
        iphoneRunnerResults[method],
        callOptions,
      );
      if (!authorized()) throw new IphoneServiceError("no-session");
      return inventory;
    }
    if (method === "iphone.session.open") {
      const p = iphoneRunnerParams[method].parse(params);
      // Claim before native open, so two Runs cannot race while the helper replies.
      if (this.#sessions.has(record.udid) || !authorized())
        throw new IphoneServiceError("no-session");
      session = {
        key,
        binding,
        sessionId: p.sessionId,
        runId: p.runId,
        access: p.access,
        controller: new AbortController(),
      };
      this.#sessions.set(record.udid, session);
      try {
        const ref = await native.request(
          "session.open",
          { bindingToken: binding.token, sessionId: p.sessionId, runId: p.runId, access: p.access },
          iphoneNativePhoneRefSchema,
          {
            timeoutMs: remaining,
            signal: AbortSignal.any([
              session.controller.signal,
              ...(options.signal ? [options.signal] : []),
            ]),
          },
        );
        if (this.#sessions.get(record.udid) !== session || session.controller.signal.aborted)
          throw new IphoneServiceError("no-session");
        binding.epoch = ref.nativeEpoch;
        return { nativeEpoch: ref.nativeEpoch };
      } catch (error) {
        this.#end(session, "no-session");
        throw error;
      }
    }
    if (!session) throw new IphoneServiceError("no-session");
    const signal = AbortSignal.any([
      session.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    if (method === "iphone.observe") {
      const p = iphoneRunnerParams[method].parse(params);
      const result = await native.request(
        "phone.observe",
        {
          bindingToken: binding.token,
          sessionId: p.sessionId,
          nativeEpoch: binding.epoch,
          includeScreenshot: p.includeScreenshot,
        },
        iphoneRunnerResults[method],
        { timeoutMs: remaining, signal },
      );
      if (this.#sessions.get(record.udid) !== session || signal.aborted)
        throw new IphoneServiceError("no-session");
      return result;
    }
    if (method === "iphone.perform") {
      const p = iphoneRunnerParams[method].parse(params);
      if (session.access !== "control" || p.nativeEpoch !== binding.epoch)
        throw new IphoneServiceError("stale-native-epoch");
      const {
        deviceId: _deviceId,
        driverGeneration: _generation,
        runId: _runId,
        ...nativeParams
      } = p;
      const receipt = await native.request(
        "phone.perform",
        { ...nativeParams, bindingToken: binding.token },
        iphoneRunnerResults[method],
        { timeoutMs: remaining, signal },
      );
      if (!authorized() || this.#sessions.get(record.udid) !== session || signal.aborted)
        throw new IphoneServiceError("no-session", "unknown");
      return receipt;
    }
    throw new IphoneServiceError("unsupported");
  }
  #ref(record: IphoneMapping) {
    const candidate = this.#roster.find((c) => c.localPhoneId === record.localPhoneId);
    if (!candidate) throw new IphoneServiceError("phone-disconnected");
    return { localPhoneId: candidate.localPhoneId, nativeEpoch: candidate.nativeEpoch };
  }
  #privateBindingRef(record: IphoneMapping) {
    return {
      udid: record.udid,
      deploymentId: record.deploymentId,
      hostInstanceId: record.hostInstanceId,
      runnerId: record.runnerId,
      deviceId: record.deviceId ?? record.setupId,
      driverGeneration: record.driverGeneration ?? 1,
    };
  }
  async #probe(record: IphoneMapping): Promise<void> {
    try {
      const binding = await this.#binding(record);
      await (
        await this.#connect()
      ).request("binding.probe", { bindingToken: binding.token }, empty, { timeoutMs: 5000 });
      await this.discover();
    } catch {
      // Native roster carries the failed probe's typed reason.
    }
  }
  #binding(record: IphoneMapping, signal?: AbortSignal): Promise<Binding> {
    const existing = this.#bindings.get(record.udid);
    if (existing) {
      try {
        existing.epoch = this.#ref(record).nativeEpoch;
        return Promise.resolve(existing);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const pending = this.#bindingWork.get(record.udid);
    if (pending) return pending;
    const work = (async () => {
      const native = await this.#connect();
      const ref = this.#ref(record);
      const identity = await native.request(
        "phone.identity",
        { candidateId: ref.localPhoneId },
        iphonePrivateIdentityResultSchema,
        signal ? { signal } : {},
      );
      if (signal?.aborted) throw new IphoneServiceError("cancelled");
      if (identity.udid !== record.udid) throw new IphoneServiceError("identity-mismatch");
      const result = await native.request(
        "binding.acquire",
        {
          ...ref,
          deploymentId: record.deploymentId,
          hostInstanceId: record.hostInstanceId,
          runnerId: record.runnerId,
          deviceId: record.deviceId ?? record.setupId,
          driverGeneration: record.driverGeneration ?? 1,
        },
        z.strictObject({ bindingToken: z.string().min(1).max(128) }),
        signal ? { signal } : {},
      );
      const binding = { token: result.bindingToken, epoch: ref.nativeEpoch, record };
      if (this.#stopped || this.#native !== native)
        throw new IphoneServiceError("phone-disconnected");
      this.#bindings.set(record.udid, binding);
      return binding;
    })();
    this.#bindingWork.set(record.udid, work);
    void work
      .finally(() => {
        if (this.#bindingWork.get(record.udid) === work) this.#bindingWork.delete(record.udid);
      })
      .catch(() => undefined);
    return work;
  }
  async #release(record: IphoneMapping, forget: boolean): Promise<void> {
    await this.#bindingWork.get(record.udid)?.catch(() => undefined);
    const binding = this.#bindings.get(record.udid);
    if (
      binding &&
      (binding.record.setupId !== record.setupId || !sameOwner(binding.record, record))
    )
      return;
    if (!binding) {
      if (forget && !this.#stopped)
        await (
          await this.#connect()
        ).request("binding.forget", this.#privateBindingRef(record), empty, { timeoutMs: 2000 });
      return;
    }
    this.#bindings.delete(record.udid);
    await this.#native?.request("binding.release", { bindingToken: binding.token, forget }, empty, {
      timeoutMs: 2000,
    });
  }
  #end(session: Session, reason: "cancelled" | "no-session" | "phone-disconnected"): void {
    if (this.#sessions.get(session.binding.record.udid) !== session) return;
    this.#sessions.delete(session.binding.record.udid);
    session.controller.abort();
    const record = session.binding.record;
    this.#emit(record.deploymentId, {
      kind: "event",
      event: "iphone.sessionEnded",
      params: {
        deviceId: record.deviceId!,
        driverGeneration: record.driverGeneration!,
        nativeEpoch: session.binding.epoch,
        sessionId: session.sessionId,
        runId: session.runId,
        reason,
      },
    });
    const cleanup = this.#native?.request(
      "session.close",
      { bindingToken: session.binding.token, sessionId: session.sessionId },
      empty,
      { timeoutMs: 2000 },
    );
    if (cleanup) this.#cleanup(cleanup);
  }
  #cleanup(work: Promise<unknown>): void {
    this.#cleanups.add(work);
    void work.finally(() => this.#cleanups.delete(work)).catch(() => undefined);
  }
  #closeOwner(key: object): void {
    for (const session of Array.from(this.#sessions.values()))
      if (session.key === key) this.#end(session, "no-session");
  }
  #invalidate(
    record: IphoneMapping,
    reason: "cancelled" | "no-session" | "phone-disconnected",
  ): void {
    const session = this.#sessions.get(record.udid);
    if (session) this.#end(session, reason);
    if (record.deviceId && record.driverGeneration)
      this.#emit(record.deploymentId, {
        kind: "event",
        event: "iphone.targetsChanged",
        params: {
          deviceId: record.deviceId,
          driverGeneration: record.driverGeneration,
          nativeEpoch: 0,
          ready: false,
          reason: "phone-disconnected",
        },
      });
  }
  #emit(deploymentId: string, event: IphoneRunnerEvent): void {
    const record = this.#records.find(
      (r) =>
        r.deviceId === event.params.deviceId &&
        r.driverGeneration === event.params.driverGeneration,
    );
    const slot = this.#slots.get(deploymentId);
    if (record && slot && !sameOwner(record, slot.owner)) return;
    for (const listener of this.#listeners) listener(deploymentId, event);
  }
  #reconcile(roster: z.infer<typeof iphoneNativeRosterSchema>): void {
    if (roster.revision < this.#revision) return;
    const probe: IphoneMapping[] = [];
    for (const record of this.#records) {
      const before = this.#roster.find((c) => c.localPhoneId === record.localPhoneId);
      const after = roster.candidates.find((c) => c.localPhoneId === record.localPhoneId);
      if (
        before &&
        (!after || before.nativeEpoch !== after.nativeEpoch || before.transport !== after.transport)
      )
        this.#invalidate(record, "phone-disconnected");
      const slot = this.#slots.get(record.deploymentId);
      if (
        after &&
        (!before || before.nativeEpoch !== after.nativeEpoch) &&
        record.phase === "bound" &&
        slot?.assignments.some(
          (a) => a.deviceId === record.deviceId && a.generation === record.driverGeneration,
        )
      )
        probe.push(record);
    }
    this.#roster = roster.candidates;
    this.#revision = roster.revision;
    for (const listener of this.#changed) listener();
    for (const record of probe) this.#cleanup(this.#probe(record));
    const generation = this.#nativeGeneration;
    for (const slot of this.#slots.keys())
      void this.targets(slot).then((targets) => {
        if (this.#stopped || generation !== this.#nativeGeneration) return;
        for (const params of targets)
          this.#emit(slot, { kind: "event", event: "iphone.targetsChanged", params });
      });
  }
  async #connect(): Promise<IphoneNativeTransport> {
    if (this.#stopped || this.#suspended) throw new IphoneServiceError("cancelled");
    if (this.#options.supported === false) throw new IphoneServiceError("unsupported-mac");
    if (this.#native) return this.#native;
    if (this.#starting) return this.#starting;
    const generation = this.#nativeGeneration;
    const starting = (async () => {
      const result = await this.#options.startNative();
      if (this.#stopped || generation !== this.#nativeGeneration) {
        await result.client.close();
        throw new IphoneServiceError("cancelled");
      }
      this.#native = result.client;
      this.#images = result.images;
      this.#detachNative = [
        result.client.onGap?.(() => {
          for (const record of this.#records) this.#invalidate(record, "phone-disconnected");
          this.#roster = [];
          this.#revision = -1;
        }) ?? (() => undefined),
        result.client.onEvent((event) => this.#reconcile(event.roster)),
        result.client.onLost(() => {
          if (this.#native !== result.client) return;
          for (const record of this.#records) this.#invalidate(record, "phone-disconnected");
          this.#native = undefined;
          this.#roster = [];
          this.#revision = -1;
          this.#bindings.clear();
          for (const listener of this.#changed) listener();
          for (const detach of this.#detachNative.splice(0)) detach();
        }),
      ];
      try {
        const roster = await result.client.request(
          "roster.subscribe",
          {},
          iphoneNativeRosterSchema,
        );
        if (
          this.#stopped ||
          this.#native !== result.client ||
          generation !== this.#nativeGeneration
        )
          throw new IphoneServiceError("cancelled");
        this.#reconcile(roster);
      } catch (error) {
        if (this.#native === result.client) {
          await result.client.close();
          if (this.#native === result.client) {
            this.#native = undefined;
            for (const detach of this.#detachNative.splice(0)) detach();
          }
        }
        throw error;
      }
      return result.client;
    })();
    this.#starting = starting;
    try {
      return await starting;
    } finally {
      if (this.#starting === starting) this.#starting = undefined;
    }
  }
  async stopForSlot(deploymentId: string): Promise<void> {
    const slot = this.#slots.get(deploymentId);
    this.#slots.delete(deploymentId);
    for (const listener of this.#invalidatedSlots) listener(deploymentId);
    if (slot) this.#closeOwner(slot.key);
    for (const record of this.#records.filter((r) => r.deploymentId === deploymentId)) {
      this.#invalidate(record, "no-session");
      await this.#release(record, false);
    }
    await this.#drain();
  }
  suspend(): void {
    this.#suspended = true;
    this.#nativeGeneration++;
    for (const detach of this.#detachNative.splice(0)) detach();
    for (const record of this.#records) this.#invalidate(record, "phone-disconnected");
    const native = this.#native;
    this.#native = undefined;
    this.#bindings.clear();
    this.#roster = [];
    this.#revision = -1;
    if (native) this.#cleanup(native.close());
  }
  async resume(): Promise<void> {
    if (this.#stopped || !this.#suspended) return;
    const generation = this.#nativeGeneration;
    await this.#starting?.catch(() => undefined);
    await this.#drain();
    if (this.#stopped || generation !== this.#nativeGeneration) return;
    this.#suspended = false;
    if (
      this.#records.some((record) => {
        const slot = this.#slots.get(record.deploymentId);
        return (
          record.phase === "bound" &&
          slot &&
          sameOwner(record, slot.owner) &&
          slot.assignments.some(
            (a) => a.deviceId === record.deviceId && a.generation === record.driverGeneration,
          )
        );
      })
    )
      await this.discover();
  }
  async #drain(): Promise<void> {
    await Promise.allSettled(this.#cleanups);
  }
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#stopped = true;
      for (const session of Array.from(this.#sessions.values())) this.#end(session, "cancelled");
      await this.#starting?.catch(() => undefined);
      await this.#drain();
      const native = this.#native;
      this.#native = undefined;
      for (const detach of this.#detachNative.splice(0)) detach();
      await native?.close();
      this.#bindings.clear();
      this.#roster = [];
      this.#revision = -1;
      this.#slots.clear();
      this.#listeners.clear();
      this.#invalidatedSlots.clear();
      this.#changed.clear();
    })();
    return this.#stopping;
  }
}
function safeLabel(value: string): string {
  return (
    value
      .replace(/\p{Cc}/gu, "")
      .trim()
      .slice(0, 120) || "iPhone"
  );
}
