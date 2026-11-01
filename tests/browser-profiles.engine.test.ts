import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelSelectionSchema } from "../packages/core/src/index.js";
import { nativeUserHarnessRuntimeBoundary } from "../packages/harness/src/index.js";
import { parseAgentExecutionConfig } from "../apps/runner/src/app-config.js";
import { createHarnessRegistry } from "../apps/runner/src/harness/harness-registry.js";
import {
  startVerticalStack,
  type VerticalStack,
} from "../apps/host/src/agents/vertical-stack.test-support.js";
import {
  addCleanup,
  browserAvailable,
  browserHarness,
  executablePath,
  profileRevision,
  startBrowser,
  waitFor,
} from "./browser-deployment.test-support.js";

/*
 * The request that once went wrong, put to a real engine on this computer's
 * own sign-in through a whole deployment: "create a new browser profile called
 * work, then sign in to my account". A local site stands in for the account,
 * and only the person knows its password. The agent must create "work" and
 * open the site in it, never in a Guest browser and never by copying one; the
 * person's sign-in in that tab must end up saved in "work".
 */
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const driverKind = process.env.OPENSTEER_PROFILE_ENGINE ?? "claude";
const sourceIds: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai" };

describe("live agent-created browser profile", () => {
  it("creates the named profile and keeps the person's sign-in in it", async () => {
    if (!databaseUrl) throw new Error("Run the engine suite through pnpm test:engines");
    if (!executablePath) throw new Error("A Chromium executable is required");
    const sourceId = sourceIds[driverKind];
    if (!sourceId) throw new Error(`No first-party source for ${driverKind}`);
    const evidence: Record<string, unknown> = {
      driverKind,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    };
    try {
      const browser = await startBrowser();
      let stack: VerticalStack | undefined;
      // Registered before the deployment starts, so a failed start still closes
      // the Browser Runtime; final profile commits need the Host to outlive it.
      addCleanup("live profile Browser Runtime, then deployment", async () => {
        try {
          await browser.close();
        } finally {
          await stack?.close();
        }
      });
      stack = await startVerticalStack({
        browser,
        browserHarnessExecutable: browserHarness,
        catalogTimeoutMs: 180_000,
        databaseUrl,
        harnessInstance: { config: {}, driverKind, sourceId, stateKind: "ambient" },
        harnesses: createHarnessRegistry(
          parseAgentExecutionConfig(process.env).harnessExecutables,
          {
            nodeExecutable: process.execPath,
            runtimeCacheDirectory: path.join(tmpdir(), "opensteer-test-runtime-cache"),
          },
        ),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        runTimeoutMs: 600_000,
      });
      await browserAvailable(stack);
      const origin = await ledgerSite();
      const model = stack.catalog.models.find((candidate) => candidate.isDefault);
      if (!model) throw new Error("The engine has no default model");
      evidence.model = model.modelId;
      const home = await stack.createThread({
        home: true,
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
        title: "Chat",
        workspaceId: stack.mainWorkspaceId,
      });

      const ask = `can u create a new browser profile called work for me? And then please sign in to my Ledger account at ${origin}`;
      const first = await stack.sendMessage({
        text: ask,
        threadId: home,
        workspaceId: stack.mainWorkspaceId,
      });
      evidence.turns = [{ ask, reply: first.assistantText, runId: first.runId }];

      const afterFirst = await stack.api["bootstrap.get"]({});
      if (!afterFirst.ok) throw new Error(afterFirst.error.message);
      const { profiles, sessions } = afterFirst.data.browser;
      const saveRequests = await stack.host.store.database
        .selectFrom("requests")
        .select(["id", "status"])
        .where("kind", "=", "browser.profile.save")
        .execute();
      const onSite = sessions.filter((session) =>
        session.tabCatalog?.tabs.some((tab) => tab.site === origin),
      );
      Object.assign(evidence, {
        profiles: profiles.map(({ id, name }) => ({ id, name })),
        saveRequests,
        sessions: sessions.map((session) => ({
          id: session.id,
          profileId: session.profileId,
          sites: session.tabCatalog?.tabs.map((tab) => tab.site) ?? null,
          state: session.state,
        })),
      });
      const work = profiles.filter((profile) => profile.name.trim().toLowerCase() === "work");
      expect(work, "exactly one profile named work").toHaveLength(1);
      expect(saveRequests, "no Guest session was copied into a profile").toEqual([]);
      expect(onSite.length, "the account's site is open for the person").toBeGreaterThan(0);
      expect(
        onSite.map((session) => session.profileId),
        "every browser on the account's site is the work profile",
      ).toEqual(onSite.map(() => work[0]!.id));

      // The person signs in, in the tab the agent left for them.
      const signedIn = await stack.api["commands.dispatch"]({
        idempotencyKey: randomUUID(),
        sessionId: onSite[0]!.id,
        type: "browser.tab.open",
        url: `${origin}/person-signed-in`,
      });
      if (!signedIn.ok) throw new Error(signedIn.error.message);

      const confirm = "Ok i logged in. Can you check that I'm signed in to Ledger?";
      const second = await stack.sendMessage({
        text: confirm,
        threadId: home,
        workspaceId: stack.mainWorkspaceId,
      });
      (evidence.turns as unknown[]).push({
        ask: confirm,
        reply: second.assistantText,
        runId: second.runId,
      });

      const owner = await stack.host.store.firstUser();
      if (!owner) throw new Error("Missing owner");
      let siteData: unknown;
      await waitFor(async () => {
        if ((await profileRevision(stack, work[0]!.id)) === 0) return false;
        const read = await stack.host.browser.profileSiteData({
          ownerId: owner.id,
          profileIds: [work[0]!.id],
          site: origin,
        });
        siteData = read.profiles.get(work[0]!.id);
        return read.profiles.get(work[0]!.id)?.hasData === true;
      }, 60_000);
      evidence.siteData = siteData;
      expect(second.assistantText, "the agent confirms the signed-in account").toMatch(
        /alex@ledger\.test/iu,
      );
      evidence.outcome = "passed";
    } catch (error) {
      evidence.outcome = "failed";
      evidence.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      const directory =
        process.env.OPENSTEER_ENGINE_E2E_OUTPUT ?? path.join(tmpdir(), "opensteer-profile-engine");
      await mkdir(directory, { recursive: true });
      const artifact = path.join(directory, `browser-profiles-${driverKind}-${Date.now()}.json`);
      await writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
      process.stdout.write(`live browser profile evidence: ${artifact}\n`);
    }
  });
});

