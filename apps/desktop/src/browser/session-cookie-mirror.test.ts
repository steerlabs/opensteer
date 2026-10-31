import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import type { LocalProfileBinding } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import * as atomicFiles from "@opensteer/shared/atomicPrivateFile";
import { SessionCookieMirror } from "./session-cookie-mirror.js";
import type { DesktopSecretCryptography } from "../secrets/protected-json-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const binding = (): LocalProfileBinding => ({
  version: 1,
  deploymentId: createId("deployment"),
  profileId: createId("browserProfile"),
  runnerId: createId("runner"),
  storageInstanceId: randomUUID(),
  bindingId: randomUUID(),
  engine: "electron",
});
const cookie = (value = "one", topLevelSite?: string) => ({
  name: "sid",
  value,
  domain: "site.test",
  path: "/",
  secure: true,
  httpOnly: true,
  session: true,
  expires: -1,
  priority: "Medium",
  sourceScheme: "Secure",
  sourcePort: 443,
  ...(topLevelSite ? { partitionKey: { topLevelSite, hasCrossSiteAncestor: true } } : {}),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-mirror-unit-"));
  roots.push(directory);
  let jar: unknown[] = [cookie()];
  let changed = () => {};
  const capture = vi.fn(async () => jar);
  const restore = vi.fn(async (cookies: readonly Record<string, unknown>[]) => {
    jar = [
      ...jar,
      ...cookies.map((c) => ({
        ...c,
        domain: c.domain ?? new URL(String(c.url)).hostname,
        session: true,
        expires: -1,
      })),
    ];
    changed();
  });
  const crypto: DesktopSecretCryptography = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: vi.fn(async (v) => Buffer.from(v)),
    decryptStringAsync: vi.fn(async (v) => ({ result: v.toString(), shouldReEncrypt: false })),
  };
  const b = binding();
  const writes: string[] = [];
  const options = {
    directory,
    binding: b,
    cryptography: crypto,
    capture,
    restore,
    subscribe: (listener: () => void) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
    onFailure: vi.fn(),
    publish: vi.fn(async (file: string, contents: string) => {
      writes.push(contents);
      await writeFile(file, contents, { mode: 0o600 });
    }),
  };
  return {
    directory,
    options,
    crypto,
    writes,
    capture,
    restore,
    setJar: (cookies: unknown[]) => {
      jar = cookies;
    },
    change: () => changed(),
    create: () => new SessionCookieMirror(options),
  };
}

