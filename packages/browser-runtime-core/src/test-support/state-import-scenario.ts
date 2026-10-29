import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { BrowserCookie } from "@opensteer/browser-profile/snapshot";
import { browserCookieIdentity } from "@opensteer/browser-profile/source-state";
import {
  BrowserSessionIdSchema,
  type BrowserAttachTicketClaims,
  type BrowserClientMessage,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import type { BrowserLauncher } from "../browser/backend.js";
import { BrowserRuntime, type BrowserAttachment } from "../runtime.js";
import {
  FakeProfileStateClient,
  FakeSink,
  FakeTicketVerifier,
  testSessionFilesRoot,
  validClaims,
} from "./fakes.js";

/**
 * One end-to-end live sign-in scenario shared by every real engine: the
 * Playwright integration test and the Electron smoke drive the same
 * `state.import` frames through a real BrowserRuntime and must produce the
 * same cookie jars. The engine must resolve `*.example.test` to 127.0.0.1
 * (keeping the port) so the HTTP fixture can observe what the browser sends.
 */
export interface StateImportScenarioReport {
  readonly checkpoint: readonly string[];
  readonly concurrentWinner: "first" | "second";
  readonly engine: string;
  readonly fixtureCookieHeader: string;
  readonly jars: Readonly<Record<string, readonly string[]>>;
}

const expires = Math.floor(Date.now() / 1_000) + 3_600;
const secureBase = {
  expires,
  hostOnly: true,
  httpOnly: false,
  path: "/",
  secure: true,
} as const;

/** Cookies no `https://example.com` sign-in may touch. */
const outOfScope: BrowserCookie[] = [
  // A third party's cookie partitioned under the site belongs to the third party.
  {
    ...secureBase,
    domain: "embedded.test",
    name: "third-party-partition",
    partitionKey: "https://example.com",
    partitionKeyHasCrossSiteAncestor: true,
    sameSite: "None",
    value: "embedded",
  },
  // The site's own cookie partitioned under another top-level site.
  {
    ...secureBase,
    domain: "example.com",
    name: "foreign-partition",
    partitionKey: "https://other.com",
    partitionKeyHasCrossSiteAncestor: true,
    sameSite: "None",
    value: "foreign",
  },
  { ...secureBase, domain: "example.org", name: "other-site", value: "other" },
  { ...secureBase, domain: "notexample.com", name: "suffix-trick", value: "suffix" },
  // Secure cookies never belong to an http site's scope.
  { ...secureBase, domain: "example.test", name: "secure-left", value: "secure" },
];

/** In-scope cookies the site's anonymous visit left behind. */
const staleInScope: BrowserCookie[] = [
  { ...secureBase, domain: "example.com", httpOnly: true, name: "__Host-anon", value: "anon" },
  {
    ...secureBase,
    domain: ".example.com",
    hostOnly: false,
    name: "shared",
    sameSite: "Lax",
    value: "old",
  },
  { ...secureBase, domain: "api.example.com", name: "sibling", value: "sibling" },
  { ...secureBase, domain: "example.com", name: "same-name", value: "host-old" },
  {
    ...secureBase,
    domain: ".example.com",
    hostOnly: false,
    name: "same-name",
    value: "domain-old",
  },
  {
    ...secureBase,
    domain: "example.com",
    name: "chips",
    partitionKey: "https://example.com",
    partitionKeyHasCrossSiteAncestor: false,
    sameSite: "None",
    value: "old-false",
  },
  {
    ...secureBase,
    domain: "example.com",
    name: "chips",
    partitionKey: "https://example.com",
    partitionKeyHasCrossSiteAncestor: true,
    sameSite: "None",
    value: "old-true",
  },
  { ...secureBase, domain: "example.com", expires: -1, name: "plain", secure: false, value: "p" },
  {
    ...secureBase,
    domain: ".example.com",
    hostOnly: false,
    name: "__Secure-old",
    value: "old",
  },
];

function signIn(label: string): BrowserCookie[] {
  return [
    {
      ...secureBase,
      domain: ".example.com",
      hostOnly: false,
      httpOnly: true,
      name: "shared",
      sameSite: "Lax",
      value: `${label}-shared`,
    },
    {
      ...secureBase,
      domain: ".example.com",
      hostOnly: false,
      name: "same-name",
      value: `${label}-domain`,
    },
    {
      ...secureBase,
      domain: "example.com",
      name: "chips",
      partitionKey: "https://example.com",
      partitionKeyHasCrossSiteAncestor: false,
      sameSite: "None",
      value: `${label}-chips`,
    },
    {
      ...secureBase,
      domain: "example.com",
      httpOnly: true,
      name: "__Host-session",
      sameSite: "Lax",
      value: `${label}-session`,
    },
    {
      ...secureBase,
      domain: "www.example.com",
      expires: -1,
      name: "sub",
      path: "/account",
      value: `${label}-sub`,
    },
    {
      ...secureBase,
      domain: "example.com",
      name: "plain-new",
      sameSite: "Lax",
      secure: false,
      value: `${label}-plain`,
    },
  ];
}

/** A different identity set, so an interleaved pair of imports leaves a visible mix. */
const alternateSignIn: BrowserCookie[] = [
  {
    ...secureBase,
    domain: "example.com",
    name: "alternate-only",
    sameSite: "Lax",
    value: "alternate",
  },
  {
    ...secureBase,
    domain: ".example.com",
    hostOnly: false,
    httpOnly: true,
    name: "shared",
    sameSite: "Lax",
    value: "alternate-shared",
  },
];

const httpSignIn: BrowserCookie[] = [
  {
    domain: "app.example.test",
    expires: -1,
    hostOnly: true,
    httpOnly: true,
    name: "session",
    path: "/",
    sameSite: "Lax",
    secure: false,
    value: "signed-in",
  },
  {
    domain: ".example.test",
    expires,
    hostOnly: false,
    httpOnly: false,
    name: "account",
    path: "/",
    secure: false,
    value: "a1",
  },
];

export async function runStateImportScenario(options: {
  readonly engine: string;
  readonly launcher: BrowserLauncher;
}): Promise<StateImportScenarioReport> {
  const requests: Array<{ cookie: string; host: string; path: string }> = [];
  const fixture = createServer((request: IncomingMessage, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push({ cookie: request.headers.cookie ?? "", host: request.headers.host ?? "", path });
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      ...(path === "/anon"
        ? { "set-cookie": ["anon=1; Path=/", "tracker=1; Domain=example.test; Path=/"] }
        : {}),
    });
    response.end(`<!doctype html><title>${path}</title>`);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing.");
  const origin = `http://app.example.test:${address.port}`;

  const profileState = new FakeProfileStateClient();
  profileState.snapshot = { cookies: [...outOfScope, ...staleInScope], origins: [] };
  const verifier = new FakeTicketVerifier();
  const sessionIds = {
    first: "bsn_00000000-0000-4000-8000-00000000a001",
    second: "bsn_00000000-0000-4000-8000-00000000a002",
    viewer: "bsn_00000000-0000-4000-8000-00000000a003",
  } as const;
  type SessionName = keyof typeof sessionIds;
  for (const [token, sessionId] of Object.entries(sessionIds)) {
    const claims = validClaims({ sessionId: BrowserSessionIdSchema.parse(sessionId) });
    // The attach-ticket schema admits only full control today; the controller
    // still refuses anything else, so the viewer is modelled directly.
    verifier.setClaims(
      token,
      token === "viewer"
        ? ({ ...claims, access: "view-only" } as unknown as BrowserAttachTicketClaims)
        : claims,
    );
  }
  const runtime = new BrowserRuntime({
    launcher: options.launcher,
    profileStateClient: profileState,
    runtimeId: "runtime_test",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
  });
  let order = 0;
  const receivedAt = new Map<string, number>();
  const sessions = new Map<SessionName, { attachment: BrowserAttachment; sink: FakeSink }>();
  const session = (name: SessionName) => {
    const found = sessions.get(name);
    if (!found) throw new Error(`Session ${name} is not attached.`);
    return found;
  };
  try {
    for (const name of ["first", "second", "viewer"] as const) {
      const sink = new FakeSink();
      sink.sendServerImplementation = async (message) => {
        if (message.type === "state.import.result") receivedAt.set(message.operationId, ++order);
      };
      sessions.set(name, { attachment: await runtime.attach(name, sink), sink });
    }
    const jars: Record<string, readonly string[]> = {};
    const send = (name: SessionName, message: BrowserClientMessage) =>
      session(name).attachment.handle(JSON.stringify(message));
    const importState = async (
      name: SessionName,
      site: string,
      cookies: readonly BrowserCookie[],
    ) => {
      const operationId = randomUUID();
      await send(name, { cookies: [...cookies], operationId, site, type: "state.import" });
      return awaitMessage(
        session(name).sink,
        (message): message is Extract<BrowserServerMessage, { type: "state.import.result" }> =>
          message.type === "state.import.result" && message.operationId === operationId,
      );
    };
    const exportJar = async (name: SessionName): Promise<BrowserCookie[]> => {
      const before = session(name).sink.messages.length;
      await send(name, { type: "state.export" });
      const exported = await awaitMessage(
        session(name).sink,
        (message): message is Extract<BrowserServerMessage, { type: "state.exported" }> =>
          message.type === "state.exported",
        before,
      );
      return exported.snapshot.cookies;
    };

    assertJar("restored", await exportJar("first"), [...outOfScope, ...staleInScope]);

    const refused = await importState("viewer", "https://example.com", signIn("viewer"));
    if (refused.error?.code !== "forbidden") {
      throw new Error(`view-only import: expected forbidden, got ${JSON.stringify(refused)}`);
    }
    const outside = await importState("first", "https://example.com", [
      ...signIn("outside"),
      { ...secureBase, domain: "example.org", name: "smuggled", value: "x" },
    ]);
    if (outside.error?.code !== "bad_message") {
      throw new Error(`out-of-scope import: expected bad_message, got ${JSON.stringify(outside)}`);
    }
    assertJar("refused imports", await exportJar("first"), [...outOfScope, ...staleInScope]);

    const applied = await importState("first", "https://example.com", signIn("one"));
    if (applied.error !== null) throw new Error(`import failed: ${JSON.stringify(applied)}`);
    jars.applied = assertJar("applied", await exportJar("first"), [
      ...outOfScope,
      ...signIn("one"),
    ]);
    // One host, one jar: the other session sees the same sign-in.
    jars.otherSession = assertJar("other session", await exportJar("second"), [
      ...outOfScope,
      ...signIn("one"),
    ]);

    const firstId = randomUUID();
    const secondId = randomUUID();
    await Promise.all([
      send("first", {
        cookies: alternateSignIn,
        operationId: firstId,
        site: "https://example.com",
        type: "state.import",
      }),
      send("second", {
        cookies: signIn("two"),
        operationId: secondId,
        site: "https://example.com",
        type: "state.import",
      }),
    ]);
    for (const [name, operationId] of [
      ["first", firstId],
      ["second", secondId],
    ] as const) {
      const result = await awaitMessage(
        session(name).sink,
        (message): message is Extract<BrowserServerMessage, { type: "state.import.result" }> =>
          message.type === "state.import.result" && message.operationId === operationId,
      );
      if (result.error !== null)
        throw new Error(`concurrent import failed: ${JSON.stringify(result)}`);
    }
    const concurrentWinner =
      (receivedAt.get(firstId) ?? 0) > (receivedAt.get(secondId) ?? 0) ? "first" : "second";
    jars.concurrent = assertJar("concurrent", await exportJar("second"), [
      ...outOfScope,
      ...(concurrentWinner === "first" ? alternateSignIn : signIn("two")),
    ]);

    await send("first", { type: "navigation.go", url: `${origin}/anon` });
    await waitFor(async () => (await exportJar("first")).some(({ name }) => name === "tracker"));
    const httpApplied = await importState("second", "http://example.test", httpSignIn);
    if (httpApplied.error !== null)
      throw new Error(`http import failed: ${JSON.stringify(httpApplied)}`);
    const signedInJar = [
      ...outOfScope,
      ...(concurrentWinner === "first" ? alternateSignIn : signIn("two")),
      ...httpSignIn,
    ];
    jars.http = assertJar("http", await exportJar("first"), signedInJar);
    await send("first", { type: "navigation.go", url: `${origin}/check` });
    await waitFor(async () => requests.some(({ path }) => path === "/check"));
    // Playwright's page close can stall on a navigation that has not
    // committed, so the checkpointing detach below waits for the page.
    await waitFor(async () =>
      session("first").sink.messages.some(
        (message) =>
          message.type === "browser.surfaces.changed" &&
          message.surfaces.some((surface) => surface.title === "/check"),
      ),
    );
    const fixtureCookieHeader = requests.find(({ path }) => path === "/check")?.cookie ?? "";
    const sent = fixtureCookieHeader.split(/;\s*/u).sort();
    if (JSON.stringify(sent) !== JSON.stringify(["account=a1", "session=signed-in"])) {
      throw new Error(`fixture received ${JSON.stringify(fixtureCookieHeader)}`);
    }

    for (const { attachment } of sessions.values()) await attachment.close();
    const committed = profileState.commits.at(-1)?.snapshot;
    if (!committed) throw new Error("The profile host did not checkpoint on close.");
    const checkpoint = assertJar("checkpoint", committed.cookies, signedInJar);
    return { checkpoint, concurrentWinner, engine: options.engine, fixtureCookieHeader, jars };
  } finally {
    await runtime.shutdown().catch(() => undefined);
    fixture.close();
    fixture.closeAllConnections();
  }
}

/** Compares complete cookies, every field, as an unordered set. */
function assertJar(
  stage: string,
  actual: readonly BrowserCookie[],
  expected: readonly BrowserCookie[],
): string[] {
  const render = (cookies: readonly BrowserCookie[]) =>
    cookies
      .map((cookie) => JSON.stringify(Object.entries(cookie).sort(([a], [b]) => (a < b ? -1 : 1))))
      .sort();
  const actualRendered = render(actual);
  const expectedRendered = render(expected);
  if (JSON.stringify(actualRendered) !== JSON.stringify(expectedRendered)) {
    const missing = expectedRendered.filter((cookie) => !actualRendered.includes(cookie));
    const extra = actualRendered.filter((cookie) => !expectedRendered.includes(cookie));
    throw new Error(
      `${stage}: cookie jar differs\nmissing ${JSON.stringify(missing, null, 1)}\nextra ${JSON.stringify(extra, null, 1)}`,
    );
  }
  return actual.map((cookie) => `${browserCookieIdentity(cookie)}=${cookie.value}`).sort();
}

async function awaitMessage<Message extends BrowserServerMessage>(
  sink: FakeSink,
  predicate: (message: BrowserServerMessage) => message is Message,
  from = 0,
): Promise<Message> {
  let found: Message | undefined;
  await waitFor(async () => {
    found = sink.messages.slice(from).find(predicate);
    return found !== undefined;
  });
  if (!found) throw new Error("Expected browser message was not received.");
  return found;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