/** An account only the person can sign in to: the agent never learns its password. */
async function ledgerSite(): Promise<string> {
  const page = (body: string) =>
    `<!doctype html><title>Ledger</title><body><h1>Ledger</h1>${body}</body>`;
  const site = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://ledger.test");
    const signedIn = request.headers.cookie?.split("; ").includes("ledger_session=alex") === true;
    if (url.pathname === "/person-signed-in") {
      // Where the person's own sign-in lands: only the test, acting as them, opens it.
      response.writeHead(302, {
        location: "/account",
        "set-cookie": "ledger_session=alex; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax",
      });
      response.end();
      return;
    }
    response.writeHead(url.pathname === "/login" && request.method === "POST" ? 401 : 200, {
      "content-type": "text/html; charset=utf-8",
    });
    if (url.pathname === "/login") {
      response.end(
        page(
          `${request.method === "POST" ? "<p>Wrong email or password.</p>" : ""}<form method="post" action="/login"><label>Email <input name="email" type="email" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
        ),
      );
      return;
    }
    response.end(
      page(
        signedIn
          ? "<p>Signed in as alex@ledger.test</p><p>Balance: $12,480.00</p>"
          : '<p>You are signed out.</p><a href="/login">Sign in</a>',
      ),
    );
  });
  site.listen(0, "127.0.0.1");
  addCleanup("Ledger website", async () => {
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });
  await once(site, "listening");
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Ledger did not bind loopback");
  return `http://127.0.0.1:${address.port}`;
}
