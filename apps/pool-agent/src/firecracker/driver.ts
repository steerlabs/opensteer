/**
 * The Firecracker v1.18.0 driver. Every VMM runs under the jailer: its own chroot on the
 * encrypted saved-state array, the slot's unprivileged user, the slot's network namespace, a
 * new PID namespace, and a cgroup with CPU, memory and task limits under the agent's delegated
 * subtree. Memory and device state go only to that array; the profile disk is bind-mounted
 * from durable storage. Restores are the stock file-backed load with transparent huge pages.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chown,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setFileMode, syncDirectory } from "@opensteer/shared/privateFiles";
import type {
  GuestBoot,
  GuestProcessState,
  HypervisorDriver,
  SavedFile,
  SavedImage,
  SlotEgress,
} from "../driver.js";
import { slotKey } from "../agent.js";
import { firecrackerApi } from "./api.js";
import { GuestCgroups } from "./cgroup.js";
import { requireEncryptedArray } from "./array.js";
import { confine } from "./paths.js";
import { SpaceLedger } from "./space.js";
import { SlotNumbers } from "./slot-numbers.js";
import type { BrowserPoolAgentGuestSpec } from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import {
  defineEgress,
  egressSocket,
  ensureEgressUser,
  removeEgress,
  sleepEgress,
  type EgressProgram,
} from "./egress.js";
import { run, runUntil } from "./exec.js";
import {
  applyHostTable,
  hostAddresses,
  applySetupTable,
  hostTablePresent,
  hostVeth,
  namespaceName,
  namespaceTablesPresent,
  guestMac,
  prepareNamespace,
  bridgePort,
  vethAddresses,
  proxyAddress,
  proxyPort,
  removeNamespace,
  setGate,
  tapName,
  type NetworkConfig,
} from "./network.js";
import { helperCall, waitForHelper } from "./vsock.js";

export interface FirecrackerDriverConfig {
  readonly firecracker: string;
  readonly jailer: string;
  /** vmlinux, rootfs.ext4 and manifest.json, on the saved-state array (for reflinks). */
  readonly images: string;
  /** The jailer's chroot base, on the saved-state array. */
  readonly jailRoot: string;
  /** Saved images, on the saved-state array. */
  readonly savedRoot: string;
  /** The driver's own small state (slot numbers), on durable disk. */
  readonly stateDirectory: string;
  /**
   * On the array itself, written by host setup when the array was created and keyed; it is
   * gone with the array's key after a reboot. The agent refuses to start without it.
   */
  readonly arrayIdFile: string;
  readonly cgroupBase?: string | undefined;
  /** Every slot's profile disk is inside this directory (review G9). */
  readonly profilesRoot: string;
  /** Every slot's egress credential file is inside this directory. */
  readonly credentialsRoot: string;
  /** Each slot gets uid/gid `slotUidBase + index` for its VMM and `egressUidBase + index` for its proxy. */
  readonly slotUidBase: number;
  readonly egressUidBase: number;
  readonly egress: EgressProgram;
  readonly network: NetworkConfig;
  /** `runtime` boots our browser runtime; `bench` boots the measurement's Chromium workload. */
  readonly guestMode: "runtime" | "bench";
  /** The 8250 serial console; off in production (the guest could fill the host's stdout). */
  readonly serialConsole?: boolean;
  /** Each slot proxy's refusals go to the journal (diagnostics). */
  readonly egressLog?: boolean;
}

const execName = "firecracker";
/** The host check reads what became of the `kvm-pit` threads here. */
const pitStateFile = "/run/opensteer-pool/kvm-pit.json";
const minimumFreeMarginBytes = 512 * 1024 * 1024;

export class FirecrackerDriver implements HypervisorDriver {
  readonly startsEmpty = true;
  readonly #config: FirecrackerDriverConfig;
  #cgroups!: GuestCgroups;
  #numbers!: SlotNumbers;
  #fingerprint = "";
  #arrayId: string | undefined;
  #hostAddresses: readonly string[] = [];
  readonly #space = new SpaceLedger();

  readonly #log: (event: Readonly<Record<string, unknown>>) => void;

  constructor(
    config: FirecrackerDriverConfig,
    log: (event: Readonly<Record<string, unknown>>) => void = () => {},
  ) {
    this.#log = log;
    this.#config = config;
  }

