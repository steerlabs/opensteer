import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createId } from "@opensteer/core";
import { z } from "zod";
import { PasswordsBrokerClient } from "../../src/passwords/broker-client.js";
import type { PasswordsJourneyEvidence } from "../../../host/src/browser/passwords-evidence.test-support.js";

let brokerProcess: ChildProcess | undefined;
export function stopPasswordsPolicyBroker(): void {
  brokerProcess?.kill("SIGTERM");
}
const Snapshot = z.object({
  grants: z.array(
    z.object({
      deploymentId: z.string(),
      site: z.string(),
      permissionVersion: z.number(),
      revision: z.number(),
      loginId: z.string(),
      deploymentName: z.string(),
    }),
  ),
  presenceReasons: z.array(z.string()),
  headSeq: z.number(),
});

/** Real encrypted-vault consent policy and authenticated production protocol 10 IPC. */
export async function runPasswordsGrantPolicyJourney(
  evidence: PasswordsJourneyEvidence,
  fields: { username: string; password: string },
) {
  const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "os-pwp-"));
  const clients: PasswordsBrokerClient[] = [];
  let spawnFailure: Error | undefined;
  const observations: Record<string, unknown> = {};
  const site = "https://passwords-fixture.test";
  const scope = {
    deploymentId: createId("deployment"),
    deploymentName: "Acceptance",
    threadTitle: "Consent policy",
    reason: "Sign in to the fixture app",
    site,
  };
  const waitForFile = async (filename: string) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        return await readFile(path.join(root, filename), "utf8");
      } catch (error) {
        if (spawnFailure) throw spawnFailure;
        if (
          Date.now() >= deadline ||
          brokerProcess?.exitCode !== null ||
          brokerProcess?.signalCode !== null
        )
          throw error;
        await delay(25);
      }
    }
  };
  try {
    await writeFile(path.join(root, "seed.json"), JSON.stringify({ site, ...fields }), {
      mode: 0o600,
    });
    brokerProcess = spawn(path.resolve(".electron-smoke/passwords-policy-broker"), [root], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    brokerProcess.once("error", (error) => {
      spawnFailure = error;
    });
    for (const stream of [brokerProcess.stdout, brokerProcess.stderr])
      stream?.on("data", (bytes: Buffer) => evidence.scan("raw-production-policy-broker", bytes));
    await waitForFile("ready");
    const snapshot = async () => {
      const filename = `snapshot-${randomUUID()}.json`;
      brokerProcess!.stdin!.write(`${filename}\n`);
      return Snapshot.parse(JSON.parse(await waitForFile(filename)));
    };
    const bundle = path.resolve("native/passwords/dist/Opensteer Passwords.app");
    const current = new PasswordsBrokerClient({
      appVersion: "1",
      development: true,
      protocolVersion: 10,
      brokerAppPath: bundle,
      verifierAppPath: bundle,
      socketPath: path.join(root, "ipc.sock"),
      lockPath: path.join(root, "client.lock"),
    });
    clients.push(current);
    const request = (transactionId: string, deploymentId = scope.deploymentId) =>
      current.request({
        ...scope,
        deploymentId,
        transactionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        protocolVersion: 10,
        permissionVersion: 6,
      });
    const id = randomUUID();
    const first = await request(id);
    if (first.decision !== "approve") throw new Error("No personal approval card");
    const account = first.accounts[0];
    assert(account);
    assert.equal(
      (
        await current.approve({
          transactionId: id,
          loginId: account.id,
          revision: account.revision,
          remember: true,
          permissionVersion: 6,
        })
      ).decision,
      "authorized",
    );
    assert.equal(
      (await current.release({ transactionId: id, field: "password", kind: "app" })).released,
      false,
      "commit is required before app release",
    );
    assert.equal((await current.commit({ transactionId: id })).committed, true);
    const released = await current.release({ transactionId: id, field: "password", kind: "app" });
    assert.equal(released.released && released.value === fields.password, true);
    await current.cancel(id);
    const before = await snapshot();
    observations.before = before;
    assert.equal(before.grants.length, 1);
    assert.equal(before.grants[0]!.permissionVersion, 6);
    assert.equal(before.grants[0]!.deploymentId, scope.deploymentId);
    assert.equal(before.grants[0]!.revision, account.revision);
    const otherDeploymentId = createId("deployment"),
      onceId = randomUUID();
    const once = await request(onceId, otherDeploymentId);
    assert.equal(once.decision, "approve", "a different personal Deployment needs consent");
    assert.equal(
      (
        await current.approve({
          transactionId: onceId,
          loginId: account.id,
          revision: account.revision,
          remember: false,
          permissionVersion: 6,
        })
      ).decision,
      "authorized",
    );
    await current.commit({ transactionId: onceId });
    await current.cancel(onceId);
    const after = await snapshot();
    observations.afterOneTimeApproval = after;
    assert.deepEqual(
      after.grants,
      before.grants,
      "Only this time leaves every persisted grant field unchanged",
    );
    assert.equal(after.headSeq, before.headSeq);
    const againId = randomUUID();
    assert.equal((await request(againId, otherDeploymentId)).decision, "approve");
    await current.cancel(againId);
    const rememberedId = randomUUID();
    assert.equal((await request(rememberedId)).decision, "authorized");
    await current.cancel(rememberedId);
    observations.afterReRequest = await snapshot();
  } finally {
    for (const client of clients) await client.close();
    if (brokerProcess && brokerProcess.exitCode === null && brokerProcess.signalCode === null) {
      const exited = once(brokerProcess, "exit");
      brokerProcess.kill("SIGTERM");
      await exited;
    }
    brokerProcess = undefined;
    await evidence.write("production-consent-policy.json", observations);
    await rm(root, { recursive: true, force: true });
  }
}
