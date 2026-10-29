import { execFile } from "node:child_process";
import { glob, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  harnessCatalog,
  shippedHarnessKinds,
  shippedHarnessCatalogEntry,
} from "../packages/core/src/harness-catalog.js";
import { describe, expect, it } from "vitest";
import { hostInternalRoutePatterns } from "../apps/host/src/server/internal-routes.js";

describe("container build context", () => {
  it("keeps every relative import the web build checks inside the web-assets stage's sources", async () => {
    // The web image stage type-checks apps/web with only the sources it copies;
    // an import of another app's source passes in the checkout and fails there.
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    const stage = containerfile
      .split(/^FROM /mu)
      .find((candidate) => candidate.split("\n", 1)[0]?.endsWith(" AS web-assets"));
    const copied = [...(stage ?? "").matchAll(/^COPY (?!--)(\S+) \.\/\S+$/gmu)].map(([, from]) =>
      resolve(from!),
    );
    expect(copied).toContain(resolve("apps/web"));
    const tsconfig = JSON.parse(await readFile(resolve("apps/web/tsconfig.json"), "utf8")) as {
      include: string[];
    };
    const escapes: string[] = [];
    for (const entry of tsconfig.include) {
      for await (const file of glob([`apps/web/${entry}`, `apps/web/${entry}/**/*.{ts,tsx}`])) {
        if (!/\.tsx?$/u.test(file)) continue;
        const source = await readFile(resolve(file), "utf8");
        for (const [, specifier] of source.matchAll(
          /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/gu,
        )) {
          const target = resolve(join(file, "..", specifier!));
          if (!copied.some((root) => target === root || target.startsWith(root + "/")))
            escapes.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it.each(["dependencies", "web-assets"])(
    "includes dependency patches before fetching in %s",
    async (name) => {
      const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
      const stage = containerfile
        .split(/^FROM /mu)
        .find((candidate) => candidate.split("\n", 1)[0]?.endsWith(` AS ${name}`));
      expect(stage).toBeDefined();
      const patchCopy = stage?.indexOf("COPY patches ./patches") ?? -1;
      const fetch = stage?.indexOf("pnpm fetch --frozen-lockfile") ?? -1;
      expect(patchCopy).toBeGreaterThanOrEqual(0);
      expect(fetch).toBeGreaterThan(patchCopy);
    },
  );

  it("keeps the container entrypoint valid executable JavaScript", async () => {
    await expect(
      promisify(execFile)(process.execPath, [
        "--check",
        "deploy/container/opensteer-entrypoint.mjs",
      ]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("verifies every shipped harness runtime through the Runner's own resolution", async () => {
    // The Runner's verifier resolves each engine exactly as the Runner will
    // launch it and compares `--version` with the harness catalog, so the
    // image restates neither a path nor a version an engine bump would have to
    // edit. An engine the person installs is not in the image at all.
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    expect(containerfile).toContain("node dist/verify-harness-runtimes-main.js");
    for (const kind of shippedHarnessKinds) {
      const { runtime } = shippedHarnessCatalogEntry(kind);
      if (runtime.shape === "installed") throw new Error(`${kind} ships no runtime`);
      expect(containerfile).not.toContain(runtime.expectedVersion);
    }
    for (const entry of harnessCatalog) {
      if (entry.runtime.shape !== "installed") continue;
      expect(containerfile).not.toContain(entry.runtime.installUrl);
    }
  });

  it("builds every deployable image from one exact release identity", async () => {
    const [containerfile, bake] = await Promise.all([
      readFile(resolve("deploy/container/Containerfile"), "utf8"),
      readFile(resolve("deploy/container/docker-bake.hcl"), "utf8"),
    ]);
    expect(containerfile).toContain("AS opensteer-release-record");
    expect(containerfile).toContain(
      'requireCanonicalReleaseIdentity("/source",process.env,{verifyRepository:false})',
    );
    expect(containerfile).toContain(
      "OPENSTEER_RELEASE_RECORD=/usr/local/share/opensteer/release.json",
    );
    expect(containerfile).toContain(
      "node scripts/stamp-release-package.cjs /output/host/package.json",
    );
    expect(containerfile).toContain(
      "node scripts/stamp-release-package.cjs /output/runner/package.json",
    );
    expect(bake).toContain('"org.opencontainers.image.version"  = "${RELEASE_VERSION}"');
    expect(bake).toContain('"org.opencontainers.image.revision" = "${SOURCE_REVISION}"');
    expect(bake).toContain('attest     = ["type=provenance,disabled=true"]');
  });

  it("packages the verified Web distribution into the Host image", async () => {
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    expect(containerfile).toContain("node scripts/write-web-distribution-manifest.mjs");
    expect(containerfile).toContain(
      "COPY --from=web-build --chown=10001:10001 /source/apps/web/dist /usr/local/share/opensteer/web",
    );
    expect(containerfile).toContain(
      "OPENSTEER_WEB_DISTRIBUTION_DIRECTORY=/usr/local/share/opensteer/web",
    );
    expect(containerfile).toContain(
      "OPENSTEER_WEB_DISTRIBUTION_MANIFEST=/usr/local/share/opensteer/web/opensteer-web.json",
    );
    expect(containerfile).toContain("OPENSTEER_HOST_RELEASE_VERSION=${OPENSTEER_RELEASE_VERSION}");
  });

  it("packages the required sandbox and FUSE runtime contract into the Runner image", async () => {
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    const runnerStart = containerfile.indexOf("FROM node-runtime AS runner\n");
    const runnerEnd = containerfile.indexOf("\nFROM ", runnerStart + 1);
    const runnerStage = containerfile.slice(runnerStart, runnerEnd);
    expect(runnerStart).toBeGreaterThanOrEqual(0);
    expect(runnerEnd).toBeGreaterThan(runnerStart);
    expect(runnerStage).toContain(
      "apt-get install --no-install-recommends --yes fuse3 libcap2 openssh-client openssl rsync socat",
    );
    expect(containerfile).toContain("AS bubblewrap-build");
    expect(containerfile).toContain(
      "69abc30005d2186baf7737feacd8da35633b93cf5af38838ecff17c5f8e924f6",
    );
    expect(containerfile).toContain("-Dsupport_setuid=false");
    expect(runnerStage).toContain(
      "COPY --from=bubblewrap-build --chmod=0555 /output/bwrap /usr/local/bin/bwrap",
    );
    // bubblewrap is LGPL, so its licence text has to travel with the binary.
    expect(runnerStage).toContain(
      "COPY --from=bubblewrap-build --chmod=0444 /output/COPYING /usr/local/share/licenses/bubblewrap/COPYING",
    );
    expect(runnerStage).toContain('test "$(bwrap --version)" = "bubblewrap 0.11.2"');
    expect(runnerStage).toContain("test ! -u /usr/local/bin/bwrap");
    expect(runnerStage).toContain("test -x /usr/bin/socat");
    expect(runnerStage).toContain("ln --force --symbolic /proc/mounts /etc/mtab");
    expect(runnerStage).toContain('test "$(readlink /etc/mtab)" = /proc/mounts');
  });

  it("projects exact Browser and Runner OCI seccomp profiles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-seccomp-"));
    const compiler = resolve("deploy/container/compile-seccomp-profile.mjs");
    const source = resolve("deploy/container/chromium-seccomp.json");
    const browserPath = join(directory, "browser.json");
    const runnerPath = join(directory, "runner.json");
    const armPath = join(directory, "arm.json");
    const armRunnerPath = join(directory, "arm-runner.json");
    try {
      await Promise.all([
        promisify(execFile)(process.execPath, [
          compiler,
          source,
          browserPath,
          "amd64",
          "CAP_SYS_CHROOT",
        ]),
        promisify(execFile)(process.execPath, [
          compiler,
          source,
          runnerPath,
          "amd64",
          "CAP_DAC_READ_SEARCH",
          "CAP_SYS_ADMIN",
        ]),
        promisify(execFile)(process.execPath, [
          compiler,
          source,
          armPath,
          "arm64",
          "CAP_SYS_CHROOT",
        ]),
        promisify(execFile)(process.execPath, [
          compiler,
          source,
          armRunnerPath,
          "arm64",
          "CAP_DAC_READ_SEARCH",
          "CAP_SYS_ADMIN",
        ]),
      ]);
      const [browserText, runnerText, armText, armRunnerText] = await Promise.all([
        readFile(browserPath, "utf8"),
        readFile(runnerPath, "utf8"),
        readFile(armPath, "utf8"),
        readFile(armRunnerPath, "utf8"),
      ]);
      const browser = JSON.parse(browserText) as SeccompProfile;
      const runner = JSON.parse(runnerText) as SeccompProfile;
      const arm = JSON.parse(armText) as SeccompProfile;
      const armRunner = JSON.parse(armRunnerText) as SeccompProfile;
      expect(Object.keys(browser).sort()).toEqual(["architectures", "defaultAction", "syscalls"]);
      expect(browser.architectures).toEqual(["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"]);
      expect(syscalls(browser)).toContain("chroot");
      expect(syscalls(browser)).toContain("clone3");
      expect(syscalls(browser)).toContain("openat2");
      for (const syscall of ["mount", "open_by_handle_at", "pivot_root"]) {
        expect(syscalls(browser)).not.toContain(syscall);
      }
      expect(syscalls(runner)).toEqual(
        expect.arrayContaining(["mount", "open_by_handle_at", "pivot_root"]),
      );
      expect(syscalls(runner)).toContain("clone3");
      expect(syscalls(runner)).toContain("openat2");
      expect(syscalls(runner)).toEqual(expect.arrayContaining(["pidfd_open", "pidfd_send_signal"]));
      for (const syscall of ["chroot", "delete_module", "pidfd_getfd", "reboot", "settimeofday"]) {
        expect(syscalls(runner)).not.toContain(syscall);
      }
      for (const syscall of ["pidfd_open", "pidfd_send_signal"]) {
        expect(syscalls(browser)).not.toContain(syscall);
      }
      expect(arm.architectures).toEqual(["SCMP_ARCH_AARCH64", "SCMP_ARCH_ARM"]);
      for (const syscall of ["pidfd_open", "pidfd_send_signal"]) {
        expect(syscalls(arm)).not.toContain(syscall);
      }
      expect(armRunner.architectures).toEqual(["SCMP_ARCH_AARCH64", "SCMP_ARCH_ARM"]);
      expect(syscalls(armRunner)).toEqual(
        expect.arrayContaining(["pidfd_open", "pidfd_send_signal"]),
      );
      expect(syscalls(armRunner)).not.toContain("pidfd_getfd");
      expect(syscalls(armRunner)).not.toContain("reboot");
      expect(browserText).not.toMatch(/archMap|excludes|includes/u);
      expect(runnerText).not.toMatch(/archMap|excludes|includes/u);

      const unsupportedSource = join(directory, "unsupported.json");
      const sourceProfile = JSON.parse(await readFile(source, "utf8")) as {
        syscalls: {
          excludes: Record<string, unknown>;
          includes: Record<string, unknown>;
        }[];
      };
      const firstRule = sourceProfile.syscalls[0];
      if (!firstRule) throw new Error("seccomp source must contain a syscall rule");
      firstRule.includes.arches = ["ppc64le"];
      firstRule.excludes.futureCondition = true;
      await writeFile(unsupportedSource, JSON.stringify(sourceProfile), "utf8");
      await expect(
        promisify(execFile)(process.execPath, [
          compiler,
          unsupportedSource,
          join(directory, "unsupported-output.json"),
          "amd64",
          "CAP_SYS_CHROOT",
        ]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("unsupported fields") });
      await expect(
        promisify(execFile)(process.execPath, [
          compiler,
          source,
          join(directory, "unsupported-arch.json"),
          "ppc64le",
          "CAP_SYS_CHROOT",
        ]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("unsupported seccomp target") });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("packages both generated OCI profiles for the node installer", async () => {
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    expect(containerfile).toContain('"${TARGETARCH}" CAP_SYS_CHROOT');
    expect(containerfile).toContain('"${TARGETARCH}" CAP_DAC_READ_SEARCH CAP_SYS_ADMIN');
    expect(containerfile).toContain(
      "/chromium-oci.json /usr/local/share/opensteer/chromium-oci.json",
    );
    expect(containerfile).toContain("/runner-oci.json /usr/local/share/opensteer/runner-oci.json");
  });

  it("keeps pivot_root capability-gated in the Docker source policy", async () => {
    const profile = JSON.parse(
      await readFile(resolve("deploy/container/chromium-seccomp.json"), "utf8"),
    ) as {
      readonly syscalls: readonly {
        readonly action: string;
        readonly includes?: { readonly caps?: readonly string[] };
        readonly names: readonly string[];
      }[];
    };
    const pivotRules = profile.syscalls.filter(({ names }) => names.includes("pivot_root"));
    expect(pivotRules).toEqual([
      expect.objectContaining({
        action: "SCMP_ACT_ALLOW",
        includes: { caps: ["CAP_SYS_ADMIN"] },
      }),
    ]);
  });

  it("makes the immutable record the final non-empty layer of all eight images", async () => {
    const containerfile = await readFile(resolve("deploy/container/Containerfile"), "utf8");
    const targetNames = [
      "host",
      "control-plane",
      "runner",
      "browser-egress",
      "browser-profile-gateway",
      "channel-runtime",
      "browser-runtime",
      "gateway",
    ];
    for (const name of targetNames) {
      const start = containerfile.indexOf(` AS ${name}\n`);
      const nextStage = containerfile.indexOf("\nFROM ", start + 1);
      const end = nextStage > start ? nextStage : containerfile.length;
      const stage = containerfile.slice(start, end);
      const record = stage.lastIndexOf(
        "COPY --from=opensteer-release-record --chmod=0444 /release/release.json /usr/local/share/opensteer/release.json",
      );
      expect(record, `${name} record`).toBeGreaterThan(0);
      expect(stage.slice(record).match(/^\s*(?:RUN|COPY|ADD)\b/gmu)).toHaveLength(1);
    }
  });

  it("does not ask BuildKit for the retired device identity application", async () => {
    const bake = await readFile(resolve("deploy/container/docker-bake.hcl"), "utf8");
    expect(bake).not.toContain("device-runtime");
  });

  it("publishes every Host internal runtime route and no retired identity sockets", async () => {
    const caddy = await readFile(resolve("deploy/gateway/Caddyfile"), "utf8");
    const allowlist = caddy
      .match(/@runtime_callbacks path ([^\n]+)/u)?.[1]
      ?.trim()
      .split(/\s+/u);
    expect(allowlist).toBeDefined();
    expect(new Set(allowlist)).toEqual(new Set(hostInternalRoutePatterns));
    expect(allowlist).toContain("/internal/v1/computer-use/display");
    // The owner display socket shares the public API prefix, like shell viewers.
    expect(caddy).toMatch(/@host_api path [^\n]* \/v1\/\*/u);
    expect(caddy).not.toContain("/internal/v1/channel-runtime");
    expect(caddy).not.toContain("/internal/v1/devices/connect");
  });
});

interface SeccompProfile {
  readonly architectures: readonly string[];
  readonly defaultAction: string;
  readonly syscalls: readonly { readonly names: readonly string[] }[];
}

function syscalls(profile: SeccompProfile): string[] {
  return profile.syscalls.flatMap(({ names }) => names);
}
