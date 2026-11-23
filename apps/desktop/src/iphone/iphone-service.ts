import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DisplayInputRefusalSchema, displayDataTicketTtlMs } from "@opensteer/protocol";
import { z } from "zod";
import {
  iphoneNativeRosterSchema,
  iphoneNativeDisplayInputResultSchema,
  iphoneNativeDisplayPowerResultSchema,
  iphoneNativeDisplayStartResultSchema,
  type IphoneMediaAttachment,
  type IphoneNativeMessage,
  iphoneScreenshotHiddenReason,
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
import type { IphoneMacSupport } from "./mac-support.js";

const empty = z.strictObject({});
const imageItemSchema = z.strictObject({
  build: z.string(),
  version: z.string().optional(),
});
const imagesResultSchema = z.strictObject({
  images: z.array(imageItemSchema).max(8),
});
const recoverableImageReasons = new Set<string>([
  "developer-image-missing",
  "developer-image-incompatible",
]);
type Candidate = z.infer<typeof iphoneNativeRosterSchema>["candidates"][number];
type Assignment = IphoneRunnerParams<"iphone.targets">["assignments"][number];
type Binding = { token: string; epoch: number; record: IphoneMapping };
type ProbeWork = {
  work: Promise<void>;
  controller: AbortController;
  generation: number;
  localPhoneId: string;
  nativeEpoch: number;
  imageRevision: number;
  rerun: boolean;
};
type Session = {
  key: object;
  binding: Binding;
  sessionId: string;
  runId: string;
  access: "observe" | "control";
  controller: AbortController;
};
type Slot = { owner: IphoneRunnerOwner; assignments: readonly Assignment[]; key: object };
type DisplayParams = Extract<IphoneRunnerParams<IphoneRunnerMethod>, { streamId: string }>;
type DisplayStream = {
  key: object;
  binding: Binding;
  native: IphoneNativeTransport;
  ref: { bindingToken: string; nativeEpoch: number; streamId: string };
  target: { deviceId: string; driverGeneration: number };
  authorized: () => boolean;
  controller: AbortController;
  started: Promise<z.infer<typeof iphoneNativeDisplayStartResultSchema>>;
  token?: string;
  socketPath?: string;
  claimTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  state?: Extract<IphoneNativeMessage, { event: "display.state" }>["displayState"];
  inputSequence: number;
};

function displayRefusal(reason: string | undefined) {
  if (reason === undefined) return {};
  const parsed = DisplayInputRefusalSchema.safeParse(reason);
  return { reason: parsed.success ? parsed.data : ("unavailable" as const) };
}

export interface IphoneServiceOptions {
  readonly store: IphoneStore;
  readonly startNative: () => Promise<{
    client: IphoneNativeTransport;
    images: { build: string; version?: string | undefined }[];
  }>;
  readonly mac?: IphoneMacSupport;
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
  readonly #displays = new Map<string, DisplayStream>();
  readonly #mediaTokens = new Map<string, DisplayStream>();
  readonly #changed = new Set<() => void>();
  readonly #invalidatedSlots = new Set<(deploymentId: string) => void>();
  readonly #listeners = new Set<(deploymentId: string, event: IphoneRunnerEvent) => void>();
  readonly #cleanups = new Set<Promise<unknown>>();
  readonly #wifiWork = new Map<string, Promise<void>>();
  readonly #probeWork = new Map<string, ProbeWork>();
  readonly #probedImageRevision = new Map<string, number>();
  #records: IphoneMapping[] = [];
  #roster: Candidate[] = [];
  #revision = -1;
  #native: IphoneNativeTransport | undefined;
  #starting: Promise<IphoneNativeTransport> | undefined;
  #imageCatalogKey = "";
  #imageRevision = 0;
  #macWatch: (() => void) | undefined;
  #macRefreshWork: Promise<void> | undefined;
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
  get imageRevision(): number {
    return this.#imageRevision;
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
  refreshImages(imageRoots: string[], signal?: AbortSignal): Promise<readonly string[]> {
    return this.#refreshImages(imageRoots, signal);
  }
  async #refreshImages(
    imageRoots: string[],
    signal?: AbortSignal,
    excludeUdid?: string,
  ): Promise<readonly string[]> {
    const native = await this.#connect();
    const { images } = await native.request(
      "images.refresh",
      { imageRoots },
      imagesResultSchema,
      signal ? { signal } : {},
    );
    if (signal?.aborted || native !== this.#native) throw new IphoneServiceError("cancelled");
    const changed = this.#recordImageCatalog(images);
    if (changed) this.#retryRecoverablePhones(excludeUdid);
    return images.map((image) => image.build);
  }
  #recordImageCatalog(images: readonly { build: string; version?: string | undefined }[]): boolean {
    const key = JSON.stringify(images);
    if (key === this.#imageCatalogKey) return false;
    this.#imageCatalogKey = key;
    this.#imageRevision++;
    return true;
  }
  #retryRecoverablePhones(excludeUdid?: string): void {
    if (this.#stopped || this.#suspended || !this.#native) return;
    for (const record of this.#records) {
      if (record.udid === excludeUdid) continue;
      if (
        this.#needsImageRecovery(record) &&
        this.#probedImageRevision.get(record.udid) !== this.#imageRevision
      )
        this.#cleanup(this.#probe(record));
    }
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
    const native = await this.#connect();
    await native.request(
      "setup.prepareDeveloperServices",
      this.#ref(record),
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
        { signal, timeoutMs: 120000 },
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
      if (observation.nativeEpoch !== binding.epoch)
        throw new IphoneServiceError("stale-native-epoch");
      if ("reason" in observation)
        throw new IphoneServiceError(
          observation.reason === "wake-on-phone-required" ? "screen-off" : observation.reason,
        );
      if (observation.state.lock !== "unlocked")
        throw new IphoneServiceError(
          observation.state.lock === "locked" ? "phone-locked" : "lock-state-unknown",
        );
      if (observation.state.display !== "on")
        throw new IphoneServiceError(
          observation.state.display === "off" ? "screen-off" : "screen-state-unknown",
        );
      if (
        observation.geometry.rotation === null ||
        observation.state.rotation !== observation.geometry.rotation ||
        observation.state.displayId !== observation.geometry.displayId
      )
        throw new IphoneServiceError("geometry-unknown");
      if (iphoneScreenshotHiddenReason(observation) || !observation.screenshot)
        throw new IphoneServiceError("screenshot-failed");
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
    if (previous && previous.localPhoneId !== record.localPhoneId)
      this.#invalidate(previous, "phone-disconnected");
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
      this.#cleanup(this.#probe(record));
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
    this.#syncMacWatch();
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
      claimMediaAttachment: (token) => this.#claimMediaAttachment(owner, token),
      connect: (emit) => {
        const key = {};
        let alive = true;
        const listener = (slot: string, event: IphoneRunnerEvent) => {
          if (
            alive &&
            slot === deploymentId &&
            (event.event !== "iphone.displayState" || this.#slots.get(slot)?.key === key)
          )
            emit(event);
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
                this.#cleanup(this.#probe(record));
              this.#syncMacWatch();
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
              for (const record of this.#records)
                if (record.deploymentId === deploymentId) this.#cancelProbe(record.udid);
              this.#syncMacWatch();
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
    if (
      method === "iphone.display.stop" &&
      "streamId" in params &&
      !this.#displays.has(params.streamId)
    )
      return {};
    const maxTimeoutMs = method === "iphone.session.open" ? 120000 : 30000;
    const timeoutMs = Math.min(maxTimeoutMs, Math.floor(options.deadline - Date.now()));
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
    if (
      !("streamId" in params) &&
      method !== "iphone.session.open" &&
      method !== "iphone.installedApps"
    ) {
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
    if (method === "iphone.session.open" || method === "iphone.installedApps")
      this.#cancelProbe(record.udid);
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
            r.setupId === record.setupId &&
            r.localPhoneId === record.localPhoneId &&
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
    const remaining = Math.min(maxTimeoutMs, Math.floor(options.deadline - Date.now()));
    if (remaining <= 0 || options.signal?.aborted)
      throw new IphoneServiceError("deadline-exceeded");
    const callOptions = {
      timeoutMs: remaining,
      ...(options.signal ? { signal: options.signal } : {}),
    };
    if ("streamId" in params)
      return this.#display(
        method,
        params,
        key,
        binding,
        native,
        record.localPhoneId,
        authorized,
        callOptions,
      );
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
        if (binding.epoch !== ref.nativeEpoch)
          for (const display of this.#displays.values())
            if (display.binding === binding) void this.#stopDisplay(display);
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
  async #display(
    method: IphoneRunnerMethod,
    params: DisplayParams,
    key: object,
    binding: Binding,
    native: IphoneNativeTransport,
    localPhoneId: string,
    authorized: () => boolean,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    const { streamId, deviceId, driverGeneration } = params;
    const epoch = binding.epoch;
    const candidate = () => this.#roster.find((c) => c.localPhoneId === localPhoneId);
    const ownsEpoch = () =>
      authorized() && binding.epoch === epoch && candidate()?.nativeEpoch === epoch;
    if (!ownsEpoch()) throw new IphoneServiceError("stale-native-epoch");
    if (method === "iphone.display.start") {
      const conflicts = () =>
        [...this.#displays.values()].filter(
          (entry) => entry.ref.streamId === streamId || entry.binding === binding,
        );
      const stopping = conflicts().flatMap((entry) => (entry.stopping ? [entry.stopping] : []));
      const deadline = Date.now() + options.timeoutMs;
      if (stopping.length) await Promise.all(stopping);
      if (conflicts().length) throw new IphoneServiceError("phone-in-use");
      if (!ownsEpoch()) throw new IphoneServiceError("stale-native-epoch");
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0 || options.signal?.aborted)
        throw new IphoneServiceError("deadline-exceeded");
      const reason = candidate()?.capabilities?.liveVideo;
      if (reason !== null) throw new IphoneServiceError(reason ?? "unsupported");
      const { maxLongSide, maxFps } = iphoneRunnerParams[method].parse(params);
      const ref = { streamId, bindingToken: binding.token, nativeEpoch: epoch };
      // Keep the start receipt so revocation can stop a late native start.
      const started = native.request(
        "display.start",
        { ...ref, maxLongSide, maxFps },
        iphoneNativeDisplayStartResultSchema,
        { timeoutMs },
      );
      const entry: DisplayStream = {
        key,
        binding,
        native,
        ref,
        target: { deviceId, driverGeneration },
        authorized: ownsEpoch,
        controller: new AbortController(),
        started,
        inputSequence: -1,
      };
      this.#displays.set(streamId, entry);
      const cancel = () => {
        void this.#stopDisplay(entry);
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        const { socketPath } = await started;
        if (!ownsEpoch() || entry.controller.signal.aborted || options.signal?.aborted)
          throw new IphoneServiceError("no-session");
        if (!isAbsolute(socketPath)) throw new IphoneServiceError("protocol-unsupported");
        const attachmentToken = randomUUID();
        entry.token = attachmentToken;
        entry.socketPath = socketPath;
        this.#mediaTokens.set(attachmentToken, entry);
        entry.claimTimer = setTimeout(cancel, displayDataTicketTtlMs);
        entry.claimTimer.unref();
        return {
          attachmentToken,
          ...(native.displayDemandActive ? { demandActive: true as const } : {}),
        };
      } catch (error) {
        void this.#stopDisplay(entry);
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
    }
    const current = this.#displays.get(streamId);
    if (!current && method === "iphone.display.stop") return {};
    if (!current || current.binding !== binding || current.key !== key || !current.authorized())
      throw new IphoneServiceError("no-session");
    if (method === "iphone.display.stop") {
      await this.#stopDisplay(current);
      return {};
    }
    if (current.controller.signal.aborted) throw new IphoneServiceError("no-session");
    const ref = current.ref;
    const callOptions = {
      timeoutMs: options.timeoutMs,
      signal: AbortSignal.any([
        current.controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]),
    };
    switch (method) {
      case "iphone.display.demand": {
        const { active, maxLongSide, maxFps } = iphoneRunnerParams[method].parse(params);
        const includeActive = active !== undefined && native.displayDemandActive === true;
        if (!includeActive && maxLongSide === undefined && maxFps === undefined) return {};
        return native.request(
          "display.demand",
          {
            ...ref,
            ...(includeActive ? { active } : {}),
            ...(maxLongSide === undefined ? {} : { maxLongSide }),
            ...(maxFps === undefined ? {} : { maxFps }),
          },
          empty,
          callOptions,
        );
      }
      case "iphone.display.refresh":
        return native.request("display.refresh", ref, empty, callOptions);
      case "iphone.display.inputReset":
        return native.request("display.inputReset", ref, empty, callOptions);
      case "iphone.display.input": {
        const { geometry, sequence, events } = iphoneRunnerParams[method].parse(params);
        if (current.state?.generation !== geometry || sequence <= current.inputSequence)
          return { outcome: "stale", reason: "stale" };
        if (current.state.state !== "live" || candidate()?.capabilities?.act !== null)
          return { outcome: "refused", reason: "unavailable" };
        current.inputSequence = sequence;
        const result = await native.request(
          "display.input",
          { ...ref, geometry, events },
          iphoneNativeDisplayInputResultSchema,
          callOptions,
        );
        if (!current.authorized() || callOptions.signal.aborted)
          throw new IphoneServiceError("no-session");
        return { outcome: result.outcome, ...displayRefusal(result.reason) };
      }
      case "iphone.display.power": {
        if (candidate()?.capabilities?.wake !== null)
          return { outcome: "refused", reason: "unsupported" };
        const { action } = iphoneRunnerParams[method].parse(params);
        const result = await native.request(
          "display.power",
          { ...ref, action },
          iphoneNativeDisplayPowerResultSchema,
          callOptions,
        );
        if (!current.authorized() || callOptions.signal.aborted)
          throw new IphoneServiceError("no-session");
        return { outcome: result.outcome, ...displayRefusal(result.reason) };
      }
      default:
        throw new IphoneServiceError("unsupported");
    }
  }

  #claimMediaAttachment(
    owner: IphoneRunnerOwner,
    token: string,
  ): IphoneMediaAttachment | undefined {
    const entry = this.#mediaTokens.get(token);
    if (
      !entry?.socketPath ||
      entry.controller.signal.aborted ||
      !sameOwner(owner, entry.binding.record) ||
      !entry.authorized()
    )
      return undefined;
    this.#mediaTokens.delete(token);
    clearTimeout(entry.claimTimer);
    return {
      socketPath: entry.socketPath,
      signal: entry.controller.signal,
      close: () => {
        void this.#stopDisplay(entry);
      },
    };
  }

  #stopDisplay(entry: DisplayStream): Promise<void> | undefined {
    if (entry.controller.signal.aborted) return entry.stopping;
    entry.controller.abort();
    clearTimeout(entry.claimTimer);
    if (entry.token) this.#mediaTokens.delete(entry.token);
    // Hold the stream ID until native stop finishes, so a late stop cannot
    // accidentally stop a replacement using the same ID.
    const stopped = entry.started
      .catch(() => undefined)
      .then(async () => {
        if (this.#native === entry.native)
          await entry.native.request("display.stop", entry.ref, empty, { timeoutMs: 2000 });
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.#displays.get(entry.ref.streamId) === entry)
          this.#displays.delete(entry.ref.streamId);
      });
    entry.stopping = stopped;
    this.#cleanup(stopped);
    return stopped;
  }

  #displayState(event: Extract<IphoneNativeMessage, { event: "display.state" }>["displayState"]) {
    const entry = this.#displays.get(event.streamId);
    if (!entry || entry.controller.signal.aborted || !entry.authorized()) return;
    if (entry.state && event.generation < entry.state.generation) return;
    entry.state = event;
    this.#emit(entry.binding.record.deploymentId, {
      kind: "event",
      event: "iphone.displayState",
      params: { ...entry.target, ...event },
    });
    if (event.state === "failed" || event.state === "stopped") void this.#stopDisplay(entry);
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
  #isAssignedBoundRecord(record: IphoneMapping, generation: number): boolean {
    if (
      this.#stopped ||
      this.#suspended ||
      this.#nativeGeneration !== generation ||
      !this.#native ||
      record.phase !== "bound"
    )
      return false;
    const live = this.#records.find(
      (r) =>
        r.udid === record.udid &&
        r.phase === "bound" &&
        r.setupId === record.setupId &&
        r.deviceId === record.deviceId &&
        r.driverGeneration === record.driverGeneration &&
        sameOwner(r, record),
    );
    if (!live) return false;
    const slot = this.#slots.get(record.deploymentId);
    return Boolean(
      slot &&
      sameOwner(record, slot.owner) &&
      slot.assignments.some(
        (a) => a.deviceId === record.deviceId && a.generation === record.driverGeneration,
      ),
    );
  }
  #cancelProbe(udid: string): void {
    const pending = this.#probeWork.get(udid);
    if (!pending) return;
    pending.rerun = false;
    pending.controller.abort();
    this.#probeWork.delete(udid);
  }
  #cancelAllProbes(): void {
    for (const pending of this.#probeWork.values()) {
      pending.rerun = false;
      pending.controller.abort();
    }
    this.#probeWork.clear();
  }
  #probe(record: IphoneMapping): Promise<void> {
    const generation = this.#nativeGeneration;
    if (!this.#isAssignedBoundRecord(record, generation)) return Promise.resolve();
    const candidate = this.#roster.find((c) => c.localPhoneId === record.localPhoneId);
    if (!candidate) return Promise.resolve();
    const pending = this.#probeWork.get(record.udid);
    if (pending) {
      if (
        pending.generation === generation &&
        pending.localPhoneId === candidate.localPhoneId &&
        pending.nativeEpoch === candidate.nativeEpoch &&
        pending.imageRevision === this.#imageRevision
      )
        return pending.work;
      pending.rerun = true;
      if (
        pending.generation !== generation ||
        pending.localPhoneId !== candidate.localPhoneId ||
        pending.nativeEpoch !== candidate.nativeEpoch
      )
        pending.controller.abort();
      return pending.work;
    }
    const controller = new AbortController();
    const entry: ProbeWork = {
      work: Promise.resolve(),
      controller,
      generation,
      localPhoneId: candidate.localPhoneId,
      nativeEpoch: candidate.nativeEpoch,
      imageRevision: this.#imageRevision,
      rerun: false,
    };
    const work = (async () => {
      try {
        if (this.#needsImageRecovery(record) && this.#options.mac) {
          const support = await this.#options.mac.inspect();
          if (controller.signal.aborted || !this.#isAssignedBoundRecord(record, generation)) return;
          await this.#refreshImages(support.imageRoots, controller.signal, record.udid).catch(
            () => undefined,
          );
          if (controller.signal.aborted || !this.#isAssignedBoundRecord(record, generation)) return;
          entry.imageRevision = this.#imageRevision;
        }
        const attemptImageRevision = entry.imageRevision;
        const binding = await this.#binding(record, controller.signal);
        if (controller.signal.aborted || !this.#isAssignedBoundRecord(record, generation)) return;
        const native = await this.#connect();
        if (controller.signal.aborted || !this.#isAssignedBoundRecord(record, generation)) return;
        await native.request("binding.probe", { bindingToken: binding.token }, empty, {
          timeoutMs: 120000,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && this.#isAssignedBoundRecord(record, generation)) {
          this.#probedImageRevision.set(record.udid, attemptImageRevision);
          await this.discover();
        }
      } catch {
        if (!controller.signal.aborted && this.#isAssignedBoundRecord(record, generation))
          this.#probedImageRevision.set(record.udid, entry.imageRevision);
        // Native roster carries the failed probe's typed reason.
      }
    })();
    entry.work = work;
    this.#probeWork.set(record.udid, entry);
    void work
      .finally(() => {
        if (this.#probeWork.get(record.udid) === entry) this.#probeWork.delete(record.udid);
        if (entry.rerun && !this.#stopped && !this.#suspended) {
          const latest = this.#records.find((r) => r.udid === record.udid && r.phase === "bound");
          if (latest && this.#isAssignedBoundRecord(latest, this.#nativeGeneration))
            this.#cleanup(this.#probe(latest));
        }
        this.#syncMacWatch();
      })
      .catch(() => undefined);
    return work;
  }
  #needsImageRecovery(record: IphoneMapping): boolean {
    if (!this.#isAssignedBoundRecord(record, this.#nativeGeneration)) return false;
    const candidate = this.#roster.find((c) => c.localPhoneId === record.localPhoneId);
    const reason = candidate?.reason ?? candidate?.capabilities?.observe ?? null;
    return reason !== null && recoverableImageReasons.has(reason);
  }
  #stopMacWatch(): void {
    this.#macWatch?.();
    this.#macWatch = undefined;
  }
  #syncMacWatch(): void {
    if (this.#stopped || this.#suspended || !this.#options.mac || !this.#native) {
      this.#stopMacWatch();
      return;
    }
    const needed = this.#records.some((record) => this.#needsImageRecovery(record));
    if (needed && !this.#macWatch) {
      this.#macWatch = this.#options.mac.watch(() => {
        void this.#handleMacImageChange();
      });
    } else if (!needed && this.#macWatch) {
      this.#stopMacWatch();
    }
  }
  #handleMacImageChange(): Promise<void> {
    if (this.#macRefreshWork) return this.#macRefreshWork;
    const work = (async () => {
      if (this.#stopped || this.#suspended || !this.#options.mac || !this.#native) return;
      const support = await this.#options.mac.inspect();
      if (this.#stopped || this.#suspended || !this.#native) return;
      await this.#refreshImages(support.imageRoots).catch(() => null);
      this.#retryRecoverablePhones();
    })();
    this.#macRefreshWork = work;
    this.#cleanup(work);
    void work
      .finally(() => {
        if (this.#macRefreshWork === work) this.#macRefreshWork = undefined;
      })
      .catch(() => undefined);
    return work;
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
      // Keep binding.acquire alive so a late token reply is always received and released on abort.
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
      );
      const binding = { token: result.bindingToken, epoch: ref.nativeEpoch, record };
      if (this.#stopped || this.#native !== native)
        throw new IphoneServiceError("phone-disconnected");
      if (signal?.aborted) {
        await native
          .request("binding.release", { bindingToken: result.bindingToken, forget: false }, empty, {
            timeoutMs: 2000,
          })
          .catch(() => undefined);
        throw new IphoneServiceError("cancelled");
      }
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
    for (const display of this.#displays.values())
      if (display.binding === binding) await this.#stopDisplay(display);
    if (this.#bindings.get(record.udid) !== binding) return;
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
    for (const display of this.#displays.values())
      if (display.key === key) void this.#stopDisplay(display);
    for (const session of Array.from(this.#sessions.values()))
      if (session.key === key) this.#end(session, "no-session");
  }
  #invalidate(
    record: IphoneMapping,
    reason: "cancelled" | "no-session" | "phone-disconnected",
  ): void {
    this.#cancelProbe(record.udid);
    for (const display of this.#displays.values())
      if (display.binding.record.udid === record.udid) void this.#stopDisplay(display);
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
    // Setup's own inspections bump the revision; only a content change is news.
    const changed = JSON.stringify(roster.candidates) !== JSON.stringify(this.#roster);
    this.#roster = roster.candidates;
    this.#revision = roster.revision;
    if (changed) for (const listener of this.#changed) listener();
    for (const record of probe) this.#cleanup(this.#probe(record));
    this.#syncMacWatch();
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
      this.#imageCatalogKey = JSON.stringify(result.images);
      this.#imageRevision++;
      this.#probedImageRevision.clear();
      this.#detachNative = [
        result.client.onGap?.(() => {
          for (const record of this.#records) this.#invalidate(record, "phone-disconnected");
          this.#roster = [];
          this.#revision = -1;
        }) ?? (() => undefined),
        result.client.onEvent((event) => {
          if (event.event === "roster.changed") this.#reconcile(event.roster);
          else this.#displayState(event.displayState);
        }),
        result.client.onLost(() => {
          if (this.#native !== result.client) return;
          this.#stopMacWatch();
          this.#cancelAllProbes();
          for (const record of this.#records) this.#invalidate(record, "phone-disconnected");
          this.#native = undefined;
          this.#roster = [];
          this.#revision = -1;
          this.#bindings.clear();
          this.#probedImageRevision.clear();
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
    this.#syncMacWatch();
    await this.#drain();
  }
  suspend(): void {
    this.#suspended = true;
    this.#stopMacWatch();
    this.#cancelAllProbes();
    this.#nativeGeneration++;
    for (const detach of this.#detachNative.splice(0)) detach();
    for (const record of this.#records) this.#invalidate(record, "phone-disconnected");
    const native = this.#native;
    this.#native = undefined;
    this.#bindings.clear();
    this.#probedImageRevision.clear();
    this.#imageCatalogKey = "";
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
      this.#stopMacWatch();
      this.#cancelAllProbes();
      for (const display of this.#displays.values()) void this.#stopDisplay(display);
      for (const session of Array.from(this.#sessions.values())) this.#end(session, "cancelled");
      await this.#starting?.catch(() => undefined);
      await this.#drain();
      const native = this.#native;
      this.#native = undefined;
      for (const detach of this.#detachNative.splice(0)) detach();
      await native?.close();
      this.#bindings.clear();
      this.#probedImageRevision.clear();
      this.#imageCatalogKey = "";
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