describe("encrypted Session cookie mirror", () => {
  it("reads the committed mirror while its OS key is unwrapping, before creating a cookie target", async () => {
    const f = await fixture();
    const first = f.create();
    await first.initialize(async () => {});
    await first.stop();
    const entered = deferred();
    const release = deferred();
    vi.mocked(f.crypto.decryptStringAsync).mockImplementation(async (value) => {
      entered.resolve();
      await release.promise;
      return { result: value.toString(), shouldReEncrypt: false };
    });
    f.capture.mockClear();
    const read = vi.spyOn(atomicFiles, "readPrivateFileText");
    const mirror = f.create();
    const recovering = mirror.recover();
    try {
      await withTimeout(entered.promise, 1000, {
        timeoutError: () => new Error("Cookie key unwrap never started"),
      });
      expect(read).toHaveBeenCalledWith(
        path.join(f.directory, "session-cookies.v1.json"),
        expect.any(Number),
        expect.any(Object),
      );
      expect(f.capture).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await recovering;
      await mirror.stop();
      read.mockRestore();
    }
  });
  it("discards uncommitted mirror and key sidecars without promoting either", async () => {
    const f = await fixture();
    const first = f.create();
    await first.initialize(async () => {});
    await first.stop();
    await writeFile(
      path.join(f.directory, `session-cookies.v1.json.tmp-${randomUUID()}`),
      "incomplete",
    );
    await writeFile(
      path.join(f.directory, `.session-cookie-key.v1.json.123.${randomUUID()}.tmp`),
      "incomplete",
    );
    const mirror = f.create();
    try {
      await mirror.recover();
      expect((await readdir(f.directory)).sort()).toEqual([
        "session-cookie-key.v1.json",
        "session-cookies.v1.json",
      ]);
    } finally {
      await mirror.stop();
    }
    await rm(path.join(f.directory, "session-cookies.v1.json"));
    await writeFile(
      path.join(f.directory, `session-cookies.v1.json.tmp-${randomUUID()}`),
      f.writes[0]!,
    );
    const missing = f.create();
    try {
      await expect(missing.recover()).rejects.toThrow(/missing/);
    } finally {
      await missing.stop();
    }
  });
  it("captures again for changes during capture and publication, with one lane", async () => {
    const f = await fixture();
    const mirror = f.create();
    await mirror.initialize(async () => {});
    const capturing = deferred();
    const release = deferred();
    f.capture.mockImplementationOnce(async () => {
      const result = [cookie("two")];
      capturing.resolve();
      await release.promise;
      return result;
    });
    f.setJar([cookie("three")]);
    f.change();
    await bounded(capturing.promise, "capture started");
    f.change();
    release.resolve();
    await mirror.flush();
    expect(f.capture).toHaveBeenCalledTimes(3);
    expect(f.writes).toHaveLength(3);
    const publishing = deferred();
    const publishRelease = deferred();
    f.options.publish.mockImplementationOnce(async (file, contents) => {
      publishing.resolve();
      await publishRelease.promise;
      f.writes.push(contents);
      await writeFile(file, contents, { mode: 0o600 });
    });
    f.setJar([cookie("four")]);
    f.change();
    await bounded(publishing.promise, "publication started");
    f.setJar([cookie("five")]);
    f.change();
    publishRelease.resolve();
    await mirror.flush();
    expect(f.writes).toHaveLength(5);
    await mirror.stop();
  });
  it("explicit flush captures after the call even before event delivery; unchanged sets do not write", async () => {
    const f = await fixture();
    const mirror = f.create();
    await mirror.initialize(async () => {});
    await mirror.flush();
    expect(f.writes).toHaveLength(1);
    f.setJar([cookie("changed")]);
    await mirror.flush();
    expect(f.writes).toHaveLength(2);
    f.change();
    await mirror.flush();
    expect(f.writes).toHaveLength(2);
    expect(f.crypto.encryptStringAsync).toHaveBeenCalledOnce();
    await mirror.stop();
  });
  it("round-trips duplicate CHIPS identities, ignores opaque partitions and lets persistent cookies win", async () => {
    const f = await fixture();
    f.setJar([
      cookie("a", "https://a.test"),
      cookie("b", "https://b.test"),
      { ...cookie("opaque"), partitionKeyOpaque: true },
    ]);
    const mirror = f.create();
    await mirror.initialize(async () => {});
    await mirror.stop();
    f.setJar([
      {
        ...cookie("persistent", "https://a.test"),
        sourcePort: 18_766,
        session: false,
        expires: Date.now() / 1000 + 1000,
      },
    ]);
    const reopened = f.create();
    await reopened.recover();
    expect(f.restore).toHaveBeenCalledOnce();
    expect(f.restore.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        value: "b",
        partitionKey: { topLevelSite: "https://b.test", hasCrossSiteAncestor: true },
      }),
    ]);
    await reopened.stop();
  });
  it.each(["missing", "malformed", "ciphertext", "sequence", "binding"])(
    "refuses a %s ready mirror and preserves files",
    async (mode) => {
      const f = await fixture();
      const mirror = f.create();
      await mirror.initialize(async () => {});
      await mirror.stop();
      const file = path.join(f.directory, "session-cookies.v1.json");
      const original = await readFile(file, "utf8");
      if (mode === "missing") await rm(file);
      else if (mode === "malformed") await writeFile(file, "{}");
      else if (mode === "binding")
        f.options.binding = { ...f.options.binding, bindingId: randomUUID() };
      else {
        const parsed = JSON.parse(original) as Record<string, unknown>;
        parsed[mode === "sequence" ? "sequence" : "ciphertext"] = mode === "sequence" ? 10 : "AAAA";
        await writeFile(file, JSON.stringify(parsed));
      }
      const before = await readFile(file, "utf8").catch(() => null);
      const reopened = f.create();
      await expect(reopened.recover()).rejects.toThrow();
      expect(f.restore).not.toHaveBeenCalled();
      expect(await readFile(file, "utf8").catch(() => null)).toBe(before);
      expect(f.writes).toHaveLength(1);
      await reopened.stop();
    },
  );
  it("refuses a locked key store or basic-text backend without deleting sidecars", async () => {
    const f = await fixture();
    const mirror = f.create();
    await mirror.initialize(async () => {});
    await mirror.stop();
    const key = path.join(f.directory, "session-cookie-key.v1.json");
    const before = await readFile(key, "utf8");
    vi.mocked(f.crypto.isAsyncEncryptionAvailable).mockResolvedValue(false);
    const locked = f.create();
    await expect(locked.recover()).rejects.toThrow();
    await locked.stop();
    expect(await readFile(key, "utf8")).toBe(before);
    vi.mocked(f.crypto.isAsyncEncryptionAvailable).mockResolvedValue(true);
    f.crypto.getSelectedStorageBackend = () => "basic_text";
    const basic = new SessionCookieMirror({ ...f.options, platform: "linux" });
    await expect(basic.recover()).rejects.toThrow("basic-text");
    await basic.stop();
  });
  it("suspends a capture across Network Service loss and never publishes the smaller jar", async () => {
    const f = await fixture();
    const mirror = f.create();
    await mirror.initialize(async () => {});
    const capturing = deferred();
    const release = deferred();
    f.capture.mockImplementationOnce(async () => {
      capturing.resolve();
      await release.promise;
      return [];
    });
    f.change();
    await bounded(capturing.promise, "capture started");
    mirror.suspend();
    f.setJar([]);
    f.change();
    release.resolve();
    await mirror.recover();
    await mirror.flush();
    expect(f.writes).toHaveLength(1);
    expect(f.restore).toHaveBeenCalledWith([expect.objectContaining({ value: "one" })]);
    await mirror.stop();
  });
  it("serializes controlled deletion with publication so logout cannot resurrect cookies", async () => {
    const f = await fixture();
    const mirror = f.create();
    await mirror.initialize(async () => {});
    await mirror.mutate(async () => {
      f.setJar([]);
    });
    await mirror.stop();
    const reopened = f.create();
    await reopened.recover();
    expect(f.restore).not.toHaveBeenCalled();
    await reopened.stop();
  });
});

