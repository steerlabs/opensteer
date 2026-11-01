import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  BrowserRuntime,
  LocalProfileStore,
  type BrowserLauncher,
} from "../packages/browser-runtime-core/src/index.js";
import {
  FakeIsolatingLauncher,
  FakeSink,
  FakeTicketVerifier,
  validClaims,
} from "../packages/browser-runtime-core/src/test-support/fakes.js";
import { SessionCookieMirror } from "../apps/desktop/src/browser/session-cookie-mirror.js";
import {
  BrowserSessionIdSchema,
  LocalProfileBindingSchema,
} from "../packages/protocol/src/index.js";
import { verifyNativeProfileMigration } from "../packages/database/src/browser-native-only-migration.test-support.js";

it("preserves both established local bindings and native sign-ins byte for byte while removing Vault data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-cutover-"));
  await writeFile(
    path.join(root, "storage.v1.json"),
    JSON.stringify({ version: 1, storageInstanceId: "20000000-0000-4000-8000-000000000001" }),
    { mode: 0o600 },
  );
  const store = await LocalProfileStore.acquire(root, "electron");
  const bindings = [1, 2].map((index) =>
    LocalProfileBindingSchema.parse({
      version: 1,
      deploymentId: "dep_00000000-0000-4000-8000-000000000001",
      runnerId: "rnr_00000000-0000-4000-8000-000000000001",
      storageInstanceId: store.storageInstanceId,
      profileId: `bpr_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      bindingId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      engine: "electron",
    }),
  );
  const artifacts = new Map<string, Buffer>();
  const mirrors = JSON.parse(
    await readFile(new URL("./fixtures/native-browser-mirrors.json", import.meta.url), "utf8"),
  ) as {
    profiles: Array<{ binding: unknown; keyFile: string; mirrorFile: string }>;
  };
  try {
    for (const [index, binding] of bindings.entries()) {
      const mirror = mirrors.profiles[index]!;
      expect(mirror.binding).toEqual(binding);
      const native = store.directory(binding);
      await mkdir(native, { recursive: true });
      for (const [name, bytes] of Object.entries({
        "opensteer.v1.json": Buffer.from(JSON.stringify({ version: 1, binding })),
        Cookies: Buffer.from("existing Chromium encrypted cookie database"),
        Preferences: Buffer.from('{"profile":{"name":"Existing"}}'),
        "../session-cookies.v1.json": Buffer.from(mirror.mirrorFile),
        "../session-cookie-key.v1.json": Buffer.from(mirror.keyFile),
      })) {
        const file = path.join(native, name);
        await writeFile(file, bytes, { mode: 0o600 });
        artifacts.set(file, bytes);
      }
    }
    await verifyNativeProfileMigration(bindings);
    for (const binding of bindings)
      expect(await store.requireReady(binding)).toBe(store.directory(binding));
    await store.close();
    const files = vi.fn(async () => {
      throw new Error("Established profiles must not be recreated");
    });
    const acknowledge = vi.fn(async () => {
      throw new Error("Established profiles need no initialization acknowledgement");
    });
    const engine = new FakeIsolatingLauncher();
    const restored: Array<readonly Record<string, unknown>[]> = [];
    const activeMirrors: SessionCookieMirror[] = [];
    const launcher: BrowserLauncher = {
      localProfiles: {
        engine: "electron",
        createFiles: files,
        release: async () => "retained-until-exit",
      },
      launch: async (request, signal) => {
        expect(request.storage.kind).toBe("local");
        if (request.storage.kind !== "local") throw new Error("Native binding required");
        expect(request.storage.directory).toBe(
          path.join(store.root, "profiles", request.storage.binding.profileId, "native"),
        );
        let jar: unknown[] = [];
        const mirror = new SessionCookieMirror({
          directory: path.dirname(request.storage.directory),
          binding: request.storage.binding,
          cryptography: {
            isAsyncEncryptionAvailable: async () => true,
            getSelectedStorageBackend: () => "gnome_libsecret",
            decryptStringAsync: async (value) => ({
              result: value.toString(),
              shouldReEncrypt: false,
            }),
            encryptStringAsync: async () => {
              throw new Error("Established keys must not be rewritten");
            },
          },
          capture: async () => jar,
          restore: async (cookies) => {
            restored.push(cookies);
            jar = cookies.map((cookie) => ({
              ...cookie,
              domain: cookie.domain ?? new URL(String(cookie.url)).hostname,
              session: true,
              expires: -1,
            }));
          },
          subscribe: () => () => {},
          onFailure: (error) => {
            throw error;
          },
          publish: async () => {
            throw new Error("Established mirrors must not be rewritten");
          },
        });
        activeMirrors.push(mirror);
        const browser = await engine.launch(request, signal);
        return Object.assign(browser, {
          profile: {
            ready: async () => {
              expect(await mirror.recover()).toBe(true);
            },
            admit: async () => {},
          },
        });
      },
    };
    const verifier = new FakeTicketVerifier();
    const runtime = new BrowserRuntime({
      launcher,
      ticketVerifier: verifier,
      localProfiles: { root },
      runtimeId: "runtime_test",
      sessionFilesRoot: path.join(root, ".opensteer-runtime", "session-files"),
      acknowledgeProfileReady: acknowledge,
    });
    try {
      for (const [index, binding] of bindings.entries()) {
        const ticket = String(index);
        verifier.setClaims(
          ticket,
          validClaims({
            sessionId: BrowserSessionIdSchema.parse(
              `bsn_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            ),
            identity: {
              kind: "profile-local",
              binding,
              initialized: true,
              readyUrl: "https://host.test/ready",
            },
          }),
        );
        const opened = await runtime.attach(ticket, new FakeSink());
        expect(restored[index]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "sid", value: `existing-sign-in-${index + 1}` }),
            expect.objectContaining({
              name: "partitioned",
              value: `existing-partition-${index + 1}`,
              partitionKey: { topLevelSite: "https://shop.test", hasCrossSiteAncestor: true },
            }),
          ]),
        );
        await opened.close();
      }
      expect(engine.launchCount).toBe(2);
      expect(files).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
      for (const [file, bytes] of artifacts) expect(await readFile(file)).toEqual(bytes);
    } finally {
      await runtime.shutdown();
      await Promise.all(activeMirrors.map((mirror) => mirror.stop()));
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
