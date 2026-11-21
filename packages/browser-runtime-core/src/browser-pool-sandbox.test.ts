import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBrowserSandbox } from "./browser-pool-sandbox.js";

async function proc(processes: Record<string, { cmdline: string[]; status: string }>) {
  const root = await mkdtemp(join(tmpdir(), "opensteer-proc-"));
  for (const [pid, { cmdline, status }] of Object.entries(processes)) {
    await mkdir(join(root, pid));
    await writeFile(join(root, pid, "cmdline"), `${cmdline.join("\0")}\0`);
    await writeFile(join(root, pid, "status"), status);
  }
  await mkdir(join(root, "self"));
  return root;
}

const sandboxed = "Name:\tchrome\nNoNewPrivs:\t1\nSeccomp:\t2\nNSpid:\t812\t3\n";

describe("Chromium's sandbox read from /proc", () => {
  it("reads every renderer's seccomp, no_new_privs and pid namespace", async () => {
    const root = await proc({
      "10": { cmdline: ["chrome", "--type=renderer", "--lang=en"], status: sandboxed },
      "11": { cmdline: ["chrome", "--type=gpu-process"], status: "Seccomp:\t0\n" },
      "12": { cmdline: ["node", "dist/main.js"], status: "Seccomp:\t0\n" },
    });
    expect(await readBrowserSandbox(root)).toEqual({
      renderers: [{ pid: 10, type: "renderer", seccomp: 2, noNewPrivs: true, nspid: [812, 3] }],
      others: [{ pid: 11, type: "gpu-process", seccomp: 0, noNewPrivs: null, nspid: [] }],
      sandboxed: true,
    });
  });

  it("says unsandboxed for a renderer without a filter or its own namespace, or with none", async () => {
    const plain = await proc({
      "10": {
        cmdline: ["chrome", "--type=renderer", "--no-sandbox"],
        status: "NoNewPrivs:\t1\nSeccomp:\t0\nNSpid:\t10\n",
      },
    });
    expect((await readBrowserSandbox(plain)).sandboxed).toBe(false);
    expect((await readBrowserSandbox(await proc({}))).sandboxed).toBe(false);
  });
});

describe("a renderer whose process title Chromium rewrote", () => {
  it("is found when its arguments are one space-separated string", async () => {
    // Chromium sets its own process title: /proc/<pid>/cmdline is then one string, not
    // NUL-separated arguments (seen in a pool guest).
    const root = await mkdtemp(join(tmpdir(), "opensteer-proc-"));
    await mkdir(join(root, "20"));
    await writeFile(join(root, "20", "cmdline"), "/chrome --type=renderer --lang=en\0");
    await writeFile(join(root, "20", "status"), sandboxed);
    expect((await readBrowserSandbox(root)).renderers).toHaveLength(1);
  });
});
