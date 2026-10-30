import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tryKernelLock } from "@opensteer/shared/kernelLock";
import {
  addRunIds,
  addRunIdsFromReads,
  reclaimVmStorage,
  referencedRunIds,
  releaseReferenceCheck,
} from "../scripts/test-vm/retention.js";

const roots: string[] = [];
const sha = (n: number) => n.toString(16).padStart(40, "0");
const now = Date.now();
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "storage-retention-")));
  roots.push(root);
  const state = path.join(root, "state");
  const cache = path.join(root, "cache");
  mkdirSync(state);
  mkdirSync(cache);
  const log: string[] = [];
  const options = {
    state,
    cache,
    tartVms: path.join(root, "vms"),
    now,
    vms: async () => [],
    running: async () => false,
    deleteVm: async () => undefined,
    log: (line: string) => log.push(line),
    storage: { mainSha: sha(1), installedVersion: "0.1.1" as string | null, keepPayloads: 2 },
  };
  const payload = (n: number, used: number) => {
    const target = path.join(cache, sha(n));
    mkdirSync(target);
    writeFileSync(path.join(target, "payload.tar"), Buffer.alloc(4096));
    writeFileSync(path.join(target, "last-used"), "");
    utimesSync(path.join(target, "last-used"), used / 1000, used / 1000);
    return target;
  };
  const release = (n: number) => {
    const directory = path.join(state, `release-0.1.${n}-local`, sha(n + 20));
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "release.json"),
      JSON.stringify({ identity: { version: `0.1.${n}`, sourceRevision: sha(n + 20) } }),
    );
    return directory;
  };
  return { root, state, cache, log, options, payload, release };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage retention safety", () => {
  it("keeps last N uses, main, last two release payloads, held locks and native-resources", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    // A future release's gate directory has no published identity yet.
    mkdirSync(path.join(f.state, "release-0.1.209-local/gates"), { recursive: true });
    const targets = [1, 2, 3, 4, 5, 6, 25, 26].map((n, i) => f.payload(n, now - (20 - i) * 1000));
    // The two newest uses are independent of the pinned release SHAs.
    utimesSync(path.join(targets[4]!, "last-used"), now / 1000, now / 1000);
    utimesSync(path.join(targets[5]!, "last-used"), (now - 1) / 1000, (now - 1) / 1000);
    mkdirSync(path.join(f.cache, "native-resources"));
    writeFileSync(path.join(f.cache, "native-resources/seed"), "seed");
    mkdirSync(path.join(f.cache, "unknown-entry"));
    const held = tryKernelLock(path.join(f.cache, `${sha(2)}.lock`));
    expect(held).toBeDefined();
    try {
      await reclaimVmStorage(f.options);
      expect([1, 2, 5, 6, 25, 26].every((n) => existsSync(path.join(f.cache, sha(n))))).toBe(true);
      expect([3, 4].map((n) => existsSync(path.join(f.cache, sha(n))))).toEqual([false, false]);
      expect(readFileSync(path.join(f.cache, "native-resources/seed"), "utf8")).toBe("seed");
      expect(existsSync(path.join(f.cache, "unknown-entry"))).toBe(true);
      expect(f.log.join("\n")).toMatch(/allocated; free space .*observed (?:gain|loss)/u);
    } finally {
      if (held !== undefined) closeSync(held);
    }
  });

  it("prunes candidate artifacts but pins main, last releases, queue references and active SHA locks", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    const candidates = path.join(f.root, "release-candidates");
    mkdirSync(candidates);
    for (const n of [1, 2, 3, 4, 25, 26]) {
      const entry = path.join(candidates, sha(n));
      mkdirSync(entry);
      writeFileSync(path.join(entry, "phone-manifest.json"), "receipt");
      writeFileSync(path.join(entry, "payload.apk"), Buffer.alloc(4096));
    }
    mkdirSync(path.join(f.state, "merge-queue/candidates"), { recursive: true });
    writeFileSync(path.join(f.state, "merge-queue/candidates/queued.md"), `sha: ${sha(3)}`);
    const held = tryKernelLock(path.join(candidates, `${sha(2)}.lock`));
    try {
      await reclaimVmStorage(f.options);
      for (const n of [1, 2, 3, 25, 26])
        expect(existsSync(path.join(candidates, sha(n)))).toBe(true);
      expect(existsSync(path.join(candidates, sha(4)))).toBe(false);
      expect(f.log.join("\n")).toContain("candidate cache");
      const receipts = readdirSync(path.join(f.state, "storage-retention"));
      expect(readFileSync(path.join(f.state, "storage-retention", receipts[0]!), "utf8")).toContain(
        "candidate cache",
      );
    } finally {
      if (held !== undefined) closeSync(held);
    }
  });

  it("prunes old large artifacts, retaining small records, installed Beta, latest four versions and referenced files", async () => {
    const f = fixture();
    const directories = Array.from({ length: 6 }, (_, i) => f.release(i + 1));
    for (const directory of directories) {
      writeFileSync(path.join(directory, "payload.tar"), Buffer.alloc(1024 ** 2 + 1));
      for (const name of ["proof.json", "notes.md", "receipt.txt"])
        writeFileSync(path.join(directory, name), "kept");
    }
    const old = directories[1]!;
    mkdirSync(path.join(old, "source/src"), { recursive: true });
    mkdirSync(path.join(old, "source/node_modules"), { recursive: true });
    const sourceFile = path.join(old, "source/src/large.ts");
    const generated = path.join(old, "source/node_modules/large-output");
    writeFileSync(sourceFile, Buffer.alloc(1024 ** 2 + 1));
    writeFileSync(generated, Buffer.alloc(1024 ** 2 + 1));
    const referenced = path.join(old, "referenced.tar");
    const keptDirectory = path.join(old, "kept");
    mkdirSync(keptDirectory);
    const nested = path.join(keptDirectory, "nested.tar");
    const extensionless = path.join(old, "extensionless.tar");
    writeFileSync(nested, Buffer.alloc(1024 ** 2 + 1));
    writeFileSync(extensionless, Buffer.alloc(1024 ** 2 + 1));
    writeFileSync(referenced, Buffer.alloc(1024 ** 2 + 1));
    mkdirSync(path.join(f.state, "check-evidence"));
    writeFileSync(
      path.join(f.state, "check-evidence/receipt.json"),
      JSON.stringify({ artifact: referenced, directory: keptDirectory + path.sep }),
    );
    writeFileSync(path.join(f.state, "check-evidence/record"), extensionless);
    await reclaimVmStorage(f.options);
    expect(existsSync(sourceFile)).toBe(true);
    expect(existsSync(generated)).toBe(false);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(extensionless)).toBe(true);
    expect(existsSync(path.join(old, "payload.tar"))).toBe(false);
    expect(existsSync(referenced)).toBe(true);
    expect(
      [directories[0]!, ...directories.slice(2)].every((d) =>
        existsSync(path.join(d, "payload.tar")),
      ),
    ).toBe(true);
    for (const name of ["proof.json", "notes.md", "receipt.txt"])
      expect(readFileSync(path.join(old, name), "utf8")).toBe("kept");
  });

  it("keeps crash symbols and deobfuscation records of every size while removing adjacent release bundles", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    const old = path.join(f.state, "release-0.1.2-local", sha(22));
    const symbols = [
      "phone/apps/agent-phone/app/build/outputs/mapping/release/mapping.txt",
      "phone/apps/agent-phone/app/build/outputs/mapping/release/mapping.prt",
      "phone/apps/agent-phone/app/build/outputs/mapping/release/seeds.txt",
      "phone/apps/agent-phone/app/build/outputs/mapping/release/usage.txt",
      "phone/apps/agent-phone/app/build/outputs/mapping/release/configuration.txt",
      "mac/apps/desktop/native/computer-use/.build/out/Products/Release/ComputerUseHelper.dSYM/Contents/Resources/DWARF/ComputerUseHelper",
      "mac/apps/desktop/native/computer-use/.build/out/Products/Release/ComputerUseHelper.dSYM/Contents/Resources/Relocations/aarch64/ComputerUseHelper.yml",
      "mac/apps/desktop/dist/main.js.map",
      "mac-state/personal-runtime/web/assets/app.js.map",
    ];
    const content = Buffer.alloc(1024 ** 2 + 1, 7);
    for (const relative of symbols) {
      const filename = path.join(old, relative);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, content);
    }
    const small = path.join(old, "mac/Helper.dSYM/Contents/Info.plist");
    mkdirSync(path.dirname(small), { recursive: true });
    writeFileSync(small, "symbol identity");
    const bulk = [
      "phone/apps/agent-phone/app/build/outputs/mapping/release/app-release.apk",
      "mac/apps/desktop/native/computer-use/.build/out/Products/Release/ComputerUseHelper.zip",
    ];
    for (const relative of bulk) {
      const filename = path.join(old, relative);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, content);
    }
    await reclaimVmStorage(f.options);
    const digest = createHash("sha256").update(content).digest("hex");
    for (const relative of symbols) {
      const filename = path.join(old, relative);
      const actual = existsSync(filename)
        ? createHash("sha256").update(readFileSync(filename)).digest("hex")
        : undefined;
      expect.soft(actual).toBe(digest);
    }
    expect(readFileSync(small, "utf8")).toBe("symbol identity");
    for (const relative of bulk) expect(existsSync(path.join(old, relative))).toBe(false);
  });

  it("keeps an old release while its coordinator lock is held", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    const old = path.join(f.state, "release-0.1.2-local", sha(22));
    const artifact = path.join(old, "payload.tar");
    writeFileSync(artifact, Buffer.alloc(1024 ** 2 + 1));
    const held = tryKernelLock(path.join(old, "coordinator.lock"));
    expect(held).toBeDefined();
    try {
      await reclaimVmStorage(f.options);
      expect(existsSync(artifact)).toBe(true);
    } finally {
      if (held !== undefined) closeSync(held);
    }
    await reclaimVmStorage(f.options);
    expect(existsSync(artifact)).toBe(false);
  });

  it("honours symlinked and JSON-escaped reference records", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    const old = path.join(f.state, "release-0.1.2-local", sha(22));
    const linked = path.join(old, "linked.tar");
    const escaped = path.join(old, "escaped.tar");
    for (const filename of [linked, escaped]) writeFileSync(filename, Buffer.alloc(1024 ** 2 + 1));
    mkdirSync(path.join(f.state, "records"));
    mkdirSync(path.join(f.state, "check-evidence"));
    writeFileSync(path.join(f.state, "records/source.json"), JSON.stringify({ artifact: linked }));
    symlinkSync(
      path.join(f.state, "records/source.json"),
      path.join(f.state, "check-evidence/linked.json"),
    );
    writeFileSync(
      path.join(f.state, "check-evidence/escaped.json"),
      JSON.stringify({ artifact: escaped }).replaceAll("/", "\\/"),
    );
    await reclaimVmStorage(f.options);
    expect(existsSync(linked)).toBe(true);
    expect(existsSync(escaped)).toBe(true);
  });

  // A symbol backup zip under merge-queue held the bytes "\\T"; decoding it as a JSON escape
  // threw, every record counted as unreadable, and release artifacts were never reclaimed.
  it("reads records whose backslashes are not JSON escapes", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    const old = path.join(f.state, "release-0.1.2-local", sha(22));
    const stale = path.join(old, "stale.tar");
    const escaped = path.join(old, "escaped.tar");
    for (const filename of [stale, escaped]) writeFileSync(filename, Buffer.alloc(1024 ** 2 + 1));
    mkdirSync(path.join(f.state, "merge-queue/symbol-backup"), { recursive: true });
    writeFileSync(
      path.join(f.state, "merge-queue/symbol-backup/mapping.prt"),
      Buffer.from("PK\u0003\u0004 C:\\Temp\\release-notes \\U00e9 \\B"),
    );
    writeFileSync(
      path.join(f.state, "merge-queue/escaped.json"),
      JSON.stringify({ artifact: escaped }).replaceAll("/", "\\/"),
    );
    await reclaimVmStorage(f.options);
    expect(existsSync(escaped)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("refuses symlink escapes without deleting their targets or neighbouring artifacts", async () => {
    const f = fixture();
    const external = path.join(f.root, "outside");
    mkdirSync(external);
    writeFileSync(path.join(external, "payload.tar"), Buffer.alloc(1024 ** 2 + 1));
    symlinkSync(external, path.join(f.cache, sha(3)));
    for (let n = 1; n <= 6; n++) f.release(n);
    const old = f.release(0);
    symlinkSync(external, path.join(old, "escape"));
    writeFileSync(path.join(old, "payload.tar"), Buffer.alloc(1024 ** 2 + 1));
    await reclaimVmStorage(f.options);
    expect(existsSync(path.join(external, "payload.tar"))).toBe(true);
    expect(existsSync(path.join(old, "payload.tar"))).toBe(true);
    expect(f.log.join("\n")).toMatch(/symlink|canonical/iu);
  });

  it("dry-run reports candidates while deleting nothing", async () => {
    const f = fixture();
    for (let n = 1; n <= 6; n++) f.release(n);
    const target = f.payload(3, now - 10 * 86_400_000);
    f.payload(4, now - 1000);
    f.payload(5, now);
    const artifact = path.join(f.state, "release-0.1.2-local", sha(22), "payload.tar");
    writeFileSync(artifact, Buffer.alloc(1024 ** 2 + 1));
    const bytes = await reclaimVmStorage({ ...f.options, dryRun: true });
    expect(bytes).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(artifact)).toBe(true);
    expect(f.log.join("\n")).toContain("would delete");
    expect(f.log.join("\n")).toContain("would reclaim");
  });

  it("keeps candidates when main, VM inventory or release identity is unknown", async () => {
    const f = fixture();
    const target = f.payload(3, now - 10 * 86_400_000);
    f.payload(4, now - 1000);
    f.payload(5, now);
    const old = f.release(0);
    for (let n = 1; n <= 6; n++) f.release(n);
    writeFileSync(path.join(old, "release.json"), "unreadable identity");
    writeFileSync(path.join(old, "payload.tar"), Buffer.alloc(1024 ** 2 + 1));
    await reclaimVmStorage({ ...f.options, storage: { ...f.options.storage, mainSha: undefined } });
    expect(existsSync(target)).toBe(true);
    expect(existsSync(path.join(old, "payload.tar"))).toBe(true);
    await reclaimVmStorage({
      ...f.options,
      vms: async () => {
        throw new Error("inventory unavailable");
      },
    });
    expect(existsSync(target)).toBe(true);
  });

  it("serializes against a payload build and writes a free-space receipt even in dry-run", async () => {
    const f = fixture();
    f.payload(3, now - 10 * 86_400_000);
    f.payload(4, now - 1000);
    f.payload(5, now);
    const locks = path.join(f.state, "vm/locks");
    mkdirSync(locks, { recursive: true });
    const build = tryKernelLock(path.join(locks, "storage-retention"), "shared");
    expect(build).toBeDefined();
    const shutdown = new AbortController();
    let identified = false;
    const waiting = reclaimVmStorage({
      ...f.options,
      dryRun: true,
      signal: shutdown.signal,
      identify: async () => {
        identified = true;
        return f.options.storage;
      },
    });
    try {
      expect(identified).toBe(false);
      shutdown.abort(new Error("held by payload build"));
      await expect(waiting).rejects.toThrow("held by payload build");
    } finally {
      shutdown.abort();
      if (build !== undefined) closeSync(build);
      await waiting.catch(() => undefined);
    }
    await reclaimVmStorage({ ...f.options, dryRun: true });
    const receipts = path.join(f.state, "storage-retention");
    const files = (await import("node:fs")).readdirSync(receipts);
    expect(files.length).toBeGreaterThan(0);
    const successful = files
      .map((name) => JSON.parse(readFileSync(path.join(receipts, name), "utf8")))
      .filter((record) => !record.error);
    expect(successful).toHaveLength(1);
    const receipt = successful[0];
    expect(receipt).toMatchObject({ dryRun: true, bytesFreed: 0 });
    expect(receipt.freeBytesBefore).toBeGreaterThan(0);
    expect(receipt.freeBytesAfter).toBeGreaterThan(0);
    expect(receipt.removed).toEqual([]);
    expect(receipt.candidates.length).toBeGreaterThan(0);
  });

  it("keeps a clone and its run when Tart reports an unknown state", async () => {
    const f = fixture();
    const runId = "20261020T000000Z-dddddddd";
    const name = `opensteer-gui-job-${runId}`;
    mkdirSync(path.join(f.options.tartVms, name), { recursive: true });
    const run = path.join(f.state, "vm-runs", runId);
    mkdirSync(run, { recursive: true });
    writeFileSync(
      path.join(run, "job.json"),
      JSON.stringify({
        runId,
        startedAt: (now - 2 * 86_400_000) / 1000,
        endedAt: (now - 2 * 86_400_000) / 1000,
      }),
    );
    let deleted = false;
    await reclaimVmStorage({
      ...f.options,
      vms: async () => [{ Name: name, State: "unknown" }],
      deleteVm: async () => {
        deleted = true;
      },
    });
    expect(deleted).toBe(false);
    expect(existsSync(run)).toBe(true);
  });

  it("reclaims a VM run's large artifacts after 24 hours, keeping the small evidence a receipt under sweep/ preserved", async () => {
    const f = fixture();
    const id = "20261020T000000Z-dddddddd";
    const run = path.join(f.state, "vm-runs", id);
    mkdirSync(path.join(run, "guest/native/mac"), { recursive: true });
    writeFileSync(
      path.join(run, "job.json"),
      JSON.stringify({
        runId: id,
        startedAt: (now - 2 * 86_400_000) / 1000,
        endedAt: (now - 25 * 3_600_000) / 1000,
      }),
    );
    writeFileSync(path.join(run, "guest/native/mac/leak-scan.json"), '{"passed":true,"matches":0}');
    writeFileSync(path.join(run, "guest/recording.mov"), Buffer.alloc(1024 ** 2));
    // A command log under sweep/ names the run, and its receipt keeps a copy of the scan.
    const swept = path.join(f.state, "sweep", sha(3));
    const preserved = path.join(
      swept,
      `saved-password-smoke.evidence/${id}/guest/native/mac/leak-scan.json`,
    );
    mkdirSync(path.dirname(preserved), { recursive: true });
    writeFileSync(path.join(swept, "saved-password-smoke.0.log"), `${run}\n`);
    writeFileSync(
      path.join(swept, "saved-password-smoke.json"),
      JSON.stringify({ evidence: [run] }),
    );
    writeFileSync(preserved, '{"passed":true,"matches":0}');
    await reclaimVmStorage(f.options);
    expect(existsSync(run)).toBe(false);
    expect(existsSync(preserved)).toBe(true);
  });

  it("reclaims finished unreferenced runs after 24 hours, retaining live and referenced runs", async () => {
    const f = fixture();
    const ids = [
      "20261020T000000Z-aaaaaaaa",
      "20261020T000000Z-bbbbbbbb",
      "20261020T000000Z-cccccccc",
    ];
    for (const id of ids) {
      const directory = path.join(f.state, "vm-runs", id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, "job.json"),
        JSON.stringify({
          runId: id,
          startedAt: (now - 2 * 86_400_000) / 1000,
          ...(id === ids[2] ? { pid: process.pid } : { endedAt: (now - 25 * 3_600_000) / 1000 }),
        }),
      );
    }
    mkdirSync(path.join(f.state, "merge-queue"));
    writeFileSync(path.join(f.state, "merge-queue/note.md"), ids[1]!);
    await reclaimVmStorage(f.options);
    expect(ids.map((id) => existsSync(path.join(f.state, "vm-runs", id)))).toEqual([
      false,
      true,
      true,
    ]);
  });

  // Admission once kept every small file's whole text (21 GiB on a busy host) only to
  // look for run IDs; the scan now keeps the IDs it finds and nothing else.
  it("collects only the run IDs named in references, not their contents", () => {
    const f = fixture();
    const notes = path.join(f.state, "work", "notes");
    mkdirSync(notes, { recursive: true });
    writeFileSync(path.join(notes, "note.md"), "kept 20261020T000000Z-aaaaaaaa for review");
    // The digits of the second ID are hex, so a non-overlapping match would swallow them.
    writeFileSync(path.join(notes, "pair.txt"), "20261019T120000Z-20261020T000000Z-eeeeeeee");
    // A large text file is read in several pieces; splits at every offset are tested below.
    writeFileSync(
      path.join(notes, "suite.log"),
      Buffer.concat([
        Buffer.alloc(5 * 1024 ** 2 - 10, "x"),
        Buffer.from("20261020T000000Z-bbbbbbbb"),
      ]),
    );
    symlinkSync(path.join(notes, "20261020T000000Z-cccccccc"), path.join(notes, "latest"));
    writeFileSync(
      path.join(notes, "capture.pcap"),
      Buffer.concat([Buffer.alloc(5 * 1024 ** 2), Buffer.from("20261020T000000Z-dddddddd")]),
    );
    expect(referencedRunIds(f.state)).toEqual({
      runIds: new Set([
        "20261020T000000Z-aaaaaaaa",
        "20261020T000000Z-bbbbbbbb",
        "20261020T000000Z-cccccccc",
        "20261019T120000Z-20261020",
        "20261020T000000Z-eeeeeeee",
      ]),
    });
  });

  // The scan checks bytes around each "Z-" instead of running a regex over decoded text,
  // which cost minutes of CPU per admission; it must find exactly what the pattern does.
  it("finds the same run IDs in bytes as the run-ID pattern, overlaps included", () => {
    const pattern = /(?=(\d{8}T\d{6}Z-[0-9a-f]{8}))/gu;
    const alphabet = "0123456789TZ-afgA x";
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const id = () =>
      `2026${String(Math.floor(random() * 1e4)).padStart(4, "0")}T${String(Math.floor(random() * 1e6)).padStart(6, "0")}Z-${Math.floor(
        random() * 2 ** 32,
      )
        .toString(16)
        .padStart(8, "0")}`;
    const samples = [
      "",
      "Z-",
      "0000000T000000Z-aaaaaaaa",
      "20261020T000000Z-AAAAAAAA",
      "20261020T000000Z-aaaaaaa",
      "20261019T120000Z-20261020T000000Z-eeeeeeee",
    ];
    for (let n = 0; n < 2_000; n += 1) {
      let text = "";
      while (text.length < 80)
        text += random() < 0.3 ? id() : alphabet[Math.floor(random() * alphabet.length)];
      samples.push(text.slice(Math.floor(random() * 30)));
    }
    for (const text of samples) {
      const found = new Set<string>();
      addRunIds(Buffer.from(text, "latin1"), text.length, found);
      expect(found, text).toEqual(new Set([...text.matchAll(pattern)].map((match) => match[1])));
    }
  });

  // Read boundaries depend on the buffer size, so a small buffer puts an ID across a
  // boundary at every offset; each must survive the carry between reads.
  it("finds IDs split across reads at every offset", () => {
    const ids = ["20261020T000000Z-aaaaaaaa", "20261021T235959Z-0123abcd"];
    const text = `x${ids[0]}yy${ids[1]}z`.repeat(3);
    for (const size of [25, 26, 31, 40, 64])
      for (let shift = 0; shift < size; shift += 1) {
        const source = Buffer.from("-".repeat(shift) + text, "latin1");
        let position = 0;
        const found = new Set<string>();
        addRunIdsFromReads(
          (into, offset, length) => {
            const count = source.copy(
              into,
              offset,
              position,
              Math.min(source.length, position + length),
            );
            position += count;
            return count;
          },
          Buffer.alloc(size),
          found,
        );
        expect(found, `buffer ${size}, shift ${shift}`).toEqual(new Set(ids));
      }
  });

  // Each release file was checked by scanning every reference record at every ancestor
  // directory, which took minutes per release; the index must answer exactly as that did.
  it("answers release references exactly like a scan of every record", () => {
    const root = "/state/release-0.1.2-local";
    const files = [
      `${root}/${sha(22)}/mac/payload.tar`,
      `${root}/${sha(22)}/mac/apps/desktop/dist/main.js`,
      `${root}/${sha(22)}/phone/app-release.apk`,
      `${root}/${sha(23)}/source/node_modules/x/addon.node`,
    ];
    const scanned = (filename: string, texts: readonly string[]) => {
      const relative = path.relative(path.dirname(root), filename);
      if (texts.some((text) => text.includes(filename) || text.includes(relative))) return true;
      for (
        let directory = path.dirname(filename);
        directory.startsWith(root);
        directory = path.dirname(directory)
      ) {
        const relativeDirectory = path.relative(path.dirname(root), directory);
        if (
          texts.some((text) =>
            [directory, relativeDirectory].some(
              (value) =>
                ['"', "'", "\n", " ", ")", ",", "} "].some(
                  (end) => text.includes(value + end) || text.includes(value + path.sep + end),
                ) ||
                text.endsWith(value) ||
                text.endsWith(value + path.sep),
            ),
          )
        )
          return true;
      }
      return false;
    };
    const named = files.flatMap((file) => {
      const parts = path.relative(path.dirname(root), file).split("/");
      return parts.map((_, n) => parts.slice(0, n + 1).join("/"));
    });
    const fragments = [
      ...named,
      ...named.map((name) => `/state/${name}`),
      "release-0.1.2-local-r2/" + sha(22),
      "payload.tar.gz",
      "release-",
      "\u0000",
      '"',
      "'",
      "\n",
      " ",
      ")",
      ",",
      "} ",
      "/",
      "x",
    ];
    let seed = 11;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 1_500; n += 1) {
      const texts = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        let text = "";
        for (let count = Math.floor(random() * 5); count >= 0; count -= 1)
          text += fragments[Math.floor(random() * fragments.length)];
        return text;
      });
      const check = releaseReferenceCheck(texts, root, files);
      for (const file of files)
        expect(check(file), JSON.stringify({ file, texts })).toBe(scanned(file, texts));
    }
  });

  // Releases hold tens of thousands of files; spreading them into one call overflowed the stack.
  it("checks references for a release with very many files", () => {
    const root = "/state/release-0.1.2-local";
    const files = Array.from({ length: 300_000 }, (_, n) => `${root}/${sha(22)}/mac/file-${n}.tar`);
    const check = releaseReferenceCheck([`kept ${files[123]} for review`], root, files);
    expect(check(files[123]!)).toBe(true);
    expect(check(files[124]!)).toBe(false);
  });
});
