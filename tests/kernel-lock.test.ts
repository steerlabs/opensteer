import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { holdCheckoutWrites } from "../packages/shared/src/kernelLock.js";

/*
 * Ways a checkout's build-output lock could fail:
 * - two writers rebuild one checkout's outputs at once, reaching it by
 *   different paths;
 * - one checkout's writer blocks another checkout, or its own children;
 * - an inherited token outlives the hold it names: released, or naming a pid
 *   another process now has.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(50);
  }
}

describe.runIf(process.platform === "darwin")("a checkout's build-output lock", () => {
  it("lets one writer into a checkout at a time, and a token only while its hold lasts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-kernel-lock-"));
    directories.push(root);
    const locks = path.join(root, "locks");
    const lines: string[] = [];
    const options = (purpose: string, environment: NodeJS.ProcessEnv = {}) => ({
      purpose,
      environment: { ...environment, OPENSTEER_LOCK_DIRECTORY: locks },
      log: (line: string) => void lines.push(line),
    });
    const briefly = (environment: NodeJS.ProcessEnv) => ({
      ...options("stale token", environment),
      signal: AbortSignal.timeout(1_000),
    });

    const checkout = path.join(root, "checkout");
    const elsewhere = path.join(root, "elsewhere");
    const alias = path.join(root, "alias");
    await mkdir(checkout);
    await mkdir(elsewhere);
    await symlink(checkout, alias);
    const first = options("first check");
    const held = await holdCheckoutWrites(checkout, first);
    // Another checkout is independent, and the holder's children are part of its work.
    (await holdCheckoutWrites(elsewhere, options("elsewhere"))).release();
    (await holdCheckoutWrites(checkout, options("child", first.environment))).release();

    let admitted = false;
    const second = holdCheckoutWrites(alias, options("second check")).then((hold) => {
      admitted = true;
      return hold;
    });
    await until(
      () =>
        lines.some((line) => line.includes(`pid ${process.pid}`) && line.includes("first check")),
      "the second writer to name the first",
    );
    expect(admitted).toBe(false);
    // A released hold's token, still in this live process's environment, admits nothing.
    const released = { ...first.environment };
    held.release();
    const current = await second;
    await expect(holdCheckoutWrites(checkout, briefly(released))).rejects.toBeDefined();

    // Nor does a crashed holder's record whose pid this process now has.
    const real = await realpath(checkout);
    const owners = path.join(
      locks,
      `checkout-${createHash("sha256").update(real).digest("hex").slice(0, 16)}.owners`,
    );
    await mkdir(owners, { recursive: true });
    await writeFile(
      path.join(owners, `${process.pid}-0badc0de.json`),
      JSON.stringify({
        pid: process.pid,
        purpose: "crashed",
        cwd: "/",
        started: "Thu Jan  1 1970",
      }),
    );
    await expect(
      holdCheckoutWrites(
        checkout,
        briefly({ OPENSTEER_CHECKOUT_WRITER: `${process.pid}:0badc0de:${real}` }),
      ),
    ).rejects.toBeDefined();
    current.release();
  });
});