  /** Delegates the cgroup subtree, applies the host filter, and fingerprints this host. */
  async open(): Promise<void> {
    this.#cgroups = await GuestCgroups.delegate(this.#config.cgroupBase);
    this.#numbers = new SlotNumbers(this.#config.stateDirectory);
    await this.#numbers.load();
    // Review G3: never write guest memory anywhere but the encrypted array.
    this.#arrayId = await requireEncryptedArray(this.#config);
    this.#hostAddresses = await hostAddresses();
    await applyHostTable(this.#config.network);
    this.#fingerprint = await this.#computeFingerprint();
  }

  async incarnation(): Promise<string> {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!this.#arrayId) throw new Error("The driver was not opened on the saved-state array.");
    return `${boot}/${this.#arrayId}`;
  }

  async fingerprint(): Promise<string> {
    return this.#fingerprint;
  }

  /** Review G4(a): the host table is re-applied when a flush or a reload removed it. */
  async ensureHost(): Promise<boolean> {
    if (await hostTablePresent()) return false;
    this.#hostAddresses = await hostAddresses();
    await applyHostTable(this.#config.network);
    await applySetupTable(this.#config.network);
    return true;
  }

  async confineGuest(guest: BrowserPoolAgentGuestSpec): Promise<void> {
    await confine(guest.profilePath, this.#config.profilesRoot, "profile");
    const egress = guest.egress;
    if (egress)
      for (const file of [egress.usernameFile, egress.passwordFile, egress.caFile])
        if (file) await confine(file, this.#config.credentialsRoot, "credential");
  }

  // ---- Network ------------------------------------------------------------------------------

  /** Slots whose namespace, veth, host user and proxy socket were found or made. */
  readonly #present = new Set<number>();
  /** Present slots whose namespace tables were also read since this agent started. */
  readonly #verified = new Set<number>();

  /** Re-check finding 3: three bulk reads, no repair, no per-slot command. */
  async prepareSlots(
    slots: readonly { readonly slotId: string; readonly egress: SlotEgress | undefined }[],
  ): Promise<void> {
    const [namespaces, links, passwd, sockets] = await Promise.all([
      run("ip", ["netns", "list"]),
      run("ip", ["-o", "link", "show"]),
      readFile("/etc/passwd", "utf8"),
      run("systemctl", [
        "list-units",
        "opensteer-pool-egress-*.socket",
        "--state=active",
        "--plain",
        "--no-legend",
      ]),
    ]);
    const names = new Set(namespaces.split("\n").map((line) => line.split(" ")[0]));
    const users = new Set(passwd.split("\n").map((line) => line.split(":")[2]));
    for (const { slotId } of slots) {
      const index = this.#numbers.get(slotId);
      if (
        index !== undefined &&
        names.has(namespaceName(index)) &&
        links.includes(` ${hostVeth(index)}@`) &&
        users.has(String(this.#config.egressUidBase + index)) &&
        sockets.includes(egressSocket(index))
      )
        this.#present.add(index);
    }
  }

  async prepareSlot(slotId: string, egress: SlotEgress | undefined): Promise<void> {
    const known = this.#numbers.get(slotId);
    if (known !== undefined && this.#verified.has(known)) return;
    // Only the number and the host user (/etc/passwd) are made under the host-wide lock; a
    // failure releases a newly allocated number again.
    const index = await this.#numbers.allocate(slotId, (index) =>
      ensureEgressUser(index, this.#config.egressUidBase + index),
    );
    if (!this.#present.has(index) || !(await namespaceTablesPresent(index))) {
      await prepareNamespace(index, this.#uid(index), this.#config.network, this.#hostAddresses);
      await defineEgress(
        { ...this.#config.egress, debug: this.#config.egressLog === true },
        index,
        this.#config.egressUidBase + index,
        egress,
      );
      this.#present.add(index);
    }
    this.#verified.add(index);
  }

  async removeSlot(slotId: string): Promise<void> {
    // The number is freed only after everything that used it is gone.
    await this.#numbers.release(slotId, async (index) => {
      this.#verified.delete(index);
      this.#present.delete(index);
      await removeEgress(index);
      await removeNamespace(index);
    });
  }

  bridgeTarget(slotId: string): { readonly host: string; readonly port: number } {
    // The namespace side of the slot's veth; its DNAT rule forwards the port to the guest.
    return { host: vethAddresses(this.#require(slotId)).inside, port: bridgePort };
  }

  async openNetwork(slotId: string): Promise<void> {
    const index = this.#require(slotId);
    // The proxy's socket accepts already; systemd starts its process at the guest's first
    // connection (a paused guest's never stopped), so nothing here waits for it.
    await setGate(index, true);
  }

  async closeNetwork(slotId: string): Promise<void> {
    await setGate(this.#require(slotId), false);
  }

  // ---- VMM lifecycle ------------------------------------------------------------------------

  async boot(boot: GuestBoot, signal: AbortSignal): Promise<void> {
    // Re-check finding 8: the proxy is started by its socket at the guest's first connection,
    // never here, so nothing on the way to the first reply competes with a Node start.
    const index = this.#require(boot.slotId);
    const root = await this.#prepareJail(boot, index);
    await this.#jail(boot, index, signal);
    const socket = join(root, "api.sock");
    await this.#waitForApi(socket, signal);
    const api = (method: "PUT" | "PATCH", path: string, body: unknown) =>
      firecrackerApi(socket, method, path, body);
    await api("PUT", "/machine-config", {
      vcpu_count: boot.vcpus,
      mem_size_mib: boot.memoryMib,
      smt: false,
      track_dirty_pages: false,
      huge_pages: "Transparent",
    });
    await api("PUT", "/boot-source", {
      kernel_image_path: "/vmlinux",
      boot_args: this.#bootArgs(boot),
    });
    await api("PUT", "/drives/rootfs", {
      drive_id: "rootfs",
      path_on_host: "/rootfs.ext4",
      is_root_device: true,
      is_read_only: true,
    });
    // Writeback: a flush in the guest is an fsync on the host, so the profile is durable.
    await api("PUT", "/drives/profile", {
      drive_id: "profile",
      path_on_host: "/profile.ext4",
      is_root_device: false,
      is_read_only: false,
      cache_type: "Writeback",
    });
    await api("PUT", "/network-interfaces/eth0", {
      iface_id: "eth0",
      host_dev_name: tapName,
      guest_mac: guestMac,
    });
    await api("PUT", "/vsock", { guest_cid: 3, uds_path: "/v.sock" });
    await api("PUT", "/entropy", {});
    await api("PUT", "/actions", { action_type: "InstanceStart" });
    await this.#adoptPit(boot);
    await waitForHelper(join(root, "v.sock"), signal);
  }

  async sync(_slotId: string, jailId: string, signal: AbortSignal): Promise<void> {
    await helperCall(join(this.#root(jailId), "v.sock"), { kind: "sync" }, signal);
  }

  async pause(_slotId: string, jailId: string): Promise<void> {
    await firecrackerApi(join(this.#root(jailId), "api.sock"), "PATCH", "/vm", { state: "Paused" });
  }

  async resume(_slotId: string, jailId: string): Promise<void> {
    await firecrackerApi(join(this.#root(jailId), "api.sock"), "PATCH", "/vm", {
      state: "Resumed",
    });
  }

  async stepClock(_slotId: string, jailId: string, signal: AbortSignal): Promise<void> {
    await helperCall(join(this.#root(jailId), "v.sock"), { kind: "time" }, signal);
  }

  async deliverToken(
    _slotId: string,
    jailId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    await helperCall(join(this.#root(jailId), "v.sock"), { kind: "token", token }, signal);
  }

  async saveRoom(_slotId: string, jailId: string): Promise<boolean> {
    const memoryBytes = await this.#memoryBytes(jailId);
    const space = await statfs(this.#config.savedRoot);
    return this.#space.fits(space.bavail * space.bsize, memoryBytes + minimumFreeMarginBytes);
  }

  async snapshot(
    slotId: string,
    jailId: string,
    savedStateId: string,
    signal: AbortSignal,
  ): Promise<SavedImage> {
    const root = this.#root(jailId);
    const began = performance.now();
    const memoryBytes = await this.#memoryBytes(jailId);
    const space = await statfs(this.#config.savedRoot);
    // Review G10: concurrent saves reserve their space before they write.
    const release = this.#space.reserve(
      space.bavail * space.bsize,
      memoryBytes + minimumFreeMarginBytes,
    );
    try {
      return await this.#writeSnapshot(slotId, jailId, savedStateId, signal, root, began);
    } finally {
      release();
    }
  }

  async #writeSnapshot(
    slotId: string,
    jailId: string,
    savedStateId: string,
    signal: AbortSignal,
    root: string,
    began: number,
  ): Promise<SavedImage> {
    const partial = async () => {
      for (const name of ["vmstate", "memory"]) await rm(join(root, "snap", name), { force: true });
    };
    try {
      await firecrackerApi(
        join(root, "api.sock"),
        "PUT",
        "/snapshot/create",
        { snapshot_type: "Full", snapshot_path: "/snap/vmstate", mem_file_path: "/snap/memory" },
        600_000,
      );
    } catch (error) {
      // Re-check finding 9: a snapshot that failed part way (a full array) leaves no files.
      await partial();
      throw error;
    }
    // The caller gave up on this snapshot: its files are deleted unpublished, never moved to
    // where an image is looked for (the agent also waits for this call before releasing).
    if (signal.aborted) {
      await partial();
      throw new Error("The snapshot finished after its deadline and was not kept.");
    }
    const target = this.#savedDirectory(slotId, savedStateId);
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of ["vmstate", "memory"]) {
      await rename(join(root, "snap", name), join(target, name));
      await chown(join(target, name), 0, 0);
      await setFileMode(join(target, name), 0o400);
    }
    await syncDirectory(target);
    const files: SavedFile[] = [];
    for (const name of ["vmstate", "memory"])
      files.push(await describe(join(target, name), name === "vmstate"));
    return {
      savedStateId,
      sourceJailId: jailId,
      files,
      fingerprint: this.#fingerprint,
      writtenAt: new Date().toISOString(),
      writeMs: Math.round(performance.now() - began),
    };
  }

  async restore(boot: GuestBoot, image: SavedImage, signal: AbortSignal): Promise<void> {
    const index = this.#require(boot.slotId);
    if (!(await this.verify(boot.slotId, image)))
      throw new Error("The saved image changed or is not loadable here.");
    const root = await this.#prepareJail(boot, index);
    const source = this.#savedDirectory(boot.slotId, image.savedStateId);
    const uid = this.#uid(index);
    for (const name of ["vmstate", "memory"]) {
      await rename(join(source, name), join(root, "snap", name));
      await chown(join(root, "snap", name), uid, uid);
    }
    await rm(source, { recursive: true, force: true });
    await this.#jail(boot, index, signal);
    const socket = join(root, "api.sock");
    await this.#waitForApi(socket, signal);
    await firecrackerApi(
      socket,
      "PUT",
      "/snapshot/load",
      {
        snapshot_path: "/snap/vmstate",
        mem_backend: { backend_type: "File", backend_path: "/snap/memory" },
        track_dirty_pages: false,
        resume_vm: false,
        // No clock_realtime: on the second real-host run Firecracker refused a restore under
        // load ("clock_realtime requested but not present in the snapshot state": KVM records
        // the realtime clock only while the host's master clock is stable), and a failed load
        // ends the VMM with the guest's live state. The guest's wall clock is stepped from the
        // host over vsock before any traffic instead.
        huge_pages: "Transparent",
      },
      60_000,
    );
    await this.#adoptPit(boot);
    // Consumed: the names are gone; the mapping keeps the memory until this VMM ends.
    await rm(join(root, "snap", "vmstate"), { force: true });
    await rm(join(root, "snap", "memory"), { force: true });
  }

  async verify(slotId: string, image: SavedImage): Promise<boolean> {
    if (image.fingerprint !== this.#fingerprint) return false;
    const directory = this.#savedDirectory(slotId, image.savedStateId);
    for (const expected of image.files) {
      const found = await describe(join(directory, expected.name), expected.sha256 !== null).catch(
        () => null,
      );
      if (
        !found ||
        found.size !== expected.size ||
        found.inode !== expected.inode ||
        found.mtimeNs !== expected.mtimeNs ||
        found.ctimeNs !== expected.ctimeNs ||
        found.sha256 !== expected.sha256
      )
        return false;
    }
    return true;
  }

  async discard(slotId: string, savedStateId: string): Promise<void> {
    await rm(this.#savedDirectory(slotId, savedStateId), { recursive: true, force: true });
  }

  async inspect(slotId: string, jailId: string): Promise<GuestProcessState> {
    const pid = Number(
      (await readFile(join(this.#root(jailId), `${execName}.pid`), "utf8").catch(() => "")).trim(),
    );
    if (!Number.isInteger(pid) || pid <= 1) return "absent";
    if (!(await this.#cgroups.owns(slotKey(slotId), jailId, pid))) return "absent";
    try {
      const info = (await firecrackerApi(
        join(this.#root(jailId), "api.sock"),
        "GET",
        "/",
        undefined,
        1_000,
      )) as {
        state?: string;
      };
      if (info.state === "Running") return "running";
      if (info.state === "Paused") return "paused";
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  async kill(slotId: string, signal: AbortSignal): Promise<void> {
    const key = slotKey(slotId);
    const ended = await this.#cgroups.kill(key, signal);
    // No VMM, no proxy process: a slot parked on disk or stopped keeps only its socket. Only an
    // ended VMM can have had its proxy started (re-check finding 8): a resume from disk, whose
    // VMM ended when it was saved, does not stop it again.
    const index = this.#numbers.get(slotId);
    if (ended && index !== undefined) await sleepEgress(index);
    for (const jail of await this.#jails(key)) await this.#removeJail(jail);
  }

  async sweep(
    known: ReadonlyMap<string, { jailId: string | null; savedStateId: string | null }>,
  ): Promise<readonly string[]> {
    const byKey = new Map([...known].map(([slotId, value]) => [slotKey(slotId), value]));
    const removed: string[] = [];
    for (const key of await this.#cgroups.slotKeys()) {
      const slot = byKey.get(key);
      for (const jailId of await this.#cgroups.jailIds(key)) {
        if (slot?.jailId === jailId) continue;
        await this.#cgroups.kill(key, AbortSignal.timeout(15_000), jailId);
        removed.push(`process:${jailId}`);
      }
    }
    for (const jail of await readdir(join(this.#config.jailRoot, execName)).catch(() => [])) {
      const key = jail.split("-")[0]!;
      if (byKey.get(key)?.jailId === jail) continue;
      await this.#removeJail(jail);
      removed.push(`jail:${jail}`);
    }
    for (const key of await readdir(this.#config.savedRoot).catch(() => [])) {
      for (const id of await readdir(join(this.#config.savedRoot, key)).catch(() => [])) {
        if (byKey.get(key)?.savedStateId === id) continue;
        await rm(join(this.#config.savedRoot, key, id), { recursive: true, force: true });
        removed.push(`image:${id}`);
      }
    }
    return removed;
  }

  // ---- Jails --------------------------------------------------------------------------------

  #root(jailId: string): string {
    return join(this.#config.jailRoot, execName, jailId, "root");
  }

  #savedDirectory(slotId: string, savedStateId: string): string {
    if (!/^[0-9a-f-]{36}$/u.test(savedStateId)) throw new Error("A saved state id is malformed.");
    return join(this.#config.savedRoot, slotKey(slotId), savedStateId);
  }

  async #jails(key: string): Promise<readonly string[]> {
    const entries = await readdir(join(this.#config.jailRoot, execName)).catch(() => []);
    return entries.filter((name) => name.startsWith(`${key}-`));
  }

  /** A fresh chroot: reflinked kernel and root image (own page cache), the profile bound in. */
  async #prepareJail(boot: GuestBoot, index: number): Promise<string> {
    const root = this.#root(boot.jailId);
    await rm(join(this.#config.jailRoot, execName, boot.jailId), { recursive: true, force: true });
    await mkdir(root, { recursive: true, mode: 0o755 });
    for (const name of ["vmlinux", "rootfs.ext4"])
      await run("cp", ["--reflink=always", join(this.#config.images, name), join(root, name)], {
        timeoutMs: 30_000,
      });
    const uid = this.#uid(index);
    // Checked again where it is used: the path may have changed since the slot was created.
    const profile = await confine(boot.profilePath, this.#config.profilesRoot, "profile");
    await chown(profile, uid, uid);
    await setFileMode(profile, 0o600);
    await writeFile(join(root, "profile.ext4"), "");
    await run("mount", ["--bind", profile, join(root, "profile.ext4")]);
    await mkdir(join(root, "snap"), { mode: 0o700 });
    await chown(join(root, "snap"), uid, uid);
    return root;
  }

  /**
   * Review G6(d), Firecracker's production guide: the VMM's `kvm-pit/<pid>` kernel thread runs
   * in the root cgroup unless moved; it is moved into the VMM's own cgroup so its CPU counts
   * against the guest. Best effort: a kernel that refuses the move is reported, not fatal.
   */
  async #adoptPit(boot: GuestBoot): Promise<void> {
    const pid = (await readFile(join(this.#root(boot.jailId), `${execName}.pid`), "utf8")).trim();
    // The thread is named after the VMM's pid as the VMM sees it: in its own pid namespace
    // (the jailer's --new-pid-ns) every VMM is 1. It is found instead as the kvm-pit thread still
    // in the root cgroup that started after this VMM; two such (concurrent boots) are ambiguous,
    // and nothing is moved rather than the wrong one.
    const started = await processStart(pid);
    const threads = await run("ps", ["-e", "-o", "pid=,comm="]);
    const candidates: string[] = [];
    for (const [thread, comm] of threads.split("\n").map((line) => line.trim().split(/\s+/u))) {
      if (!thread || !comm?.startsWith("kvm-pit/")) continue;
      const cgroup = await readFile(`/proc/${thread}/cgroup`, "utf8").catch(() => "");
      if (cgroup.trim() !== "0::/") continue;
      if ((await processStart(thread).catch(() => -1)) >= started) candidates.push(thread);
    }
    if (candidates.length === 0) return this.#pit("absent", undefined);
    if (candidates.length > 1) return this.#pit("ambiguous", undefined);
    await this.#cgroups.adopt(slotKey(boot.slotId), boot.jailId, candidates[0]!).then(
      () => this.#pit("adopted", undefined),
      (error: unknown) => this.#pit("refused", error),
    );
  }

  /** What became of each VMM's `kvm-pit` thread since the agent started. */
  readonly pit = { adopted: 0, refused: 0, absent: 0, ambiguous: 0, last: null as string | null };

  #pit(outcome: "adopted" | "refused" | "absent" | "ambiguous", error: unknown): void {
    this.pit[outcome] += 1;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : undefined;
    if (outcome === "refused") this.pit.last = code ?? message ?? "unknown";
    this.#log({
      event: "kvm-pit",
      outcome,
      ...(code ? { code } : {}),
      ...(message ? { message } : {}),
    });
    void writeFile(pitStateFile, `${JSON.stringify(this.pit)}\n`, { mode: 0o644 }).catch(
      () => undefined,
    );
  }

  async #removeJail(jailId: string): Promise<void> {
    const directory = join(this.#config.jailRoot, execName, jailId);
    const profile = join(directory, "root", "profile.ext4");
    // The profile is unbound first, so removing the jail can never reach the profile.
    for (let attempt = 0; attempt < 8 && (await mounted(profile)); attempt += 1)
      await run("umount", [profile], { allow: [32] });
    if (await mounted(profile))
      throw new Error(`The profile of ${jailId} is still mounted in its jail.`);
    await rm(directory, { recursive: true, force: true });
  }

  async #jail(boot: GuestBoot, index: number, signal: AbortSignal): Promise<void> {
    const uid = this.#uid(index);
    const parent = await this.#cgroups.slotParent(slotKey(boot.slotId));
    // Twice the guest memory plus the VMM's own. The guest cannot use more than its memory, but
    // page cache is charged to this cgroup: a save writes the whole memory file through it, and
    // a restored guest maps that file. At guest + 512 MiB a save under contention was killed by
    // the memory cgroup (measured on the first real-host run).
    const memoryBytes = (boot.memoryMib * 2 + 512) * 1024 * 1024;
    // Review G6(b): memory.high reclaims and slows a writer (a save's page cache) before
    // memory.max would end it; it sits where the guest and the VMM's own use end.
    const memoryHigh = (boot.memoryMib + 512) * 1024 * 1024;
    // Review G6(d): no file the VMM writes may grow past what it needs: its memory file, or its
    // profile disk, whichever is larger (a write past the limit inside the profile would fail).
    const profileBytes = (await stat(boot.profilePath)).size;
    const fileLimit = Math.max(boot.memoryMib * 1024 * 1024, profileBytes) + 64 * 1024 * 1024;
    const pidFile = join(this.#root(boot.jailId), `${execName}.pid`);
    await runUntil(
      this.#config.jailer,
      [
        "--id",
        boot.jailId,
        "--exec-file",
        this.#config.firecracker,
        "--uid",
        String(uid),
        "--gid",
        String(uid),
        "--chroot-base-dir",
        this.#config.jailRoot,
        "--netns",
        `/run/netns/osp${index}`,
        "--cgroup-version",
        "2",
        "--parent-cgroup",
        parent,
        "--cgroup",
        `memory.max=${memoryBytes}`,
        "--cgroup",
        `memory.high=${memoryHigh}`,
        "--cgroup",
        `cpu.max=${boot.vcpus * 100_000} 100000`,
        "--cgroup",
        "pids.max=256",
        "--resource-limit",
        "no-file=1024",
        "--resource-limit",
        `fsize=${fileLimit}`,
        "--new-pid-ns",
        "--daemonize",
        "--",
        "--api-sock",
        "/api.sock",
        "--level",
        "Warning",
      ],
      () =>
        stat(pidFile).then(
          () => true,
          () => false,
        ),
      15_000,
    );
    if (signal.aborted) throw new Error("The guest start ran out of time.");
  }

  async #waitForApi(socket: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await firecrackerApi(socket, "GET", "/", undefined, 1_000);
        return;
      } catch (error) {
        if (signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }

  async #memoryBytes(jailId: string): Promise<number> {
    const config = (await firecrackerApi(
      join(this.#root(jailId), "api.sock"),
      "GET",
      "/machine-config",
    )) as {
      mem_size_mib?: number;
    };
    return (config.mem_size_mib ?? 0) * 1024 * 1024;
  }

  #bootArgs(boot: GuestBoot): string {
    const console = this.#config.serialConsole
      ? "console=ttyS0 opensteer.debug=1"
      : "8250.nr_uarts=0";
    const parameters = Object.entries(boot.parameters).map(([key, value]) => {
      if (!/^[A-Za-z0-9._-]+$/u.test(key) || !/^[A-Za-z0-9+/=._:-]+$/u.test(value))
        throw new Error("A guest boot parameter is not a plain token.");
      return `${key}=${value}`;
    });
    return [
      console,
      "quiet loglevel=1 reboot=k panic=1 pci=off ro",
      "clocksource=kvm-clock",
      "init=/opensteer/init",
      `opensteer.mode=${this.#config.guestMode}`,
      // The one non-loopback proxy a pooled runtime accepts: its slot's, on the TAP's host side.
      `opensteer.pool.proxy=${proxyAddress}:${proxyPort}`,
      ...parameters,
    ].join(" ");
  }

  // ---- Slot numbers ---------------------------------------------------------------------------

  #uid(index: number): number {
    return this.#config.slotUidBase + index;
  }

  #require(slotId: string): number {
    const index = this.#numbers.get(slotId);
    if (index === undefined) throw new Error("The driver has no network for this slot.");
    return index;
  }

  async #computeFingerprint(): Promise<string> {
    const hash = createHash("sha256");
    for (const file of [this.#config.firecracker, this.#config.jailer])
      hash.update(await sha256(file));
    hash.update(await readFile(join(this.#config.images, "manifest.json")));
    hash.update((await readFile("/proc/sys/kernel/osrelease", "utf8")).trim());
    const cpu = await readFile("/proc/cpuinfo", "utf8");
    for (const field of ["model name", "microcode", "flags"])
      hash.update(cpu.split("\n").find((line) => line.startsWith(field)) ?? "");
    return hash.digest("hex");
  }
}

async function describe(path: string, hashed: boolean): Promise<SavedFile> {
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error("A saved file is not a regular file.");
  return {
    name: path.split("/").at(-1)!,
    size: Number(info.size),
    inode: Number(info.ino),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    sha256: hashed ? await sha256(path) : null,
  };
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function mounted(path: string): Promise<boolean> {
  const table = await readFile("/proc/self/mountinfo", "utf8");
  return table.split("\n").some((line) => line.split(" ")[4] === path);
}

/** A process's start time in clock ticks since boot (field 22 of /proc/<pid>/stat). */
async function processStart(pid: string): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}
