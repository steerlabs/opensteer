import { createId } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import {
  personalFixtureOwner,
  createPersonalRunFixturePort,
} from "./personal-run-fixture.test-support.js";
import { sql } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import { it as baseIt, describe, expect } from "vitest";
import { BrowserSourceStore } from "./browser-source-store.js";
import { createDatabase } from "./connection.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
  recordTestDatabaseSetup,
} from "./test-database.test-support.js";

import { OpensteerStore } from "./store.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration.sequential("browser sign-in authority", () => {
  async function createTestFixture() {
    const clone = await cloneTestDatabase("host");
    const databaseUrl = clone.url;
    const { database } = await ownTestDatabaseProducer(databaseUrl, async () => {
      const database = createDatabase({
        applicationName: "opensteer-browser-source-test",
        connectionString: databaseUrl,
        maxConnections: 3,
      });
      return { database, close: () => database.destroy() };
    });
    const sources = new BrowserSourceStore(database);
    const store = new OpensteerStore(database);
    const hostInstanceId = createId("hostInstance");
    async function fixture() {
      const personal = await personalFixtureOwner(database, databaseUrl);
      const ownerId = personal.userId;
      const codeHash = createHash("sha256").update(randomUUID()).digest("hex");
      const tokenHash = createHash("sha256").update(randomUUID()).digest("hex");
      await sources.createPairing({
        codeHash,
        ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        canonicalOrigin: "https://source-host.test",
        remoteOrigin: null,
        remoteGeneration: null,
      });
      const source = await sources.consumePairing({
        origin: "https://source-host.test",
        routeGeneration: null,
        codeHash,
        tokenHash,
        name: "Chrome",
        replaces: null,
      });
      return { ownerId, deploymentId: personal.deploymentId, source, codeHash, tokenHash };
    }
    async function runningRun(ownerId: import("@opensteer/core").UserId) {
      const personal = await personalFixtureOwner(database, databaseUrl);
      expect(ownerId).toBe(personal.userId);
      const port = createPersonalRunFixturePort(store);
      const task = await port.createTask({
        ownerId,
        folder: personal.agentHome,
        suffix: randomUUID(),
      });
      const started = await port.startTask(task.threadId, "Start");
      return {
        ...started,
        threadId: task.threadId,
        environmentId: personal.environmentId,
        runnerId: personal.runnerId,
      };
    }
    async function liveSession(
      scope: Awaited<ReturnType<typeof fixture>>,
      run: Awaited<ReturnType<typeof runningRun>>,
    ) {
      const session = await store.createBrowserSession({
        id: createBrowserSessionId(),
        origin: "agent",
        placementKey: `runner:${run.runnerId}:browser`,
        profileId: null,
        runnerId: run.runnerId,
        runtimeId: "browser",
        ownerId: scope.ownerId,
      });
      await store.transitionBrowserSession({ sessionId: session.id, state: "ready" });
      return session.id;
    }
    async function createSignInRequest(
      scope: Awaited<ReturnType<typeof fixture>>,
      run: Awaited<ReturnType<typeof runningRun>>,
      sessionId: string,
      site = "https://example.test",
    ) {
      return store.requests.create({
        callId: randomUUID(),
        kind: "browser.sign-in",
        mode: "durable",
        originatingRunId: run.runId,
        originatingThreadId: run.threadId,
        requestedBy: scope.ownerId,
        requiredActor: "requester",
        payload: { kind: "browser.sign-in", reason: "Open my dashboard", sessionId, site },
        presentation: {
          detail: "Open my dashboard",
          kind: "external",
          subject: { id: site, kind: "browser-site" },
          title: "Sign in to example.test",
        },
      });
    }
    async function continuationFor(requestId: string) {
      return database
        .selectFrom("requestContinuations")
        .select("status")
        .where("requestId", "=", requestId as never)
        .executeTakeFirst();
    }

    return Object.freeze({
      database,
      sources,
      store,
      hostInstanceId,
      fixture,
      runningRun,
      liveSession,
      createSignInRequest,
      continuationFor,
      databaseUrl,
    });
  }
  type StoreFixture = Awaited<ReturnType<typeof createTestFixture>>;
  const it = baseIt.extend<{ storeFixture: StoreFixture }>({
    storeFixture: async ({ task }, use) => {
      const started = performance.now();
      const fixture = await createTestFixture();
      recordTestDatabaseSetup(task, started);
      await use(fixture);
    },
  });

  it("pairs once through any listed destination and re-pairs only with a proven replaces", async ({
    storeFixture,
  }) => {
    const { fixture, sources } = storeFixture;
    const { ownerId, deploymentId, source, tokenHash } = await fixture();
    const pair = async (
      replaces: { readonly sourceId: typeof source.id; readonly tokenHash: string } | null,
      destination = { origin: "https://source-host.test", routeGeneration: null as number | null },
    ) => {
      const codeHash = createHash("sha256").update(randomUUID()).digest("hex");
      const nextToken = createHash("sha256").update(randomUUID()).digest("hex");
      await sources.createPairing({
        codeHash,
        ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        canonicalOrigin: "https://source-host.test",
        remoteOrigin: "https://remote.example",
        remoteGeneration: 7,
      });
      const paired = await sources.consumePairing({
        ...destination,
        codeHash,
        tokenHash: nextToken,
        name: "Chrome again",
        replaces,
      });
      await expect(
        sources.consumePairing({
          ...destination,
          codeHash,
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          name: "Replay",
          replaces: null,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      return { paired, token: nextToken };
    };
    await sources.upsertGrant({
      ownerId,
      deploymentId,
      site: "https://example.test",
      preferredSourceId: source.id,
    });

    const remote = await pair(null, { origin: "https://remote.example", routeGeneration: 7 });
    expect(remote.paired.ownerId).toBe(ownerId);

    const forged = await pair({
      sourceId: source.id,
      tokenHash: createHash("sha256").update("not the token").digest("hex"),
    });
    expect(await sources.authenticate(tokenHash)).toMatchObject({ id: source.id });
    expect(
      await sources.getGrant({ ownerId, deploymentId, site: "https://example.test" }),
    ).toMatchObject({ preferredSourceId: source.id });

    const replacement = await pair({ sourceId: source.id, tokenHash });
    expect(await sources.authenticate(tokenHash)).toBeNull();
    expect(
      await sources.getGrant({ ownerId, deploymentId, site: "https://example.test" }),
    ).toMatchObject({ preferredSourceId: replacement.paired.id });
    expect((await sources.list(ownerId)).map(({ id }) => id).sort()).toEqual(
      [remote.paired.id, forged.paired.id, replacement.paired.id].sort(),
    );
  });

  it("binds a source to the destination it paired on, and an older source to its first one", async ({
    storeFixture,
  }) => {
    const { database, fixture, sources } = storeFixture;
    const { source } = await fixture();
    const canonical = { origin: "https://source-host.test", routeGeneration: null };
    const remote = { origin: "https://remote.example", routeGeneration: 7 };
    expect(await sources.claimDestination({ sourceId: source.id, ...canonical })).toBe(true);
    expect(await sources.claimDestination({ sourceId: source.id, ...remote })).toBe(false);
    expect(
      await sources.claimDestination({ sourceId: source.id, ...remote, origin: canonical.origin }),
    ).toBe(false);

    // Paired before binding existed: whichever first connection lands binds it, never both.
    await database
      .updateTable("browserSources")
      .set({ pairedOrigin: null, pairedRouteGeneration: null })
      .where("id", "=", source.id)
      .execute();
    const raced = await Promise.all([
      sources.claimDestination({ sourceId: source.id, ...canonical }),
      sources.claimDestination({ sourceId: source.id, ...remote }),
    ]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    const winner = raced[0] ? canonical : remote;
    const loser = raced[0] ? remote : canonical;
    expect(await sources.claimDestination({ sourceId: source.id, ...winner })).toBe(true);
    expect(await sources.claimDestination({ sourceId: source.id, ...loser })).toBe(false);
    expect(
      await database
        .selectFrom("browserSources")
        .select(["pairedOrigin", "pairedRouteGeneration"])
        .where("id", "=", source.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ pairedOrigin: winner.origin, pairedRouteGeneration: winner.routeGeneration });
  });

  it("commits a sign-in and its Request together, replays it, and refuses another scope", async ({
    storeFixture,
  }) => {
    const {
      fixture,
      runningRun,
      liveSession,
      createSignInRequest,
      sources,
      store,
      continuationFor,
      database,
    } = storeFixture;
    const scope = await fixture();
    const run = await runningRun(scope.ownerId);
    const sessionId = await liveSession(scope, run);
    const site = "https://example.test";
    const opened = await createSignInRequest(scope, run, sessionId, site);
    expect(opened.request.status).toBe("pending");
    await sources.upsertGrant({
      ownerId: scope.ownerId,
      deploymentId: scope.deploymentId,
      site,
      preferredSourceId: scope.source.id,
    });
    const input = {
      actor: "request" as const,
      invocationId: randomUUID(),
      ownerId: scope.ownerId,
      profileName: null,
      rememberSite: false,
      requestId: opened.request.id,
      sessionId,
      site,
      sourceId: scope.source.id,
      sourceName: scope.source.name,
      deploymentId: scope.deploymentId,
    };
    const committed = await sources.commitSignIn(input);
    expect(committed).toMatchObject({
      replayed: false,
      receipt: { requestId: opened.request.id, sessionId, site },
      events: [expect.objectContaining({ type: "request.resolved" })],
    });
    const fulfilled = await store.requests.get(opened.request.id);
    expect(fulfilled).toMatchObject({
      status: "fulfilled",
      response: {
        kind: "external",
        value: { outcome: "applied", profileName: null, sourceName: scope.source.name },
      },
    });
    expect(await continuationFor(opened.request.id)).toEqual({ status: "waiting" });
    expect(
      (await sources.getGrant({ ownerId: scope.ownerId, deploymentId: scope.deploymentId, site }))
        ?.lastSignedInAt,
    ).toBeInstanceOf(Date);

    expect(await sources.commitSignIn(input)).toMatchObject({ replayed: true, events: [] });
    await expect(
      sources.commitSignIn({ ...input, site: "https://other.test" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await database
        .selectFrom("browserSignIns")
        .select("id")
        .where("ownerId", "=", scope.ownerId)
        .execute(),
    ).toHaveLength(1);

    // A Request that is no longer pending still gets the receipt of a
    // sign-in that already reached the browser, but is not re-fulfilled.
    const late = await sources.commitSignIn({ ...input, invocationId: randomUUID() });
    expect(late).toMatchObject({ replayed: false, events: [], receipt: { requestId: null } });
  });

  it("declines, settles a closed session, and keeps each Request's continuation single", async ({
    storeFixture,
  }) => {
    const { fixture, runningRun, liveSession, createSignInRequest, store, continuationFor } =
      storeFixture;
    const scope = await fixture();
    const run = await runningRun(scope.ownerId);
    const sessionId = await liveSession(scope, run);
    const declined = await createSignInRequest(scope, run, sessionId);
    const first = await store.requests.declineBrowserSignInRequest({
      requestId: declined.request.id,
      resolvedBy: scope.ownerId,
    });
    expect(first).toMatchObject({ replayed: false, request: { status: "declined" } });
    expect(
      await store.requests.declineBrowserSignInRequest({
        requestId: declined.request.id,
        resolvedBy: scope.ownerId,
      }),
    ).toMatchObject({ replayed: true, events: [] });
    expect(await continuationFor(declined.request.id)).toEqual({ status: "waiting" });

    const closed = await createSignInRequest(scope, run, sessionId, "https://closed.test");
    expect(
      await store.requests.findPendingBrowserSignIn({
        ownerId: scope.ownerId,
        originatingRunId: run.runId,
        site: "https://closed.test",
      }),
    ).toMatchObject({ id: closed.request.id });
    expect(
      await store.requests.fulfilBrowserSignInRequest({
        ownerId: scope.ownerId,
        requestId: closed.request.id,
        response: { outcome: "session-closed" },
      }),
    ).toMatchObject({ request: { status: "fulfilled" } });
    expect(
      await store.requests.fulfilBrowserSignInRequest({
        ownerId: scope.ownerId,
        requestId: closed.request.id,
        response: { outcome: "session-closed" },
      }),
    ).toBeNull();
    expect(
      await store.requests.listDeliverableBrowserSignIns({
        after: null,
        limit: 64,
        ownerId: scope.ownerId,
        sourceId: scope.source.id,
      }),
    ).toEqual([]);

    await store.transitionBrowserSession({ sessionId, state: "closed" });
    await expect(createSignInRequest(scope, run, sessionId)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("fences a sign-in whose source or site changed between export and import", async ({
    storeFixture,
  }) => {
    const { fixture, sources } = storeFixture;
    const { ownerId, deploymentId, source } = await fixture();
    const site = "https://example.test";
    const fence = {
      ownerId,
      rememberSite: false,
      requestId: null,
      requireGrant: true,
      sessionId: "unused",
      site,
      sourceGeneration: source.generation,
      sourceId: source.id,
      deploymentId,
    };
    expect(await sources.fence(fence)).toBe("grant-removed");
    expect(await sources.fence({ ...fence, requireGrant: false })).toBeNull();
    await sources.upsertGrant({ ownerId, deploymentId, site, preferredSourceId: source.id });
    expect(await sources.fence(fence)).toBeNull();
    expect(await sources.removeGrant({ ownerId, deploymentId, site })).toBe(true);
    expect(await sources.fence(fence)).toBe("grant-removed");
    await sources.upsertGrant({ ownerId, deploymentId, site, preferredSourceId: source.id });
    expect(await sources.revoke({ ownerId, sourceId: source.id })).toBe(true);
    expect(await sources.fence(fence)).toBe("source-changed");
    // Grants outlive the connection; only the preference points nowhere now.
    expect(await sources.listGrants(ownerId)).toMatchObject([
      { site, preferredSourceId: source.id },
    ]);
  });

  /*
   * Ways the last check before import could let a sign-in through that must
   * not land (each would leave cookies in a browser with no receipt, or sign
   * in for a Request the owner refused):
   * - the Request was declined, fulfilled or withdrawn after export;
   * - the Request names another session or site than the delivery;
   * - the personal Deployment became unavailable after export;
   * - remembering a new site would exceed the owner's 1,024-site limit, which
   *   the commit would otherwise discover only after import.
   */
  it("fences a Request that is no longer deliverable and a site over the owner's limit", async ({
    storeFixture,
  }) => {
    const { fixture, runningRun, liveSession, createSignInRequest, sources, store, database } =
      storeFixture;
    const scope = await fixture();
    const run = await runningRun(scope.ownerId);
    const sessionId = await liveSession(scope, run);
    const site = "https://example.test";
    const opened = await createSignInRequest(scope, run, sessionId, site);
    const fence = {
      ownerId: scope.ownerId,
      rememberSite: false,
      requestId: opened.request.id,
      requireGrant: false,
      sessionId,
      site,
      sourceGeneration: scope.source.generation,
      sourceId: scope.source.id,
      deploymentId: scope.deploymentId,
    };
    expect(await sources.fence(fence)).toBeNull();
    expect(await sources.fence({ ...fence, sessionId: createBrowserSessionId() })).toBe(
      "request-closed",
    );
    expect(await sources.fence({ ...fence, site: "https://other.test" })).toBe("request-closed");
    await store.requests.declineBrowserSignInRequest({
      requestId: opened.request.id,
      resolvedBy: scope.ownerId,
    });
    expect(await sources.fence(fence)).toBe("request-closed");

    const orphaned = await createSignInRequest(scope, run, sessionId, "https://orphan.test");
    await database
      .updateTable("deployments")
      .set({ lifecycle: "sealed" })
      .where("id", "=", scope.deploymentId)
      .execute();
    expect(
      await sources.fence({
        ...fence,
        requestId: orphaned.request.id,
        site: "https://orphan.test",
      }),
    ).toBe("deployment-unavailable");
    await database
      .updateTable("deployments")
      .set({ lifecycle: "active" })
      .where("id", "=", scope.deploymentId)
      .execute();

    await sql`
      insert into public.browser_site_grants (id, owner_id, deployment_id, site, preferred_source_id)
      select gen_random_uuid(), ${scope.ownerId}, ${scope.deploymentId}, 'https://s' || n || '.test', ${scope.source.id}
      from generate_series(1, 1024) as n
    `.execute(database);
    const remember = { ...fence, rememberSite: true, requestId: null };
    await expect(sources.fence({ ...remember, site: "https://new.test" })).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    expect(await sources.fence({ ...remember, site: "https://s7.test" })).toBeNull();
  });

  /*
   * Ways a connecting Chrome could miss a Request it can answer: Requests it
   * cannot answer (no grant, a grant preferring another live Chrome, a
   * removed grant) fill the page ahead of it, or paging skips or repeats one.
   */
  it("lists only sign-ins a connecting Chrome can answer, oldest first, in exact pages", async ({
    storeFixture,
  }) => {
    const { fixture, runningRun, liveSession, database, sources, createSignInRequest, store } =
      storeFixture;
    const scope = await fixture();
    const run = await runningRun(scope.ownerId);
    const sessionId = await liveSession(scope, run);
    const other = await database
      .insertInto("browserSources")
      .values({
        id: createId("browserSource"),
        ownerId: scope.ownerId,
        name: "Other Chrome",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        revokedAt: null,
        lastSeenAt: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const retired = await database
      .insertInto("browserSources")
      .values({
        id: createId("browserSource"),
        ownerId: scope.ownerId,
        name: "Retired Chrome",
        tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
        revokedAt: new Date(),
        lastSeenAt: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const grant = (site: string, preferredSourceId: typeof other.id) =>
      sources.upsertGrant({
        ownerId: scope.ownerId,
        preferredSourceId,
        site,
        deploymentId: scope.deploymentId,
      });
    for (let index = 0; index < 5; index += 1) {
      await createSignInRequest(scope, run, sessionId, `https://ungranted${index}.test`);
    }
    await createSignInRequest(scope, run, sessionId, "https://elsewhere.test");
    await grant("https://elsewhere.test", other.id);
    await createSignInRequest(scope, run, sessionId, "https://removed.test");
    await grant("https://removed.test", scope.source.id);
    await sources.removeGrant({
      ownerId: scope.ownerId,
      site: "https://removed.test",
      deploymentId: scope.deploymentId,
    });
    const mine = await createSignInRequest(scope, run, sessionId, "https://mine.test");
    await grant("https://mine.test", scope.source.id);
    const orphan = await createSignInRequest(scope, run, sessionId, "https://orphan.test");
    await grant("https://orphan.test", retired.id);

    const list = (after: (typeof mine)["request"]["id"] | null) =>
      store.requests.listDeliverableBrowserSignIns({
        after,
        limit: 1,
        ownerId: scope.ownerId,
        sourceId: scope.source.id,
      });
    const first = await list(null);
    expect(first.map(({ id }) => id)).toEqual([mine.request.id]);
    const second = await list(first[0]!.id);
    expect(second.map(({ id }) => id)).toEqual([orphan.request.id]);
    expect(await list(second[0]!.id)).toEqual([]);
    expect(
      (
        await store.requests.listDeliverableBrowserSignIns({
          after: null,
          limit: 64,
          ownerId: scope.ownerId,
          sourceId: other.id,
        })
      ).map(({ id }) => id),
    ).toEqual([
      (await store.requests.findPendingBrowserSignIn({
        originatingRunId: run.runId,
        ownerId: scope.ownerId,
        site: "https://elsewhere.test",
      }))!.id,
      orphan.request.id,
    ]);
  });

  it("admits sign_in on the Run tool ledger", async ({ storeFixture }) => {
    const { fixture, runningRun, store } = storeFixture;
    const scope = await fixture();
    const run = await runningRun(scope.ownerId);
    const admit = (requestId: string) =>
      store.admitRunToolCall({
        action: "browser.sign-in",
        bindingGeneration: run.bindingGeneration,
        environmentId: run.environmentId,
        requestFingerprint: createHash("sha256").update(requestId).digest("hex"),
        requestId,
        requestedBy: scope.ownerId,
        runId: run.runId,
        runnerBootId: run.runnerBootId,
        runnerId: run.runnerId,
        sourceThreadId: run.threadId,
      });
    const requestId = randomUUID();
    expect(await admit(requestId)).toEqual({ actionClass: "browser.sign-in", wasDuplicate: false });
    expect(await admit(requestId)).toEqual({ actionClass: "browser.sign-in", wasDuplicate: true });
  });
});
