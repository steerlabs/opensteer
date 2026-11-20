/**
 * The proof the product stands on: two independent, unmodified agents on one person's computer.
 *
 * - A real Home and a real Runner with a real Chromium behind it.
 * - Agent A connects with the official MCP SDK client, doing the Home's real OAuth flow (dynamic
 *   registration, PKCE, the person's consent through the Home's own endpoints). It is granted
 *   profile A in `approval-required` and works through `browser_use`.
 * - Agent B connects the same way, is granted profile B in `full-access`, and works through
 *   `browser_connect` with stock Playwright `chromium.connectOverCDP()`.
 * - A local site shows an account page only to a browser holding that person's sign-in cookie,
 *   which the person put in each profile by signing in there themselves.
 *
 * Each `it` is one claim and runs in order against the same Home.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
  type Transport,
} from "../apps/host/src/mcp/mcp-sdk-client.test-support.js";
import {
  startPersonalRuntime,
  type PersonalRuntime,
} from "../apps/host/src/runtime/personal-startup.test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import {
  createId,
  ThreadIdSchema,
  type AgentGrant,
  type BrowserProfileId,
  type ThreadAccessMode,
} from "../packages/core/src/index.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import {
  AgentConnectionIdSchema,
  agentConnectionMcpPath,
} from "../packages/protocol/src/agent-connections.js";

// The integration launcher supplies isolated PostgreSQL; skip only when it is absent.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

/* ------------------------------------------------------------------------- *
 * A site that knows who is signed in only by an HttpOnly cookie.
 * ------------------------------------------------------------------------- */

interface Person {
  readonly name: string;
  readonly secret: string;
  readonly order: string;
}
interface Hit {
  readonly path: string;
  readonly person: string | null;
}

