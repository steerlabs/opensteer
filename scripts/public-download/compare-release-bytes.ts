import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { journeyMetadata, requireCertifiedJourneys } from "./evidence.js";
import { releaseComparison, releaseInspection } from "./release-comparison.js";
const { values } = parseArgs({
  options: {
    ci: { type: "string" },
    local: { type: "string" },
    certification: { type: "string" },
    out: { type: "string" },
    channel: { type: "string" },
  },
});
const channel = z.enum(["stable", "beta"]).parse(values.channel);
const ciZip = z.string().refine(path.isAbsolute).parse(values.ci);
const localZip = z.string().refine(path.isAbsolute).parse(values.local);
const out = z.string().refine(path.isAbsolute).parse(values.out);
const certification = z
  .object({
    evidenceKind: z.literal("certification"),
    metadata: journeyMetadata,
    passed: z.literal(true),
    builds: z.array(
      z.object({
        channel: z.enum(["stable", "beta"]),
        version: z.string(),
        revision: z.string(),
        sha256: z.string(),
      }),
    ),
    results: z.array(z.object({ name: z.string(), passed: z.literal(true) })),
  })
  .parse(JSON.parse(readFileSync(z.string().parse(values.certification), "utf8")));
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
requireCertifiedJourneys(certification, channel, hash(localZip));
const temporary = mkdtempSync(path.join(tmpdir(), "opensteer-release-bridge-"));
const command = (exe: string, args: string[], input?: string) => {
  const r = spawnSync(exe, args, { encoding: "utf8", input, timeout: 120_000 });
  return { status: r.status, output: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
};
const required = (exe: string, args: string[], input?: string) => {
  const result = command(exe, args, input);
  if (result.status !== 0) throw Error(`${exe} failed: ${result.output}`);
  return result;
};
try {
  const inspect = (zip: string, side: string) => {
    const extraction = path.join(temporary, side);
    required("ditto", ["-x", "-k", zip, extraction]);
    const app = path.join(
      extraction,
      channel === "stable" ? "Opensteer.app" : "Opensteer Beta.app",
    );
    required("codesign", ["--verify", "--deep", "--strict", app]);
    const plist = (key: string) =>
      required("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        `${app}/Contents/Info.plist`,
      ]).stdout.trim();
    const signed: string[] = [];
    const visit = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const file = path.join(directory, item.name);
        if (item.isDirectory()) visit(file);
        if (item.isDirectory() && item.name.endsWith(".app")) signed.push(file);
        if (item.isFile()) {
          const fd = openSync(file, "r"),
            header = Buffer.alloc(16);
          try {
            const length = readSync(fd, header, 0, 16, 0);
            if (length === 16) {
              const magic = header.readUInt32BE(0);
              let offset = 0;
              if (magic === 0xcafebabe || magic === 0xcafebabf) {
                const architecture = Buffer.alloc(24);
                readSync(fd, architecture, 0, 24, 8);
                offset =
                  magic === 0xcafebabe
                    ? architecture.readUInt32BE(8)
                    : Number(architecture.readBigUInt64BE(8));
                readSync(fd, header, 0, 16, offset);
              }
              if (
                [0xfeedfacf, 0xfeedface].includes(header.readUInt32LE(0)) &&
                header.readUInt32LE(12) === 2
              )
                signed.push(file);
            }
          } finally {
            closeSync(fd);
          }
        }
      }
    };
    visit(app);
    signed.push(app);
    const components = signed.map((file) => {
      const identity = required("codesign", ["-dv", "--verbose=4", file]).output;
      const requirement = required("codesign", ["-d", "-r-", file])
        .output.split("\n")
        .find((l) => l.startsWith("designated =>"));
      const entitlements = required("codesign", ["-d", "--entitlements", ":-", file]).stdout.trim();
      const parsed = entitlements
        ? JSON.parse(required("plutil", ["-convert", "json", "-o", "-", "-"], entitlements).stdout)
        : {};
      return {
        path: path.relative(app, file) || ".",
        requirement,
        teamId: /^TeamIdentifier=(.+)$/mu.exec(identity)?.[1],
        identifier: /^Identifier=(.+)$/mu.exec(identity)?.[1],
        hardenedRuntime: /flags=.*\bruntime\b/u.test(identity),
        entitlements: parsed,
      };
    });
    return releaseInspection.parse({
      revision: plist("OpensteerSourceRevision"),
      channel,
      version: plist("CFBundleShortVersionString"),
      bundleVersion: plist("CFBundleVersion"),
      bundleId: plist("CFBundleIdentifier"),
      sha256: hash(zip),
      components,
      assessment: required("spctl", ["-a", "-vv", app]),
      staple: required("xcrun", ["stapler", "validate", app]),
    });
  };
  const evidence = releaseComparison.parse({
    metadata: certification.metadata,
    ci: inspect(ciZip, "ci"),
    local: inspect(localZip, "local"),
  });
  if (
    evidence.local.revision !== certified.revision ||
    evidence.local.version !== certified.version
  )
    throw Error("Certified source/version does not match local bundle");
  writeFileSync(out, JSON.stringify({ passed: true, ...evidence }, null, 2));
} catch (error) {
  writeFileSync(
    out,
    JSON.stringify(
      z
        .object({ passed: z.literal(false), error: z.string() })
        .parse({ passed: false, error: String(error) }),
      null,
      2,
    ),
  );
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
