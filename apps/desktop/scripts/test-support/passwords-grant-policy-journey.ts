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
      workspaceId: z.string(),
      site: z.string(),
      permissionVersion: z.number(),
      revision: z.number(),
      loginId: z.string(),
      deploymentName: z.string(),
      workspaceName: z.string(),
    }),
  ),
  presenceReasons: z.array(z.string()),
  headSeq: z.number(),
});

/** Real encrypted-vault consent policy and authenticated production v4/v5 IPC. */
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
    deploymentId: "personal",
    deploymentName: "Acceptance",
    workspaceId: createId("workspace"),
    workspaceName: "Synthetic workspace",
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
    const client = (version: 4 | 5) => {
      const value = new PasswordsBrokerClient({
        appVersion: "1",
        development: true,
        protocolVersion: version,
        brokerAppPath: bundle,
        verifierAppPath: bundle,
        socketPath: path.join(root, "ipc.sock"),
        lockPath: path.join(root, `client-${version}.lock`),
      });
      clients.push(value);
      return value;
    };
    const legacy = client(4);
    const id = randomUUID();
    const legacyDecision = await legacy.request({
      ...scope,
      transactionId: id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      runtimeId: "desktop-policy",
      sessionId: "legacy-policy",
    });
    assert.equal(legacyDecision.decision, "approve");
    if (legacyDecision.decision !== "approve") throw new Error("No legacy approval card");
    const account = legacyDecision.accounts[0];
    assert(account);
    assert.equal(
      (
        await legacy.approve({
          transactionId: id,
          loginId: account.id,
          revision: account.revision,
          remember: true,
        })
      ).decision,
      "authorized",
    );
    await legacy.cancel(id);
    const before = await snapshot();
    observations.before = before;
    assert.equal(before.grants.length, 1);
    assert.equal(before.grants[0]!.permissionVersion, 4);
    const modern = client(5);
    const request = (transactionId: string) =>
      modern.request({
        ...scope,
        transactionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        protocolVersion: 5,
        permissionVersion: 5,
      });
    const modernId = randomUUID();
    const modernDecision = await request(modernId);
    assert.equal(
      modernDecision.decision,
      "approve",
      "a stored v4 grant never authorizes an app transaction",
    );
    if (modernDecision.decision !== "approve") throw new Error("No expanded consent card");
    assert.equal(
      (
        await modern.approve({
          transactionId: modernId,
          loginId: account.id,
          revision: account.revision,
          remember: false,
        })
      ).decision,
      "authorized",
    );
    const after = await snapshot();
    observations.afterOneTimeApproval = after;
    assert.deepEqual(
      after.grants,
      before.grants,
      "Only this time leaves every persisted grant field unchanged",
    );
    assert.equal(after.headSeq, before.headSeq);
    assert.equal(after.presenceReasons.length, before.presenceReasons.length + 1);
    assert.match(after.presenceReasons.at(-1)!, /websites and in apps/u);
    assert.match(after.presenceReasons.at(-1)!, /tricked agent/u);
    const released = await modern.release({
      transactionId: modernId,
      field: "password",
      kind: "app",
    });
    assert.equal(
      released.released && released.value === fields.password,
      true,
      "one-time v5 approval really releases the selected saved password to an app",
    );
    observations.appReleaseMatches = true;
    await modern.cancel(modernId);
    const againId = randomUUID();
    assert.equal(
      (await request(againId)).decision,
      "approve",
      "one-time consent did not upgrade the remembered v4 grant",
    );
    await modern.cancel(againId);
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
