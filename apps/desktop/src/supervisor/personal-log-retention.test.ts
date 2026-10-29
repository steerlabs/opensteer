import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BoundedPersonalLog, RotatingPersonalLog } from "./personal-process-port.js";

// Failure cases are recorded before implementation in the diagnostics evidence
// directory: polling eviction, errors mistaken for polling, bounds and redaction.
describe("Personal lifecycle log retention journey", () => {
  it("redacts a secret split across stderr chunks before writing private bounded rotated logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-chunk-redaction-"));
    const filePath = path.join(root, "personal-host.log");
    const disk = new RotatingPersonalLog(filePath);
    const secret = "wsa-sensitive-value-123456789";
    const lines = new BoundedPersonalLog(16 * 1024, [secret], (line) =>
      disk.append("stderr", line),
    );
    try {
      for (let index = 0; index < 1800; index++)
        lines.append(`line ${index} ${"x".repeat(1900)}\n`);
      lines.append(`token=${secret.slice(0, 12)}`);
      lines.append(`${secret.slice(12)}\n`);
      lines.flush();
    } finally {
      disk.close();
    }
    try {
      expect(lines.text).toContain("token=[redacted]");
      for (const suffix of ["", ".1", ".lifecycle", ".lifecycle.1"]) {
        const bytes = await readFile(filePath + suffix);
        expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
        expect(bytes.toString()).not.toContain(secret);
        if (process.platform !== "win32")
          expect((await stat(filePath + suffix)).mode & 0o777).toBe(0o600);
      }
      expect(await readFile(filePath, "utf8")).toContain("stderr token=[redacted]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps lifecycle history through HTTP polling while bounding and redacting both streams", async () => {
    const evidence =
      process.env.OPENSTEER_LOG_RETENTION_EVIDENCE_DIR ??
      path.join(tmpdir(), "opensteer-log-retention");
    await mkdir(evidence, { recursive: true });
    const root = await mkdtemp(path.join(evidence, "run-"));
    const filePath = path.join(root, "personal-host.log");
    const disk = new RotatingPersonalLog(filePath);
    const lines = new BoundedPersonalLog(16 * 1024, ["PRIVATE-CREDENTIAL"], (line) =>
      disk.append("stdout", line),
    );
    try {
      lines.append(
        JSON.stringify({ level: 30, msg: "host.realtime.opened", token: "PRIVATE-CREDENTIAL" }) +
          "\n",
      );
      for (let index = 0; index < 10_000; index += 1) {
        lines.append(
          JSON.stringify({
            level: 30,
            reqId: `req-${index}`,
            req: { method: "GET", path: "/v1/rpc/tasks.list" },
            msg: "incoming request",
          }) + "\n",
        );
        lines.append(
          JSON.stringify({
            level: 30,
            reqId: `req-${index}`,
            res: { statusCode: 200 },
            responseTime: 1,
            msg: "request completed",
          }) + "\n",
        );
      }
      lines.append(
        JSON.stringify({ level: 30, res: { statusCode: 503 }, msg: "request completed" }) + "\n",
      );
      lines.flush();
    } finally {
      disk.close();
    }
    const files = (await readdir(root)).filter((name) => name.startsWith("personal-host."));
    const lifecycle = await readFile(`${filePath}.lifecycle`, "utf8");
    expect(lifecycle).toContain("host.realtime.opened");
    expect(lifecycle).toContain("503");
    expect(lifecycle).not.toContain("incoming request");
    expect(lifecycle).not.toContain("PRIVATE-CREDENTIAL");
    expect(lifecycle).toContain("[redacted]");
    expect(files.sort()).toEqual([
      "personal-host.log",
      "personal-host.log.1",
      "personal-host.log.lifecycle",
    ]);
    for (const name of files) {
      const metadata = await stat(path.join(root, name));
      expect(metadata.size).toBeLessThanOrEqual(256 * 1024);
      if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
    }
    await writeFile(
      path.join(root, "result.json"),
      JSON.stringify({ outcome: "passed", pollingRequests: 10_000, files }, null, 2),
    );
    console.info(`Personal log evidence: ${root}`);
  });
});
