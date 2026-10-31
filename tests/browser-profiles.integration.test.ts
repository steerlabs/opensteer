import { encodeBrowserProfileSnapshot } from "../packages/browser-profile/src/snapshot.js";
import type { RunnerDescriptor } from "../packages/protocol/src/index.js";
/**
 * Written against CONTRACTS.md before implementation. Failure journeys:
 * Guest copies lose later login; create replays duplicate identities; restricted
 * threads gain authority; continuations guess labels; sleeping tabs lose identity;
 * clients rely on polling; saved-site lookup guesses login from profile names.
 * Every journey records its inputs, observed IDs, assertions and failure outside
 * the checkout, including when a missing tool prevents later steps from running.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  BrowserProfileIdSchema,
  createId,
  ModelSelectionSchema,
  RequestIdSchema,
  ThreadIdSchema,
  type ThreadId,
} from "../packages/core/src/index.js";
import type { VerticalStack } from "../apps/host/src/agents/vertical-stack.test-support.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import {
  HttpHostClient,
  type WebSocketClient,
} from "../packages/client/src/host/host-session-client.js";
import {
  addCleanup,
  browserAvailable,
  deployment,
  grantedProfile,
  profileRevision,
  run,
  startBrowser,
  waitFor,
} from "./browser-deployment.test-support.js";

const evidenceDirectory = process.env.OPENSTEER_BROWSER_PROFILES_EVIDENCE_DIR
  ? Promise.resolve(process.env.OPENSTEER_BROWSER_PROFILES_EVIDENCE_DIR)
  : mkdtemp(path.join(tmpdir(), "opensteer-browser-profiles-"));
const profileSchema = z.object({ id: BrowserProfileIdSchema, name: z.string() });
const reportSchema = z
  .object({
    inputText: z.string(),
    tools: z.array(z.string()).optional(),
    error: z.string().optional(),
    created: z.object({ profile: profileSchema }).optional(),
    replayed: z.object({ profile: profileSchema }).optional(),
    independent: z.object({ profile: profileSchema }).optional(),
    opened: z
      .object({
        session: z.object({ id: z.string(), profileId: z.string().nullable() }).passthrough(),
      })
      .optional(),
    page: z.object({ signedIn: z.boolean(), url: z.string() }).optional(),
    request: z.object({ requestId: RequestIdSchema }).passthrough().optional(),
    delegated: z
      .object({ thread: z.object({ id: ThreadIdSchema }) })
      .passthrough()
      .optional(),
    profiles: z
      .object({
        profiles: z.array(
          profileSchema.extend({
            siteData: z.object({ hasData: z.boolean(), savedAt: z.string().nullable() }).optional(),
          }),
        ),
        site: z.string().optional(),
      })
      .optional(),
    // Missing identity is preserved as undefined so the assertion, rather than
    // the observer's parser, exposes the old Host's omission.
    tabs: z
      .array(
        z
          .object({
            tabId: z.string(),
            state: z.string(),
            sessionId: z.string().nullable(),
            profileId: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
type Report = z.infer<typeof reportSchema>;
interface Evidence {
  observations: unknown[];
  assertions: { label: string; actual: unknown; expected: unknown }[];
}

function journey(id: string, body: (evidence: Evidence) => Promise<void>): void {
  it(
    id,
    async () => {
      const evidence: Evidence = { observations: [], assertions: [] };
      let outcome = "failed";
      let failure: string | undefined;
      try {
        await body(evidence);
        outcome = "passed";
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        const directory = await evidenceDirectory;
        await mkdir(directory, { recursive: true });
        const artifact = path.join(directory, `${id.split(" ")[0]}-${randomUUID()}.json`);
        await writeFile(
          artifact,
          JSON.stringify(
            {
              journey: id,
              outcome,
              failure,
              command: "pnpm test:integration tests/browser-profiles.integration.test.ts",
              gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
              ...evidence,
            },
            null,
            2,
          ) + "\n",
        );
        process.stdout.write(`browser profiles evidence: ${artifact}\n`);
      }
    },
    180_000,
  );
}

function equal(evidence: Evidence, label: string, actual: unknown, expected: unknown): void {
  evidence.assertions.push({
    label,
    actual: actual === undefined ? { missing: true } : actual,
    expected,
  });
  expect(actual, label).toEqual(expected);
}

async function profileDeployment() {
  const browser = await startBrowser();
  addCleanup("profile journey Browser Runtime", () => browser.close());
  const stack = await deployment(browser, undefined, {
    scenario: "browser-profiles",
    maxConcurrentRuns: 2,
  });
  await browserAvailable(stack);
  return { stack, browser };
}

async function fixtureAccount(): Promise<string> {
  const site = createServer((request, response) => {
    const login = request.url === "/login";
    const signedIn =
      login || request.headers.cookie?.split("; ").includes("fixture_session=signed-in") === true;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      ...(login
        ? {
            "set-cookie":
              "fixture_session=signed-in; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax",
          }
        : {}),
    });
    response.end(
      `<!doctype html><title>Fixture account</title><body data-signed-in="${signedIn}">${signedIn ? "Fixture account signed in" : "Fixture account signed out"}</body>`,
    );
  });
  site.listen(0, "127.0.0.1");
  addCleanup("profile fixture website", async () => {
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  });
  await once(site, "listening");
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind loopback");
  return `http://127.0.0.1:${address.port}`;
}

async function profileTurn(
  stack: VerticalStack,
  evidence: Evidence,
  plan: Record<string, unknown>,
  threadId?: ThreadId,
  workspaceId = stack.mainWorkspaceId,
): Promise<{ report: Report; threadId: ThreadId }> {
  threadId ??= await stack.createThread({
    idempotencyKey: randomUUID(),
    title: "Browser profile journey",
    workspaceId,
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      providerId: "openai",
      options: {},
    }),
  });
  const result = await stack.sendMessage({
    threadId,
    workspaceId,
    text: `BROWSER_PROFILE_JOURNEY:${JSON.stringify(plan)}`,
  });
  const raw: unknown = JSON.parse(result.assistantText);
  evidence.observations.push({ threadId, workspaceId, runId: result.runId, report: raw });
  const report = reportSchema.parse(raw);
  if (report.error) throw new Error(report.error);
  return { report, threadId };
}

async function connectedPeople(stack: VerticalStack): Promise<HttpHostClient[]> {
  const clients: HttpHostClient[] = [];
  for (let index = 0; index < 2; index++) {
    const client = new HttpHostClient({
      baseUrl: stack.hostOrigin,
      refreshIntervalMs: 0,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      webSocketFactory: (url) =>
        new WebSocket(url, {
          headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
        }) as unknown as WebSocketClient,
    });
    addCleanup(`profile person client ${index}`, async () => client.dispose());
    await client.load();
    clients.push(client);
  }
  await waitFor(
    async () => clients.every((client) => client.getSnapshot().connection === "connected"),
    15_000,
  );
  return clients;
}

async function fulfillNewProfile(
  stack: VerticalStack,
  evidence: Evidence,
  people?: HttpHostClient[],
) {
  const workspace = await stack.createWorkspace("Brex specialized workspace");
  const first = await profileTurn(stack, evidence, { request: true }, undefined, workspace.id);
  const requestId = first.report.request!.requestId;
  const resolved = await stack.api["commands.dispatch"]({
    type: "request.respond",
    requestId,
    idempotencyKey: randomUUID(),
    response: {
      kind: "external",
      value: { decision: "fulfilled", createProfile: { name: "Brex Ops" } },
    },
  });
  evidence.observations.push({ resolved });
  if (!resolved.ok) throw new Error(resolved.error.message);
  const bootstrap = await stack.api["bootstrap.get"]({});
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);
  const profile = bootstrap.data.browser.profiles.find((profile) => profile.name === "Brex Ops");
  if (!profile) throw new Error("Request did not create Brex Ops");
  evidence.observations.push({
    requestId,
    profile,
    sessionIds: bootstrap.data.browser.sessions.map((session) => session.id),
  });
  if (people) {
    try {
      await waitFor(
        async () =>
          people.every((client) =>
            client.getSnapshot().browserProfiles.some((row) => row.id === profile.id),
          ),
        10_000,
      );
    } finally {
      evidence.observations.push({
        people: people.map((client) => client.getSnapshot().browserProfiles),
      });
    }
  }
  return { ...first, workspaceId: workspace.id, profile, requestId };
}

run("Browser profiles through a whole deployment", () => {
  journey("J1a legacy copy reproduces the Guest login trap", async (evidence) => {
    const { stack } = await profileDeployment();
    const origin = await fixtureAccount();
    const first = await profileTurn(stack, evidence, {
      open: { fresh: true },
      visit: `${origin}/account`,
    });
    const guest = first.report.opened!.session;
    equal(evidence, "agent opened Guest", guest.profileId, null);
    equal(evidence, "Guest starts signed out", first.report.page!.signedIn, false);
    const saved = await stack.api["commands.dispatch"]({
      type: "browser.session.profile.save",
      sessionId: guest.id,
      idempotencyKey: randomUUID(),
      input: { name: "copied" },
    });
    evidence.observations.push({ saved });
    if (!saved.ok || saved.data.type !== "browser.session.profile.save")
      throw new Error(JSON.stringify(saved));
    const login = await profileTurn(
      stack,
      evidence,
      { sessionId: guest.id, visit: `${origin}/login` },
      first.threadId,
    );
    equal(evidence, "person signs in in the original Guest tab", login.report.page!.signedIn, true);
    equal(
      evidence,
      "copy did not convert the Guest identity",
      login.report.opened!.session.profileId,
      null,
    );
    await profileTurn(stack, evidence, { sessionId: guest.id, close: true }, first.threadId);
    const copied = await profileTurn(
      stack,
      evidence,
      { open: { profileId: saved.data.profile.id }, visit: `${origin}/account`, close: true },
      first.threadId,
    );
    equal(
      evidence,
      "copied profile lost the later Guest login (incident)",
      copied.report.page!.signedIn,
      false,
    );
  });

  journey("J1b create before login persists the exact identity across turns", async (evidence) => {
    const { stack } = await profileDeployment();
    const origin = await fixtureAccount();
    const first = await profileTurn(stack, evidence, {
      create: { name: "work" },
      open: "created",
      visit: `${origin}/login`,
      close: true,
    });
    const profile = first.report.created!.profile;
    equal(
      evidence,
      "sign-in session belongs to the created profile",
      first.report.opened!.session.profileId,
      profile.id,
    );
    equal(evidence, "fixture login succeeded", first.report.page!.signedIn, true);
    await waitFor(async () => (await profileRevision(stack, profile.id)) > 0, 20_000);
    evidence.observations.push({
      profileId: profile.id,
      savedRevision: await profileRevision(stack, profile.id),
    });
    const later = await profileTurn(
      stack,
      evidence,
      { open: { profileId: profile.id }, visit: `${origin}/account`, close: true },
      first.threadId,
    );
    equal(evidence, "later turn retained sign-in", later.report.page!.signedIn, true);
    const guest = await profileTurn(
      stack,
      evidence,
      { open: { fresh: true }, visit: `${origin}/account`, close: true },
      first.threadId,
    );
    equal(evidence, "later Guest remains isolated", guest.report.page!.signedIn, false);
  });

  journey("J2 creation replay and independent same-name calls", async (evidence) => {
    const { stack } = await profileDeployment();
    const { report } = await profileTurn(stack, evidence, {
      create: { name: "work", replay: true, independent: true },
    });
    equal(
      evidence,
      "same JSON-RPC call replays the same identity",
      report.replayed!.profile.id,
      report.created!.profile.id,
    );
    equal(
      evidence,
      "independent call creates a distinct identity",
      report.independent!.profile.id === report.created!.profile.id,
      false,
    );
    const bootstrap = await stack.api["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    equal(evidence, "creation opened no session", bootstrap.data.browser.sessions.length, 0);
    equal(
      evidence,
      "exactly two profiles were created",
      bootstrap.data.browser.profiles.map((profile) => profile.id).sort(),
      [report.created!.profile.id, report.independent!.profile.id].sort(),
    );
  });

  journey(
    "J2-authority current Main Workspace and delegated tool inventories",
    async (evidence) => {
      const { stack } = await profileDeployment();
      const workspace = await stack.createWorkspace("Specialized authority");
      const main = await profileTurn(stack, evidence, {});
      const specialized = await profileTurn(stack, evidence, {}, undefined, workspace.id);
      const delegated = await profileTurn(
        stack,
        evidence,
        { delegate: workspace.id },
        main.threadId,
      );
      const childId = delegated.report.delegated!.thread.id;
      let child: Report | undefined;
      await waitFor(async () => {
        const snapshot = await stack.host.store.workspaceSnapshot(workspace.id);
        const text = snapshot.messages
          .filter((message) => message.threadId === childId && message.kind === "assistant")
          .flatMap((message) => message.content)
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .at(-1);
        if (!text) return false;
        child = reportSchema.parse(JSON.parse(text));
        return true;
      }, 30_000);
      evidence.observations.push({ kind: "delegated", threadId: childId, report: child });
      evidence.observations.push({
        inventories: {
          main: main.report.tools,
          workspace: specialized.report.tools,
          delegated: child!.tools,
        },
      });
      for (const [kind, report] of [
        ["main", main.report],
        ["workspace", specialized.report],
        ["delegated", child!],
      ] as const) {
        equal(
          evidence,
          `${kind} has create only when Main`,
          report.tools!.includes("browser_profile_create"),
          kind === "main",
        );
        equal(
          evidence,
          `${kind} does not offer retired save`,
          report.tools!.includes("browser_profile_save"),
          false,
        );
        equal(
          evidence,
          `${kind} does not offer retired sign-in`,
          report.tools!.includes("browser_sign_in"),
          false,
        );
      }
    },
  );

  journey(
    "J3 renamed Request outcome survives restart and names its exact profile",
    async (evidence) => {
      const { stack } = await profileDeployment();
      const result = await fulfillNewProfile(stack, evidence);
      await stack.restartHost();
      await browserAvailable(stack);
      let continuation: Report | undefined;
      await waitFor(async () => {
        const snapshot = await stack.host.store.workspaceSnapshot(result.workspaceId);
        for (const message of snapshot.messages.filter(
          (message) => message.threadId === result.threadId && message.kind === "assistant",
        )) {
          for (const part of message.content) {
            if (part.type !== "text") continue;
            const parsed = reportSchema.safeParse(JSON.parse(part.text));
            if (
              parsed.success &&
              parsed.data.inputText.includes(`Request ${result.requestId} was fulfilled.`)
            )
              continuation = parsed.data;
          }
        }
        return continuation !== undefined;
      }, 30_000);
      evidence.observations.push({ continuation, profile: result.profile });
      const expected = `Request ${result.requestId} was fulfilled. Browser profile "Brex Ops" (${result.profile.id}) is now available to this Workspace. Open it with browser_session_open and profileId ${result.profile.id}, then continue the task.`;
      equal(
        evidence,
        "continuation identifies Host-created renamed profile",
        continuation!.inputText.includes(expected),
        true,
      );
      equal(
        evidence,
        "continuation lists the exact available identity",
        continuation!.profiles!.profiles.map((profile) => ({ id: profile.id, name: profile.name })),
        [{ id: result.profile.id, name: "Brex Ops" }],
      );
      const request = await stack.host.store.database
        .selectFrom("requests")
        .select("response")
        .where("id", "=", result.requestId)
        .executeTakeFirstOrThrow();
      evidence.observations.push({ storedResponse: request.response });
      expect(request.response).toMatchObject({
        kind: "external",
        value: { profile: { id: result.profile.id, name: "Brex Ops" } },
      });
    },
  );

  journey("J4 tab identity remains visible asleep and reads never wake tabs", async (evidence) => {
    let launches = 0;
    const browser = await startBrowser({
      onLaunch: () => {
        launches++;
      },
    });
    addCleanup("tab identity Browser Runtime", () => browser.close());
    const stack = await deployment(browser, undefined, { scenario: "browser-profiles" });
    await browserAvailable(stack);
    const profileId = await grantedProfile(stack, stack.mainWorkspaceId);
    const origin = await fixtureAccount();
    const profiled = await profileTurn(stack, evidence, {
      open: { profileId },
      visit: `${origin}/account`,
    });
    const guest = await profileTurn(
      stack,
      evidence,
      { open: { fresh: true }, visit: `${origin}/account` },
      profiled.threadId,
    );
    const live = await profileTurn(stack, evidence, { tabs: true }, profiled.threadId);
    const expected = [
      { sessionId: profiled.report.opened!.session.id, profileId },
      { sessionId: guest.report.opened!.session.id, profileId: null },
    ];
    // Observe both states before asserting identity so the base failure also
    // leaves verifiable evidence for asleep rows and the no-wake guarantee.
    await browser.close();
    await waitFor(async () => (await browser.health()).sessionCount === 0, 20_000);
    const beforeRead = launches;
    const asleep = await profileTurn(stack, evidence, { tabs: true }, profiled.threadId);
    equal(evidence, "read did not launch Chromium", launches, beforeRead);
    equal(
      evidence,
      "read left all bindings asleep",
      asleep.report.tabs!.map((tab) => tab.state),
      live.report.tabs!.map(() => "asleep"),
    );
    for (const identity of expected) {
      const tab = live.report.tabs!.find((tab) => tab.sessionId === identity.sessionId);
      expect(tab, `live tab for ${identity.sessionId}`).toBeDefined();
      equal(evidence, `open ${identity.sessionId} identity`, tab!.profileId, identity.profileId);
      const sleeping = asleep.report.tabs!.find((row) => row.tabId === tab!.tabId);
      equal(evidence, `asleep ${tab!.tabId} identity`, sleeping?.profileId, identity.profileId);
    }
  });

  journey("J5-agent two live clients see creation without session opening", async (evidence) => {
    const { stack } = await profileDeployment();
    const people = await connectedPeople(stack);
    const created = await profileTurn(stack, evidence, { create: { name: "work" } });
    const id = created.report.created!.profile.id;
    try {
      await waitFor(
        async () =>
          people.every((client) =>
            client.getSnapshot().browserProfiles.some((profile) => profile.id === id),
          ),
        10_000,
      );
    } finally {
      evidence.observations.push({
        people: people.map((client) => client.getSnapshot().browserProfiles),
      });
    }
    for (const client of people)
      equal(
        evidence,
        "agent profile arrived without reload",
        client.getSnapshot().browserProfiles.some((profile) => profile.id === id),
        true,
      );
    const bootstrap = await stack.api["bootstrap.get"]({});
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    equal(
      evidence,
      "no session opened to trigger invalidation",
      bootstrap.data.browser.sessions.length,
      0,
    );
  });

  journey(
    "J5-request two live clients see Request creation without session opening",
    async (evidence) => {
      const { stack } = await profileDeployment();
      const people = await connectedPeople(stack);
      const result = await fulfillNewProfile(stack, evidence, people);
      for (const client of people)
        equal(
          evidence,
          "Request profile arrived without reload",
          client.getSnapshot().browserProfiles.some((profile) => profile.id === result.profile.id),
          true,
        );
      const bootstrap = await stack.api["bootstrap.get"]({});
      if (!bootstrap.ok) throw new Error(bootstrap.error.message);
      equal(evidence, "Request opened no session", bootstrap.data.browser.sessions.length, 0);
    },
  );

  journey(
    "J5-grant two live clients see a direct grant and its revocation without reload",
    async (evidence) => {
      const { stack } = await profileDeployment();
      const people = await connectedPeople(stack);
      const workspace = await stack.createWorkspace("Granted specialist");
      const created = await stack.api["commands.dispatch"]({
        idempotencyKey: randomUUID(),
        input: { name: "Shared work" },
        type: "browser.profile.create",
      });
      if (!created.ok || created.data.type !== "browser.profile.create")
        throw new Error(JSON.stringify(created));
      const profileId = created.data.profile.id;
      const grantsFor = (client: HttpHostClient) =>
        client
          .getSnapshot()
          .browserProfileGrants.filter(
            (grant) => grant.profileId === profileId && grant.workspaceId === workspace.id,
          );
      const granted = await stack.api["commands.dispatch"]({
        idempotencyKey: randomUUID(),
        profileId,
        type: "browser.profile.grant",
        workspaceId: workspace.id,
      });
      if (!granted.ok || granted.data.type !== "browser.profile.grant")
        throw new Error(JSON.stringify(granted));
      try {
        await waitFor(async () => people.every((client) => grantsFor(client).length === 1), 10_000);
      } finally {
        evidence.observations.push({ afterGrant: people.map(grantsFor) });
      }
      for (const client of people)
        equal(evidence, "direct grant arrived without reload", grantsFor(client).length, 1);
      const revoked = await stack.api["commands.dispatch"]({
        grantId: granted.data.grant.id,
        idempotencyKey: randomUUID(),
        type: "browser.profileGrant.revoke",
      });
      if (!revoked.ok) throw new Error(JSON.stringify(revoked));
      try {
        await waitFor(async () => people.every((client) => grantsFor(client).length === 0), 10_000);
      } finally {
        evidence.observations.push({ afterRevoke: people.map(grantsFor) });
      }
      for (const client of people)
        equal(evidence, "revocation arrived without reload", grantsFor(client).length, 0);
      const bootstrap = await stack.api["bootstrap.get"]({});
      if (!bootstrap.ok) throw new Error(bootstrap.error.message);
      equal(evidence, "grants opened no session", bootstrap.data.browser.sessions.length, 0);
    },
  );

  journey("J6 site lookup reports saved fixture data and an empty profile", async (evidence) => {
    const { stack } = await profileDeployment();
    const origin = await fixtureAccount();
    // Person setup keeps this journey independent of the missing create tool.
    const workId = await grantedProfile(stack, stack.mainWorkspaceId, "work");
    const emptyId = await grantedProfile(stack, stack.mainWorkspaceId);
    evidence.observations.push({ origin, workId, emptyId });
    const first = await profileTurn(stack, evidence, {
      open: { profileId: workId },
      visit: `${origin}/login`,
      close: true,
    });
    equal(evidence, "fixture signed in", first.report.page!.signedIn, true);
    await waitFor(async () => (await profileRevision(stack, workId)) > 0, 20_000);
    const lookup = await profileTurn(stack, evidence, { site: origin }, first.threadId);
    const profiles = lookup.report.profiles!.profiles;
    equal(
      evidence,
      "saved fixture data is reported",
      profiles.find((profile) => profile.id === workId)?.siteData?.hasData,
      true,
    );
    const savedAt = profiles.find((profile) => profile.id === workId)?.siteData?.savedAt;
    equal(
      evidence,
      "saved fixture data has a savedAt timestamp",
      typeof savedAt === "string" && Number.isFinite(Date.parse(savedAt)),
      true,
    );
    equal(
      evidence,
      "empty profile holds no fixture data",
      profiles.find((profile) => profile.id === emptyId)?.siteData,
      { hasData: false, savedAt: null },
    );
  });
});

it("serves only an authorized frozen native seed and exposes offline erasure through bootstrap", async () => {
  const stack = await deployment(undefined);
  const bootstrap = await stack.api["bootstrap.get"]({});
  if (!bootstrap.ok) throw new Error(bootstrap.error.message);
  const ownerId = bootstrap.data.user.id;
  const created = await stack.api["commands.dispatch"]({
    type: "browser.profile.create",
    input: { name: "Native recovery" },
    idempotencyKey: randomUUID(),
  });
  if (!created.ok || created.data.type !== "browser.profile.create")
    throw new Error("Native test profile was not created");
  const profileId = created.data.profile.id;
  const runnerId = createId("runner"),
    enrollmentHash = "native-profile-test-" + randomUUID();
  await stack.host.store.createRunnerEnrollment({
    allowedModules: ["browser"],
    createdBy: ownerId,
    expiresAt: new Date(Date.now() + 60_000),
    id: "ren_" + randomUUID(),
    idempotencyKey: randomUUID(),
    name: "Offline owner",
    requestFingerprint: randomUUID(),
    runnerKind: "managed",
    tokenHash: enrollmentHash,
  });
  await stack.host.store.enrollRunnerConnection({
    descriptor: {
      bootId: ("rbt_" + randomUUID()) as RunnerDescriptor["bootId"],
      capabilities: [],
      modules: { browser: { runtimeId: "native-offline", profileSnapshotVersion: 2 } },
      name: "Offline owner",
      runnerId,
      runnerKind: "managed",
      runtimeVersion: "test",
    },
    enrollmentTokenHash: enrollmentHash,
    publicKeyFingerprint: "sha256:" + randomUUID(),
    publicKeyPem: "test-native-profile-public-key",
  });
  const binding = {
    version: 1 as const,
    deploymentId: stack.host.deployment.id,
    profileId,
    runnerId,
    storageInstanceId: randomUUID(),
    bindingId: randomUUID(),
    engine: "chromium" as const,
  };
  const seed = {
    revision: 0,
    digest: createHash("sha256")
      .update(encodeBrowserProfileSnapshot({ cookies: [], origins: [] }))
      .digest("hex"),
  };
  const token = randomBytes(32).toString("base64url");
  await stack.host.store.reserveBrowserProfileInitialization({
    binding,
    seed,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const seedUrl = `/v1/browser-profile-initialization/${profileId}`;
  const authorized = await stack.host.app.inject({
    method: "GET",
    url: seedUrl,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(authorized.statusCode).toBe(200);
  expect(authorized.headers["cache-control"]).toBe("private, no-store");
  expect(authorized.json()).toEqual({ binding, seed, snapshot: { cookies: [], origins: [] } });
  const denied = await stack.host.app.inject({
    method: "GET",
    url: seedUrl,
    headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` },
  });
  expect(denied.statusCode).toBe(403);
  const invalidCompletion = await stack.host.app.inject({
    method: "POST",
    url: seedUrl,
    headers: { authorization: `Bearer ${token}` },
    payload: { binding: { ...binding, bindingId: randomUUID() }, seed },
  });
  expect(invalidCompletion.statusCode).toBe(403);
  expect(
    (
      await stack.host.browser.profileSiteData({
        ownerId,
        profileIds: [profileId],
        site: "https://example.com",
      })
    ).profiles.has(profileId),
  ).toBe(false);
  const deleted = await stack.api["commands.dispatch"]({
    type: "browser.profile.delete",
    profileId,
    idempotencyKey: randomUUID(),
  });
  expect(deleted).toMatchObject({
    ok: true,
    data: { deletion: { profileId, computerId: runnerId, state: "pending-computer" } },
  });
  const after = await stack.api["bootstrap.get"]({});
  expect(after).toMatchObject({
    ok: true,
    data: {
      browser: {
        profileDeletions: [{ profileId, computerId: runnerId, state: "pending-computer" }],
      },
    },
  });
  expect(
    (
      await stack.host.app.inject({
        method: "GET",
        url: seedUrl,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
  ).toBe(403);
}, 30_000);