function startSite(people: readonly Person[]) {
  const hits: Hit[] = [];
  const waiters = new Set<{ match: (hit: Hit) => boolean; resolve: (hit: Hit) => void }>();
  const held = new Set<ServerResponse>();
  const signedIn = (request: IncomingMessage) => {
    const cookie = /(?:^|;\s*)fixture_session=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
    return people.find(({ secret }) => secret === cookie) ?? null;
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://site.test");
    const person = signedIn(request);
    const hit = { path: url.pathname + url.search, person: person?.name ?? null };
    hits.push(hit);
    for (const waiter of waiters)
      if (waiter.match(hit)) {
        waiters.delete(waiter);
        waiter.resolve(hit);
      }
    const login = /^\/login\/(\w+)$/u.exec(url.pathname);
    if (login) {
      const who = people.find(({ name }) => name.toLowerCase() === login[1]);
      if (!who) return void response.writeHead(404).end();
      return void response
        .writeHead(302, {
          "set-cookie": `fixture_session=${who.secret}; HttpOnly; Path=/; SameSite=Lax`,
          location: "/account",
        })
        .end();
    }
    if (url.pathname === "/slow") {
      held.add(response);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      person
        ? `<title>Account</title><h1>Signed in as ${person.name}</h1><p id="order">${person.order}</p>`
        : `<title>Account</title><h1>Signed out</h1>`,
    );
  });
  return {
    hits,
    /** Resolves with the first request, past or future, that matches. */
    next(match: (hit: Hit) => boolean): Promise<Hit> {
      const seen = hits.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.add({ match, resolve }));
    },
    async listen(): Promise<URL> {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    },
    async close(): Promise<void> {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------------- *
 * One connected agent: the official MCP client and the Home's own OAuth.
 * ------------------------------------------------------------------------- */

const redirectUri = "http://127.0.0.1:49317/callback";

/** The agent's side of OAuth, kept in memory the way a CLI agent keeps it. */
class AgentOAuth implements OAuthClientProvider {
  #client: OAuthClientInformationMixed | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier = "";
  code: string | undefined;
  readonly name: string;
  /** The person in their browser, following the authorization address to the Home's consent. */
  readonly consent: (authorizationUrl: URL) => Promise<string>;
  constructor(name: string, consent: (authorizationUrl: URL) => Promise<string>) {
    this.name = name;
    this.consent = consent;
  }
  get redirectUrl() {
    return redirectUri;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.#client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.#client = client;
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens;
  }
  async redirectToAuthorization(authorizationUrl: URL) {
    this.code = await this.consent(authorizationUrl);
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
}

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface Agent {
  readonly label: string;
  readonly client: Client;
  readonly oauth: AgentOAuth;
  readonly connectionId: string;
  readonly bearer: string;
  readonly refresh: string | undefined;
  /** Everything the Home sent this agent, as it arrived. */
  readonly received: string[];
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

/* ------------------------------------------------------------------------- *
 * Helpers.
 * ------------------------------------------------------------------------- */

function ok<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}
function text(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}
function failure(result: ToolResult) {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  return (result.structuredContent?.error ?? {}) as {
    readonly code?: string;
    readonly message?: string;
  };
}
function structured(result: ToolResult) {
  return (result.structuredContent ?? {}) as Record<string, unknown> & {
    readonly status?: string;
    readonly taskId?: string;
  };
}
function within(ms: number) {
  return AbortSignal.timeout(ms);
}

/** What a Request asks: a script, or direct control through a raw connection. */
const direct = (_title: string, detail: string) =>
  detail.includes("Full control of the browser profile");
const script = (title: string, detail: string) => !direct(title, detail);
/** The words the person reads before the exact script or calls the Request also shows. */
function personWords(presentation: {
  readonly title: string;
  readonly detail?: string | undefined;
}) {
  return `${presentation.title}\n${(presentation.detail ?? "").split("\n\nWhat it will run:")[0]}`;
}

/* ------------------------------------------------------------------------- *
 * The scenario.
 * ------------------------------------------------------------------------- */

integration("a second agent on the person's computer", () => {
  const alice: Person = {
    name: "Alice",
    secret: randomBytes(24).toString("base64url"),
    order: "Order 1042-A",
  };
  const bob: Person = {
    name: "Bob",
    secret: randomBytes(24).toString("base64url"),
    order: "Order 7731-B",
  };
  const site = startSite([alice, bob]);
  let siteOrigin: URL;
  let home: PersonalRuntime & { close(): Promise<void> };
  let ownerSessionCookie: string;
  let deviceName: string;
  let profileA: { readonly id: BrowserProfileId; readonly name: string };
  let profileB: { readonly id: BrowserProfileId; readonly name: string };
  let a: Agent;
  let b: Agent;
  const answered = new Set<string>();
  /** What each agent's work produced, in the Home's records. */
  const work = {
    a: { tasks: new Set<string>(), tabs: new Set<string>() },
    b: { tasks: new Set<string>(), tabs: new Set<string>() },
  };
  let browserB: Browser | undefined;
  let pageB: Page | undefined;
  let browserBDisconnected = false;
  /** What B read through its own browser connection, kept with what it received. */
  const readByB: string[] = [];
  const clients: Browser[] = [];

  async function startHome(databaseUrl: string) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-second-agent-"));
    const runnerId = createId("runner");
    const runtimeId = "second-agent-browser";
    const bridgeToken = randomBytes(32).toString("base64url");
    let keys: readonly { keyId: string; publicKeyPem: string }[] = [];
    const runtime = new BrowserRuntime({
      launcher: new PlaywrightChromiumLauncher({
        headless: true,
        chromiumSandbox: false,
        executablePath: chromium.executablePath(),
      }),
      localProfiles: { root: join(scratch, "profiles") },
      runtimeId,
      sessionFilesRoot: join(scratch, "files"),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        replayLedgerPath: join(scratch, "private", "replay.json"),
        resolvePublicKey: (id) => keys.find((key) => key.keyId === id)?.publicKeyPem ?? null,
      }),
    });
    const browserServer = new BrowserRuntimeServer({
      port: 0,
      relayBridge: {
        token: bridgeToken,
        updateAttachKeys: (next) => {
          keys = next;
        },
      },
      runtime,
    });
    let stack: PersonalRuntime | undefined;
    let stopStack: (() => Promise<void>) | undefined;
    const close = async () => {
      try {
        for (const client of clients) await client.close().catch(() => undefined);
        await stopStack?.();
        await browserServer.close();
      } finally {
        await site.close();
        await rm(scratch, { recursive: true, force: true });
      }
    };
    try {
      const address = await browserServer.start();
      stack = await startPersonalRuntime({
        databaseUrl,
        agentHome: { computerId: runnerId, path: join(scratch, "workspace") },
        browser: {
          bridgeToken,
          runtimeId,
          url: new URL(`http://${address.host}:${address.port}`),
        },
      });
      stopStack = stack.close.bind(stack);
      return Object.assign(stack, { close, runnerId });
    } catch (error) {
      await close();
      throw error;
    }
  }

  /** The person opens a tab in their profile, signs in to the site, and closes the tab. */
  async function signIn(profileId: BrowserProfileId, person: Person) {
    const signedIn = site.next((hit) => hit.path === "/account" && hit.person === person.name);
    const opened = ok(
      await home.api["commands.dispatch"]({
        type: "tab.open",
        idempotencyKey: randomUUID(),
        target: {
          kind: "page",
          profileId,
          url: new URL(`/login/${person.name.toLowerCase()}`, siteOrigin).href,
        },
      }),
    );
    await signedIn;
    if (opened.type !== "tab.open") throw new Error("Unexpected tab command result");
    ok(
      await home.api["commands.dispatch"]({
        type: "tab.close",
        idempotencyKey: randomUUID(),
        tabIds: [opened.tab.tabId],
      }),
    );
  }

  /** The person approves the agent's connection on the Home's consent screen. */
  function consentAs(label: string, accessMode: ThreadAccessMode, grant: AgentGrant) {
    let used = false;
    return async (authorizationUrl: URL): Promise<string> => {
      if (used) throw new Error(`${label} asked the person to sign it in again`);
      used = true;
      const authorize = await fetch(authorizationUrl, {
        redirect: "manual",
        headers: { cookie: ownerSessionCookie },
      });
      expect(authorize.status).toBe(303);
      const consentPage = new URL(authorize.headers.get("location")!, home.hostOrigin);
      expect(consentPage.pathname).toBe("/mcp-authorization");
      const requestId = consentPage.searchParams.get("request")!;
      const consent = ok(await home.api["connections.authorization.get"]({ requestId }));
      expect(consent.grantsAvailable).toBe(true);
      const approval = ok(
        await home.api["commands.dispatch"]({
          type: "connection.authorize",
          requestId,
          idempotencyKey: randomUUID(),
          decision: { kind: "approve", label, accessMode, grant },
        }),
      );
      if (approval.type !== "connection.authorize")
        throw new Error(`Consent was not completed: ${JSON.stringify(approval)}`);
      const complete = await fetch(new URL(approval.completionPath, home.hostOrigin), {
        redirect: "manual",
      });
      expect(complete.status).toBe(303);
      const back = new URL(complete.headers.get("location")!);
      expect(back.origin + back.pathname).toBe(redirectUri);
      return back.searchParams.get("code")!;
    };
  }

  async function connectAgent(
    label: string,
    clientName: string,
    accessMode: ThreadAccessMode,
    profileId: BrowserProfileId,
  ): Promise<Agent> {
    const grant: AgentGrant = {
      scope: "selected",
      tasks: true,
      resources: [{ kind: "browser-profile", profileId }],
    };
    const oauth = new AgentOAuth(clientName, consentAs(label, accessMode, grant));
    const endpoint = new URL(agentConnectionMcpPath, home.hostOrigin);
    // The first contact is refused for want of a token, which starts the OAuth flow.
    const unauthorized = new Client({ name: clientName, version: "1.0.0" });
    const transport = () =>
      new StreamableHTTPClientTransport(endpoint, { authProvider: oauth }) as unknown as Transport;
    await expect(unauthorized.connect(transport())).rejects.toBeInstanceOf(UnauthorizedError);
    await new StreamableHTTPClientTransport(endpoint, { authProvider: oauth }).finishAuth(
      oauth.code!,
    );
    const client = new Client({ name: clientName, version: "1.0.0" });
    await client.connect(transport());
    const tokens = oauth.tokens()!;
    const listed = ok(await home.api["connections.list"]({}));
    const connection = listed.connections.find((entry) => entry.label === label);
    if (!connection) throw new Error(`${label} is not among the person's connections`);
    expect(connection).toMatchObject({ accessMode, grant, clientName });
    const received: string[] = [];
    return {
      label,
      client,
      oauth,
      connectionId: connection.id,
      bearer: tokens.access_token,
      refresh: tokens.refresh_token,
      received,
      async call(name, args = {}) {
        const result = (await client.callTool({ name, arguments: args }, undefined, {
          timeout: 120_000,
        })) as ToolResult;
        received.push(JSON.stringify(result));
        return result;
      },
    };
  }

  /** The next unanswered operation Request in Needs you that matches. */
  async function waitForRequest(matches: (title: string, detail: string) => boolean) {
    const find = async () =>
      ok(await home.api["requests.list"]({})).requests.find(
        ({ request }) =>
          !answered.has(request.id) &&
          request.presentation.kind === "form" &&
          matches(request.presentation.title, request.presentation.detail ?? ""),
      );
    try {
      return await home.observe(find, within(60_000), "No Request reached Needs you");
    } catch (error) {
      // Say what the agent was told meanwhile, so a refusal is not mistaken for a slow Request.
      throw new Error(
        `No matching Request reached Needs you. A last received: ${a.received.at(-1) ?? "nothing"}`,
        { cause: error },
      );
    }
  }

  /** The person answers the next operation Request that matches, by the choice they read. */
  async function decide(
    matches: (title: string, detail: string) => boolean,
    choice: "allow" | "refuse",
  ) {
    const waiting = await waitForRequest(matches);
    const { request } = waiting;
    answered.add(request.id);
    if (request.presentation.kind !== "form") throw new Error("Not a form Request");
    // The revision the person reviewed, read the way the apps read one Request before answering.
    const reviewed = ok(
      await home.api["thread.requests.list"]({
        threadId: ThreadIdSchema.parse(request.originatingThreadId),
        requestId: request.id,
      }),
    );
    const expectedRevision = reviewed.reviewedRevisions?.[request.id];
    if (!expectedRevision) throw new Error("The Request has no revision to answer");
    const field = request.presentation.fields[0]!;
    const value = field.choices?.find(({ label }) =>
      choice === "allow" ? /^Allow( once)?$/u.test(label) : label === "Don't allow",
    )?.value;
    if (!value) throw new Error(`The Request offers no "${choice}"`);
    ok(
      await home.api["commands.dispatch"]({
        type: "request.respond",
        requestId: request.id,
        expectedRevision,
        idempotencyKey: randomUUID(),
        response: { kind: "form", answers: { [field.id]: [value] } },
      }),
    );
    return waiting;
  }

  /** Runs one of A's scripts, which waits for the person; the person allows it. */
  async function allowedScript(code: string, args: Record<string, unknown> = {}) {
    const call = a.call("browser_use", { code, ...args });
    await decide(script, "allow");
    return call;
  }

  async function shell() {
    return ok(await home.api["personal.shell.get"]({}));
  }

  beforeAll(async () => {
    siteOrigin = await site.listen();
    const database = await cloneTestDatabase("host");
    home = await ownTestDatabaseProducer(database.url, () => startHome(database.url));
    ownerSessionCookie = home.sessionCookie;
    const created = async (name: string) => {
      const result = ok(
        await home.api["commands.dispatch"]({
          type: "browser.profile.create",
          idempotencyKey: randomUUID(),
          input: { name, homeRunnerId: home.agentHome.computerId },
        }),
      );
      if (result.type !== "browser.profile.create") throw new Error("Unexpected profile result");
      return { id: result.profile.id as BrowserProfileId, name: result.profile.name };
    };
    profileA = await created("Alice research");
    profileB = await created("Bob shopping");
    const owner = (await shell()).viewerId;
    const homeOfProfile = (await home.host.browser.listProfiles(owner)).find(
      ({ id }) => id === profileA.id,
    )?.home;
    if (!homeOfProfile) throw new Error("Profile A has no home computer");
    deviceName = homeOfProfile.name;
    await signIn(profileA.id, alice);
    await signIn(profileB.id, bob);
    a = await connectAgent("Agent A", "Research Agent", "approval-required", profileA.id);
    b = await connectAgent("Agent B", "Shopping Agent", "full-access", profileB.id);
  }, 240_000);

  afterAll(async () => {
    await home?.close();
  });

  it("lets each agent finish real work in its own profile, signed in only there", async () => {
    // B: a reviewed attachment in full-access, then stock Playwright over the Home's endpoint.
    const attach = await b.call("browser_connect", { reason: "Check my latest order" });
    const attached = structured(attach);
    const strip = ok(await home.api["tabs.state"]({})).tabs.map(
      ({ tabId, openedBy, profile, state }) => ({ tabId, openedBy, profile: profile?.name, state }),
    );
    expect(attached, `${JSON.stringify(attach)} tabs: ${JSON.stringify(strip)}`).toMatchObject({
      status: "completed",
      mode: expect.stringMatching(/^(whole-context|session)$/u),
    });
    const endpoint = String(attached.endpoint);
    const homeSocket = `ws://${home.hostOrigin.host}`;
    expect(endpoint).toMatch(
      new RegExp(
        `^${homeSocket.replace(/[.]/gu, "\\.")}/v1/browser/connect/[A-Za-z0-9_-]{43}$`,
        "u",
      ),
    );
    expect(endpoint).not.toContain(b.bearer);
    work.b.tasks.add(String(attached.taskId));
    work.b.tabs.add(String(attached.tabId));
    browserB = await chromium.connectOverCDP(
      endpoint,
      attached.mode === "session" ? { noDefaults: true } : {},
    );
    clients.push(browserB);
    browserB.on("disconnected", () => {
      browserBDisconnected = true;
    });
    const context = browserB.contexts()[0]!;
    pageB = context.pages()[0] ?? (await context.newPage());
    await pageB.goto(new URL("/account?agent=b", siteOrigin).href);
    const headingB = await pageB.locator("h1").innerText();
    const orderB = await pageB.locator("#order").innerText();
    readByB.push(headingB, orderB);
    expect({ headingB, orderB }).toEqual({ headingB: "Signed in as Bob", orderB: bob.order });

    // A: one script with the Page API, which the person allows first.
    const result = await allowedScript(`
      const page = await newPage(${JSON.stringify(new URL("/account?agent=a", siteOrigin).href)});
      print({
        heading: await page.locator("h1").innerText(),
        order: await page.locator("#order").innerText(),
        tabId: page.tabId,
      });
    `);
    expect(structured(result), JSON.stringify(result)).toMatchObject({ status: "completed" });
    const printed = JSON.parse(text(result).split("\n")[0]!) as Record<string, string>;
    expect(printed).toMatchObject({ heading: "Signed in as Alice", order: alice.order });
    work.a.tasks.add(String(structured(result).taskId));
    work.a.tabs.add(printed.tabId!);
    // Each profile held only its own sign-in: the site saw each agent as its own person only.
    const seenAs = (agent: string) =>
      new Set(
        site.hits.filter(({ path }) => path.endsWith(`agent=${agent}`)).map((hit) => hit.person),
      );
    expect(seenAs("a")).toEqual(new Set([alice.name]));
    expect(seenAs("b")).toEqual(new Set([bob.name]));
  }, 180_000);

  it("shows each agent's work as its own task and tab, attributed to it", async () => {
    const [taskA] = work.a.tasks;
    const [taskB] = work.b.tasks;
    expect(taskA).not.toBe(taskB);
    const rows = (await shell()).tasks;
    expect(rows.find(({ id }) => id === taskA)).toMatchObject({
      title: "Agent A",
      agentSessionId: expect.any(String),
    });
    expect(rows.find(({ id }) => id === taskB)).toMatchObject({
      title: "Agent B",
      agentSessionId: expect.any(String),
    });
    const tabs = ok(await home.api["tabs.state"]({})).tabs;
    const [tabA] = work.a.tabs;
    const [tabB] = work.b.tabs;
    expect(tabs.find(({ tabId }) => tabId === tabA)).toMatchObject({
      kind: "page",
      openedBy: { taskId: taskA },
      profile: { profileId: profileA.id, name: profileA.name },
    });
    expect(tabs.find(({ tabId }) => tabId === tabB)).toMatchObject({
      kind: "page",
      openedBy: { taskId: taskB },
      profile: { profileId: profileB.id, name: profileB.name },
    });
  });

  it("keeps each agent from listing, reading, opening, attaching to or learning of the other's profile, tabs and task", async () => {
    const pairs = [
      { self: a, other: work.b, otherProfile: profileB, own: profileA },
      { self: b, other: work.a, otherProfile: profileA, own: profileB },
    ] as const;
    for (const { self, other, otherProfile, own } of pairs) {
      const [otherTask] = other.tasks;
      const [otherTab] = other.tabs;
      // Listing: only its own.
      const profiles = structured(await self.call("browser_profile_list"));
      expect(JSON.stringify(profiles)).toContain(own.id);
      expect(JSON.stringify(profiles)).not.toContain(otherProfile.id);
      const tabs = await self.call("tab_list", {});
      expect(text(tabs)).not.toContain(otherTab);
      const tasks = await self.call("opensteer_task_list", {});
      expect(text(tasks)).not.toContain(otherTask);
      // Reading, opening and attaching: refused exactly as for something that does not exist.
      const sameAsAbsent = async (
        name: string,
        real: Record<string, unknown>,
        absent: Record<string, unknown>,
      ) => {
        const seen = failure(await self.call(name, real));
        const none = failure(await self.call(name, absent));
        expect(seen, `${self.label} ${name}: ${JSON.stringify({ seen, none })}`).toEqual(none);
      };
      await sameAsAbsent(
        "opensteer_task_read",
        { taskId: otherTask },
        { taskId: createId("thread") },
      );
      await sameAsAbsent("browser_connect", { tabId: otherTab }, { tabId: createId("tab") });
      await sameAsAbsent(
        "browser_connect",
        { profileId: otherProfile.id },
        { profileId: createId("browserProfile") },
      );
      await sameAsAbsent(
        "browser_use",
        { code: "print(1)", tabId: otherTab },
        { code: "print(1)", tabId: createId("tab") },
      );
      await sameAsAbsent(
        "browser_use",
        { code: "print(1)", profileId: otherProfile.id },
        { code: "print(1)", profileId: createId("browserProfile") },
      );
      const { tools } = await self.client.listTools();
      expect(tools.map(({ name }) => name)).not.toContain("tab_open");
      expect(tools.map(({ name }) => name)).not.toContain("tab_close");
    }
    // Inside A's own script, B's tab is not there to list or bind.
    const [tabB] = work.b.tabs;
    const inside = await allowedScript(`
      const listed = (await pages()).map((page) => page.tabId);
      let bound;
      try { await openPage(${JSON.stringify(tabB)}); bound = "bound"; }
      catch (error) { bound = { code: error.code, message: error.message }; }
      let absent;
      try { await openPage(${JSON.stringify(createId("tab"))}); absent = "bound"; }
      catch (error) { absent = { code: error.code, message: error.message }; }
      print({ listed, bound, absent });
    `);
    const seen = JSON.parse(text(inside).split("\n")[0]!) as {
      listed: string[];
      bound: unknown;
      absent: unknown;
    };
    expect(seen.listed).not.toContain(tabB);
    expect(seen.bound).not.toBe("bound");
    expect(seen.bound).toEqual(seen.absent);
    // Through B's raw connection, only B's own pages exist.
    const context = browserB!.contexts()[0]!;
    expect(browserB!.contexts()).toHaveLength(1);
    const session = await context.newCDPSession(pageB!);
    const { targetInfos } = (await session.send("Target.getTargets")) as {
      targetInfos: { url: string; type: string }[];
    };
    await session.detach();
    const urls = targetInfos.map(({ url }) => url);
    readByB.push(...urls);
    expect(urls.some((url) => url.endsWith("agent=b"))).toBe(true);
    expect(urls.filter((url) => url.endsWith("agent=a"))).toEqual([]);
    expect(context.pages().map((page) => page.url())).not.toContain(
      new URL("/account?agent=a", siteOrigin).href,
    );
  }, 240_000);

  it("in approval-required, holds an effect for the person, finishes the same call on Allow and refuses on Don't allow", async () => {
    const approvedProbe = `/account?probe=${randomUUID()}`;
    const call = a.call("browser_use", {
      code: `await newPage(${JSON.stringify(new URL(approvedProbe, siteOrigin).href)}); print("done");`,
      reason: "Look at the order page",
    });
    const waiting = await waitForRequest(script);
    // Nothing happened while the person had not answered.
    expect(site.hits.some(({ path }) => path === approvedProbe)).toBe(false);
    // The Request names the profile and its device in plain words, never a tool, in A's own task.
    const asked = personWords(waiting.request.presentation);
    expect(asked).toContain(profileA.name);
    expect(asked).toContain(deviceName);
    expect(asked).not.toMatch(/browser_use|browser_connect|_/u);
    expect(waiting.presentation?.threadId ?? waiting.request.originatingThreadId).toBe(
      [...work.a.tasks][0],
    );
    await decide(() => true, "allow");
    const allowed = await call;
    expect(structured(allowed)).toMatchObject({ status: "completed" });
    expect(text(allowed)).toContain("done");
    expect(site.hits.some(({ path }) => path === approvedProbe)).toBe(true);

    const refusedProbe = `/account?probe=${randomUUID()}`;
    const refusedCall = a.call("browser_use", {
      code: `await newPage(${JSON.stringify(new URL(refusedProbe, siteOrigin).href)});`,
    });
    await decide(script, "refuse");
    const refusal = failure(await refusedCall);
    // The code an outside client receives for a refusal, and the reason in words it can act on.
    expect(refusal).toMatchObject({
      code: "declined_by_person",
      message: "The person did not allow it.",
    });
    expect(site.hits.some(({ path }) => path === refusedProbe)).toBe(false);
  }, 180_000);

  it(
    "asks in the fixed words, naming the agent",
    async () => {
      const call = a.call("browser_use", { code: `print("named")` });
      const waiting = await decide(script, "allow");
      await call;
      const form = waiting.request.presentation;
      if (form.kind !== "form") throw new Error("Not a form Request");
      expect(form.title).toBe(`Run a script in ${profileA.name}?`);
      expect(form.fields[0]?.choices?.map(({ label }) => label)).toEqual([
        "Allow once",
        "Don't allow",
      ]);
      const connecting = a.call("browser_connect", {});
      const connect = await decide(direct, "refuse");
      await connecting;
      expect(connect.request.presentation.title).toBe(
        `Let Agent A take direct control of ${profileA.name}?`,
      );
    },
    120_000,
  );

  it("on Stop, ends A's work in flight and tells A the person stopped it, while B carries on", async () => {
    const [taskA] = work.a.tasks;
    const slowStarted = site.next((hit) => hit.path === "/slow" && hit.person === alice.name);
    const inFlight = allowedScript(
      `const page = await newPage(${JSON.stringify(new URL("/account", siteOrigin).href)});
       await page.goto(${JSON.stringify(new URL("/slow", siteOrigin).href)});
       print("finished");`,
      { taskId: taskA },
    );
    await slowStarted;
    const row = (await shell()).tasks.find(({ id }) => id === taskA);
    if (!row?.agentSessionId) throw new Error("A's task names no session to stop");
    expect(
      ok(
        await home.api["commands.dispatch"]({
          type: "agent.session.stop",
          idempotencyKey: randomUUID(),
          threadId: ThreadIdSchema.parse(taskA),
          agentSessionId: row.agentSessionId,
        }),
      ),
    ).toMatchObject({ ended: true });
    const stopped = failure(await inFlight);
    expect(stopped.message).toBe("The person stopped this work.");
    // A call naming the stopped task is refused, and is never run.
    const named = failure(await a.call("tab_list", { taskId: taskA }));
    expect(named.message).toMatch(/^The person stopped this work\./u);
    // The next call that names no task is told once; the one after starts afresh.
    const notice = failure(await a.call("tab_list", {}));
    expect(notice.message).toMatch(/^The person stopped this work\./u);
    const fresh = await a.call("tab_list", {});
    expect(fresh.isError).toBeUndefined();
    expect(structured(fresh).taskId).not.toBe(taskA);
    work.a.tasks.add(String(structured(fresh).taskId));
    // B never noticed.
    await pageB!.reload();
    expect(await pageB!.locator("h1").innerText()).toBe("Signed in as Bob");
    expect(browserBDisconnected).toBe(false);
    expect((await b.call("tab_list", {})).isError).toBeUndefined();
  }, 180_000);

  it("on Disconnect, closes A's socket, refuses its next call and token, reaches Stopped, and B finishes", async () => {
    // A holds a raw attachment of its own, which the person allows.
    const attachA = a.call("browser_connect", {});
    await decide(direct, "allow");
    const attachedA = structured(await attachA);
    expect(attachedA).toMatchObject({ status: "completed" });
    work.a.tasks.add(String(attachedA.taskId));
    work.a.tabs.add(String(attachedA.tabId));
    const browserA = await chromium.connectOverCDP(
      String(attachedA.endpoint),
      attachedA.mode === "session" ? { noDefaults: true } : {},
    );
    clients.push(browserA);
    const closedA = new Promise<void>((resolve) => browserA.once("disconnected", () => resolve()));
    const pageA = browserA.contexts()[0]!.pages()[0]!;
    await pageA.goto(new URL("/account", siteOrigin).href);
    expect(await pageA.locator("h1").innerText()).toBe("Signed in as Alice");

    // B keeps working while A is disconnected.
    const bWorking = (async () => {
      const seen: string[] = [];
      for (let step = 0; step < 5; step++) {
        await pageB!.goto(new URL(`/account?step=${step}`, siteOrigin).href);
        seen.push(await pageB!.locator("h1").innerText());
      }
      return seen;
    })();
    ok(
      await home.api["commands.dispatch"]({
        type: "connection.revoke",
        idempotencyKey: randomUUID(),
        connectionId: AgentConnectionIdSchema.parse(a.connectionId),
      }),
    );
    await closedA;
    // The next call is refused, and the token no longer opens the Home.
    await expect(a.call("tab_list", {})).rejects.toThrow();
    const raw = await fetch(new URL(agentConnectionMcpPath, home.hostOrigin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${a.bearer}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(401);
    const stoppedConnection = await home.observe(
      async () => {
        const listed = ok(await home.api["connections.list"]({ includeRevoked: true }));
        const entry = [...listed.connections, ...(listed.endedConnections ?? [])].find(
          ({ id }) => id === a.connectionId,
        );
        return entry?.state === "stopped" ? entry : undefined;
      },
      within(60_000),
      "A's connection never reached Stopped",
    );
    expect(stoppedConnection.revokedAt).toEqual(expect.any(String));

    // B worked throughout and finishes.
    expect(await bWorking).toEqual(Array(5).fill("Signed in as Bob"));
    readByB.push(...(await bWorking));
    expect(browserBDisconnected).toBe(false);
    const finished = await b.call("tab_list", {});
    expect(finished.isError).toBeUndefined();
    expect(text(finished)).toContain([...work.b.tabs][0]);
  }, 180_000);

  it("never gives either agent the other's data or any secret", () => {
    const of = (agent: Agent) => agent.received.join("\n");
    const secrets = [
      alice.secret,
      bob.secret,
      a.bearer,
      b.bearer,
      ...(a.refresh ? [a.refresh] : []),
      ...(b.refresh ? [b.refresh] : []),
      ...ownerSessionCookie
        .split(";")
        .map((part) => part.split("=").slice(1).join("=").trim())
        .filter((value) => value.length >= 16),
    ];
    const theirs = (
      other: typeof work.a,
      profile: typeof profileA,
      person: Person,
      label: string,
    ) => [
      profile.id,
      profile.name,
      person.order,
      `Signed in as ${person.name}`,
      label,
      ...other.tasks,
      ...other.tabs,
    ];
    const receivedByA = of(a);
    const receivedByB = [of(b), ...readByB].join("\n");
    for (const value of [...secrets, ...theirs(work.b, profileB, bob, "Agent B")])
      expect(receivedByA.includes(value), `A received ${value}`).toBe(false);
    for (const value of [...secrets, ...theirs(work.a, profileA, alice, "Agent A")])
      expect(receivedByB.includes(value), `B received ${value}`).toBe(false);
  });
});