function bounded<T>(promise: Promise<T>, event: string): Promise<T> {
  return withTimeout(promise, 1000, {
    timeoutError: () => new Error(`Mirror ${event} never happened.`),
  });
}

it("never publishes a rejected restoration or a failed capture across a service restart", async () => {
  const f = await fixture();
  const mirror = f.create();
  await mirror.initialize(async () => {});
  const entered = deferred();
  const release = deferred();
  f.capture.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("service disconnected");
  });
  f.change();
  await bounded(entered.promise, "capture entered");
  mirror.suspend();
  f.setJar([]);
  release.resolve();
  await mirror.recover();
  expect(f.writes).toHaveLength(1);
  await mirror.stop();
  f.setJar([]);
  f.restore.mockImplementationOnce(async () => {});
  const rejected = f.create();
  await expect(rejected.recover()).rejects.toThrow();
  expect(f.writes).toHaveLength(1);
  await rejected.stop();
});

it("fences a write failure and preserves the previously published mirror", async () => {
  const f = await fixture();
  const mirror = f.create();
  await mirror.initialize(async () => {});
  const before = await readFile(path.join(f.directory, "session-cookies.v1.json"), "utf8");
  f.options.publish.mockRejectedValueOnce(new Error("disk full"));
  f.setJar([cookie("new")]);
  await expect(mirror.flush()).rejects.toThrow("persistence failed");
  await expect(mirror.mutate(async () => {})).rejects.toThrow();
  expect(f.options.onFailure).toHaveBeenCalled();
  expect(await readFile(path.join(f.directory, "session-cookies.v1.json"), "utf8")).toBe(before);
  await mirror.stop();
});

it("does not poison persistence when an import deadline aborts before writing", async () => {
  const f = await fixture();
  const mirror = f.create();
  await mirror.initialize(async () => {});
  const deadline = new AbortController();
  await expect(
    mirror.mutate(async () => {
      deadline.abort();
      deadline.signal.throwIfAborted();
    }, deadline.signal),
  ).rejects.toThrow();
  await mirror.flush();
  expect(f.options.onFailure).not.toHaveBeenCalled();
  await mirror.stop();
});

it("authenticates ciphertext against the binding independently of the wrapped key record", async () => {
  const f = await fixture();
  const mirror = f.create();
  await mirror.initialize(async () => {});
  await mirror.stop();
  const file = path.join(f.directory, "session-cookie-key.v1.json");
  const envelope = JSON.parse(await readFile(file, "utf8")) as { ciphertext: string };
  const wrapped = JSON.parse(Buffer.from(envelope.ciphertext, "base64").toString()) as {
    binding: LocalProfileBinding;
  };
  f.options.binding = { ...f.options.binding, bindingId: randomUUID() };
  wrapped.binding = f.options.binding;
  envelope.ciphertext = Buffer.from(JSON.stringify(wrapped)).toString("base64");
  await writeFile(file, JSON.stringify(envelope));
  const reopened = f.create();
  await expect(reopened.recover()).rejects.toThrow();
  expect(f.restore).not.toHaveBeenCalled();
  await reopened.stop();
});
