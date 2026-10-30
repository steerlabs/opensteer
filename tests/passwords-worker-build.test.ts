import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runBounded } from "../scripts/command-runner.js";

it("keeps sandbox worker identity independent of the outer release version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-worker-version-"));
  const repo = path.resolve(import.meta.dirname, "..");
  try {
    const desktop = path.join(root, "apps/desktop");
    await mkdir(path.join(desktop, "scripts"), { recursive: true });
    await cp(
      path.join(repo, "apps/desktop/src/signed-helpers"),
      path.join(desktop, "src/signed-helpers"),
      { recursive: true },
    );
    for (const name of [
      "build-passwords-broker.ts",
      "build-swift-products.ts",
      "macos-release-identity.cjs",
      "signing-input.cjs",
    ])
      await cp(path.join(repo, "apps/desktop/scripts", name), path.join(desktop, "scripts", name));
    await symlink(
      path.join(repo, "apps/desktop/scripts/native-build-cache.ts"),
      path.join(desktop, "scripts/native-build-cache.ts"),
    );
    for (const product of ["PasswordsBroker", "PasswordsImportWorker"])
      await mkdir(path.join(desktop, "native/passwords/Sources", product), { recursive: true });
    await cp(
      path.join(
        repo,
        "apps/desktop/native/passwords/Sources/PasswordsImportWorker/Info.development.plist",
      ),
      path.join(desktop, "native/passwords/Sources/PasswordsImportWorker/Info.development.plist"),
    );
    await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"));
    await symlink(path.join(repo, "apps/desktop/node_modules"), path.join(desktop, "node_modules"));
    await writeFile(path.join(desktop, "package.json"), '{"version":"0.0.0","type":"module"}');
    const generate = async (version: string) => {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ version, type: "module" }));
      await runBounded(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(desktop, "scripts/build-passwords-broker.ts"),
          "--generate-only",
        ],
        {
          cwd: repo,
          env: {
            OPENSTEER_DESKTOP_RELEASE: "0",
            OPENSTEER_DESKTOP_SIGNING_FILE: "",
            OPENSTEER_DESKTOP_DEVELOPMENT_TRUST: "1",
          },
        },
      );
      return readFile(
        path.join(desktop, "native/passwords/Sources/PasswordsImportWorker/Info.development.plist"),
        "utf8",
      );
    };
    const first = await generate("0.1.211");
    expect(await generate("0.1.212")).toBe(first);
    expect(first).toContain("com.opensteer.passwords.dev.import");
    expect(first).not.toContain("CFBundleShortVersionString");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
