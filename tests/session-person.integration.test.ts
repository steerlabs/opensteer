import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { chromium } from "playwright-core";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  pageWithTarget,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { type BrowserAttachPublicKey } from "../packages/protocol/src/browser.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { BrowserModuleRelay } from "../packages/runner-client/src/browser-relay.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "../apps/host/src/mcp/mcp-sdk-client.test-support.js";
import { AgentConnectionStore } from "../packages/database/src/index.js";
import { NotificationStore } from "../packages/database/src/notification-store.js";
import {
  AgentOperationIdSchema,
  BrowserSurfaceIdSchema,
  createId,
  requestOperationCallsHeading,
  requestOperationCallsMaxLength,
  requestTextMaxLength,
  ThreadIdSchema,
  type Request,
} from "../packages/core/src/index.js";
import { z } from "zod";
import { expect, it, vi } from "vitest";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  startPrivateMachineHost,
} from "../apps/host/src/runtime/private-machine-host.test-support.js";
import {
  credentialHash,
  connectionCredentialPrefix,
} from "../apps/host/src/mcp/connections/connection-authenticator.js";
import { mcpResourcePath } from "../apps/host/src/mcp/connections/connection-oauth.js";
import { testRpcData } from "../apps/host/src/server/test-host-api-request.js";
import { startBrowserRuntime } from "../apps/host/src/browser/browser-runtime.test-support.js";
import {
  passwordFixture,
  startPasswordsAuthority,
} from "../apps/host/src/browser/passwords-authority.test-support.js";

const tabOutput = z
  .tuple([z.object({ type: z.literal("text"), text: BrowserSurfaceIdSchema })])
  .rest(z.unknown());

async function startSessionPersonFixture() {
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  const close: (() => Promise<unknown>)[] = [() => database.drop()];
  const notices = new Map<
    Request["kind"],
    (
      reaction: Extract<
        import("../packages/database/src/personal-mutation.js").PersonalCommitReaction,
        { type: "requestChanged" }
      >,
    ) => void
  >();
  const dispose = async () => {
    for (const fn of close.reverse()) await fn().catch(() => undefined);
  };
  try {
    const site = await signInFixture();
    close.push(site.close);
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-session-person-"));
    close.push(() => rm(scratch, { recursive: true, force: true }));
    const launcher = new PlaywrightChromiumLauncher({
      executablePath: chromium.executablePath(),
      headless: true,
      chromiumSandbox: false,
      args: [
        "--no-proxy-server",
        "--host-resolver-rules=MAP passwords-fixture.test 127.0.0.1, MAP other-fixture.test 127.0.0.1",
      ],
    });
    let chromiumBrowser: LaunchedBrowser | undefined;
    let keys: readonly BrowserAttachPublicKey[] = [];
    let passwords: Awaited<ReturnType<typeof startPasswordsAuthority>> | undefined;
    const runtimeId = "browser-runtime-integration";
    const runtime = new BrowserRuntime({
      runtimeId,
      launcher: {
        localProfiles: launcher.localProfiles,
        launch: async (request, signal) => {
          chromiumBrowser = await launcher.launch(request, signal);
          return chromiumBrowser;
        },
      },
      localProfiles: { root: join(scratch, "profiles") },
      sessionFilesRoot: join(scratch, "files"),
      ticketVerifier: await Ed25519AttachTicketVerifier.create({
        replayLedgerPath: join(scratch, "private", "replay.json"),
        resolvePublicKey: (id) => keys.find((key) => key.keyId === id)?.publicKeyPem ?? null,
      }),
      loginAuthority: {
        probe: async () => "has-login",
        authorize: async () => ({ kind: "ended", outcome: { kind: "expired" } }),
        end: async () => undefined,
        fill: async () => "expired",
        fillReference: async ({ loginRef, field, targetId, lease }) => {
          const value = passwords?.releasedLogin(loginRef, field);
          if (!value || !chromiumBrowser) return "expired";
          const page = await pageWithTarget(
            chromiumBrowser.context.pages(),
            targetId,
            1_000,
            (entry) => !entry.isClosed(),
          );
          if (!page || new URL(page.url()).origin !== site.origin) return "wrong-site";
          const cdp = await page.agentCdp();
          try {
            lease.throwIfAborted();
            await cdp.send("Input.insertText", { text: value });
            return "filled";
          } finally {
            await cdp.detach();
          }
        },
      },
    });
    const bridgeToken = randomBytes(32).toString("base64url");
    const runtimeServer = new BrowserRuntimeServer({
      runtime,
      port: 0,
      relayBridge: {
        token: bridgeToken,
        updateAttachKeys: (next) => {
          keys = next;
        },
      },
    });
    close.push(() => runtimeServer.close());
    const address = await runtimeServer.start();
    const runtimeRelay = new BrowserModuleRelay(
      new LocalBrowserRuntimeBridge({
        runtimeId,
        bridgeToken,
        url: new URL(`http://${address.host}:${address.port}`),
      }),
    );
    const host = await startPrivateMachineHost(database.url, {
      onPersonalReaction: (reaction) => {
        if (reaction.type === "requestChanged" && reaction.status === "pending")
          notices.get(reaction.kind)?.(reaction);
      },
    });
    close.push(() => host.close());
    const mac = await connectCallerMachine(host, {
      name: "Passwords Mac",
      environmentId: host.ownerEnvironmentId,
      loginFill: true,
      token: host.hostingRunnerEnrollmentToken,
      integrations: { platform: "darwin", protocolVersion: 5, passwordSignIn: 2, cardUse: 1 },
      browser: {
        runtimeId,
        wireVersion: 2,
        cdpBoundary: 1,
        sharedControl: 1,
        tabRestoreVersion: 1,
        surfaceState: 1,
        signIn: { version: 3 },
        cardFill: 1,
        localProfileStorage: runtime.localProfileStorage!,
      },
    });
    close.push(() => mac.close());
    const witnessed: boolean[] = [];
    const authority = (passwords = await startPasswordsAuthority(
      host.hostPort,
      mac.primary,
      async (operationId) => {
        const witness = await host.store.database
          .selectFrom("requests")
          .innerJoin("agentOperations", "agentOperations.requestId", "requests.id")
          .select("requests.status")
          .where(sql<boolean>`requests.payload @> ${JSON.stringify({ operationId })}::jsonb`)
          .where("agentOperations.state", "=", "handed-off")
          .executeTakeFirst();
        witnessed.push(witness?.status === "pending");
      },
    ));
    close.push(() => authority.close());
    let loseOpenReply: { url: string; requestId?: string; observed: boolean } | undefined;
    const browser = await startBrowserRuntime(host.hostPort, "existing-main", {
      primary: mac.primary,
      runtimeRelay: {
        detach: () => runtimeRelay.detach(),
        async handleFrame(frame, binary) {
          if (!binary && loseOpenReply) {
            const command = z
              .object({
                type: z.literal("browser.client-message"),
                message: z.object({
                  type: z.literal("cdp.command"),
                  requestId: z.string(),
                  command: z.object({
                    method: z.literal("Opensteer.openTab"),
                    parameters: z.object({ url: z.literal(loseOpenReply.url) }),
                  }),
                }),
              })
              .safeParse(JSON.parse(frame.toString()));
            if (command.success) loseOpenReply.requestId = command.data.message.requestId;
          }
          await runtimeRelay.handleFrame(frame, binary);
        },
        attach: (stream) =>
          runtimeRelay.attach({
            ...stream,
            async send(frame, binary) {
              if (!binary && loseOpenReply?.requestId) {
                const response = z
                  .object({
                    type: z.literal("browser.server-message"),
                    message: z.object({
                      type: z.literal("cdp.result"),
                      requestId: z.literal(loseOpenReply.requestId),
                      result: z.object({ tabId: BrowserSurfaceIdSchema }),
                    }),
                  })
                  .safeParse(JSON.parse(frame.toString()));
                if (response.success) {
                  loseOpenReply.observed = true;
                  await browser.close();
                  return;
                }
              }
              await stream.send(frame, binary);
            },
          }),
      },
      keepAlive: true,
    });
    close.push(() => browser.close());
    const profile = await host.store.createBrowserProfile({
      ownerId: host.ownerId,
      homeRunnerId: browser.runnerId,
      idempotencyKey: "work",
      name: "Work",
    });
    const endpoint = new URL(mcpResourcePath, host.origin);
    const transcript: unknown[] = [];
    const connection = new AgentConnectionStore(host.store.database);
    const connectAgent = async (bearer: string) => {
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: "Bearer " + bearer } },
      });
      let receive: typeof transport.onmessage;
      Object.defineProperty(transport, "onmessage", {
        get: () => receive,
        set: (receiver: typeof transport.onmessage) => {
          receive = (message) => {
            transcript.push(message);
            receiver?.(message);
          };
        },
      });
      const client = new Client({ name: "external-session", version: "1" });
      close.push(() => client.close());
      await client.connect(transport as unknown as Transport);
      return (name: string, args: Record<string, unknown>) => {
        const context = new Error(
          `MCP ${name} (${args.operationKey ?? "no operation key"}) did not return`,
        );
        return client.callTool({ name, arguments: args }).catch((error: unknown) => {
          context.cause = error;
          throw context;
        });
      };
    };
    type AgentCall = Awaited<ReturnType<typeof connectAgent>>;
    const refusedOrDisconnected = (result: ReturnType<AgentCall>) =>
      result.then(
        (reply) => reply.isError === true,
        (error: unknown) => {
          if (
            z
              .object({
                cause: z.object({ cause: z.object({ code: z.literal("UND_ERR_SOCKET") }) }),
              })
              .safeParse(error).success
          )
            return true;
          throw error;
        },
      );
    const owner = { headers: host.ownerHeaders };
    const pending = async (
      kind: Request["kind"],
      invoke: () => ReturnType<AgentCall>,
      expectedTask: string | null,
    ) => {
      const shown =
        Promise.withResolvers<Parameters<NonNullable<ReturnType<typeof notices.get>>>[0]>();
      notices.set(kind, shown.resolve);
      const result = invoke();
      const reaction = await Promise.race([
        shown.promise,
        result.then((response) => {
          throw new Error("Call ended before opening its Request: " + JSON.stringify(response));
        }),
      ]);
      notices.delete(kind);
      const { requestId } = reaction;
      const row = await host.store.database
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow();
      if (expectedTask) expect(row.originatingThreadId).toBe(expectedTask);
      expect(row.originatingAgentSessionId).toBeTruthy();
      return { reaction, requestId, expectedRevision: row.revision, row, result };
    };

    return {
      site,
      host,
      authority,
      witnessed,
      browser,
      profile,
      endpoint,
      transcript,
      connection,
      connectAgent,
      refusedOrDisconnected,
      owner,
      pending,
      close,
      setLoseOpenReply: (value: { url: string; requestId?: string; observed: boolean }) => {
        loseOpenReply = value;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "lets a selected browser agent ask the person, fill approved Passwords, and lose the reference on Disconnect",
  async () => {
    const fixture = await startSessionPersonFixture();
    const {
      site,
      host,
      authority,
      witnessed,
      browser,
      profile,
      endpoint,
      transcript,
      connection,
      connectAgent,
      refusedOrDisconnected,
      owner,
      close,
    } = fixture;
    try {
      const agent = await connection.create({
        userId: host.ownerId,
        label: "Research assistant",
        clientName: "Research assistant",
        resource: endpoint.href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId: profile.id }],
        },
      });
      const token = connectionCredentialPrefix + randomBytes(32).toString("base64url");
      expect(await connection.activate(agent.id, credentialHash(token))).toBe(true);
      const call = await connectAgent(token);
      const opened = await call("browser_use", {
        profileId: profile.id,
        code: `const page = await newPage(${JSON.stringify(site.origin)}); print(page.tabId);`,
        operationKey: "open-form",
      });
      expect(
        opened.isError,
        JSON.stringify({
          content: opened.content,
          errors: browser.protocolErrors(),
          attached: browser.connectionCount(),
          stream: browser.streamOpen(),
        }),
      ).not.toBe(true);
      const { taskId } = z.object({ taskId: ThreadIdSchema }).parse(opened.structuredContent);
      const tabId = tabOutput.parse(opened.content)[0].text;
      const pending = (
        kind: Request["kind"],
        invoke: () => ReturnType<typeof call>,
        expectedTask: string | null = taskId,
      ) => fixture.pending(kind, invoke, expectedTask);

      const question = await pending("person.question", () =>
        call("ask_person", {
          taskId,
          operationKey: "ask",
          title: "Check the phone",
          detail: "Enter the code in the tab.",
          questions: [{ question: "Did you enter it?" }],
        }),
      );
      expect(question.row.agentOperation).toBeNull();
      expect(question.row.presentation).toMatchObject({
        title: expect.stringContaining("Connected agent Research assistant asks in"),
        detail: expect.stringContaining("> Enter the code in the tab."),
        fields: [expect.objectContaining({ custom: false, secret: false })],
      });
      const needs = await testRpcData(host.origin, "requests.list", {}, owner);
      expect(needs.requests).toContainEqual(
        expect.objectContaining({
          request: expect.objectContaining({ id: question.requestId, originatingThreadId: taskId }),
        }),
      );
      expect(await new NotificationStore(host.store.database).decide(question.reaction)).toEqual([
        expect.objectContaining({
          userId: host.ownerId,
          view: expect.objectContaining({
            threadId: taskId,
            requestId: question.requestId,
            body: expect.stringContaining("Connected agent Research assistant"),
          }),
        }),
      ]);
      const answer = {
        type: "request.respond" as const,
        requestId: question.requestId,
        expectedRevision: question.expectedRevision,
      };
      await expect(
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            ...answer,
            idempotencyKey: "invalid-answer",
            response: { kind: "form", answers: { question_1: ["123456"] } },
          },
          owner,
        ),
      ).rejects.toThrow();
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          ...answer,
          idempotencyKey: "answer",
          response: { kind: "form", answers: { question_1: ["Done"] } },
        },
        owner,
      );
      expect((await question.result).structuredContent).toMatchObject({
        status: "completed",
        answer: "Done",
      });

      const script = (operationKey: string, code: string) =>
        call("browser_use", {
          taskId,
          tabId,
          operationKey,
          code,
        });
      const pageBinding = `const page = await openPage(${JSON.stringify(tabId)});`;
      const form = await script(
        "detect-form",
        pageBinding + 'print(await page.locator("h1").innerText());',
      );
      expect(form.isError, JSON.stringify(form.content)).not.toBe(true);
      expect(form.content).toContainEqual({ type: "text", text: "Sign in" });

      const login = await pending("browser.password-sign-in", () =>
        call("saved_login_request", {
          taskId,
          tabId,
          site: site.origin,
          reason: "Continue in the browser",
          operationKey: "login",
        }),
      );
      const chooser = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: login.requestId },
        owner,
      );
      if (chooser.stage !== "approval") throw new Error("Expected a Passwords picker");
      const choice = chooser.accounts[0]!;
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "browser.password-sign-in.respond",
          requestId: login.requestId,
          expectedRevision: login.expectedRevision,
          idempotencyKey: "login-approve",
          decision: {
            kind: "approve",
            loginId: choice.id,
            revision: choice.revision,
            permissionVersion: 6,
            remember: true,
          },
        },
        owner,
      );
      const ready = z
        .object({
          status: z.literal("completed"),
          operationId: AgentOperationIdSchema,
          loginStatus: z.literal("ready"),
          loginRef: z.string(),
        })
        .parse((await login.result).structuredContent);
      const authorizationCommands = authority.commands.length;
      expect(
        (
          await call("saved_login_request", {
            taskId,
            tabId,
            site: site.origin,
            reason: "Continue in the browser",
            operationId: ready.operationId,
          })
        ).structuredContent,
      ).toMatchObject(ready);
      expect(authority.commands).toHaveLength(authorizationCommands);
      expect(authority.commands).toContainEqual(
        expect.objectContaining({ type: "login.authorize", alwaysAsk: true }),
      );
      expect(authority.commands).toContainEqual(
        expect.objectContaining({ type: "login.approve", remember: false }),
      );
      const fill = await script(
        "fill-login",
        pageBinding +
          `
        const reference = ${JSON.stringify(ready.loginRef)};
        const fill = async (field) => {
          await page.js(\`document.querySelector('[name=\${field}]').focus()\`);
          const result = await page.cdp("Opensteer.fillLogin", { loginRef: reference, field });
          if (result.status !== "filled") throw new Error(JSON.stringify(result));
        };
        await fill("username");
        await fill("password");
        await page.getByRole("button", { name: "Sign in" }).click();
        const signedIn = page.getByRole("heading", { name: "Signed in" });
        await signedIn.waitFor();
        print(await signedIn.innerText());
      `,
      );
      expect(fill.isError, JSON.stringify(fill.content)).not.toBe(true);
      expect(fill.content).toContainEqual({ type: "text", text: "Signed in" });

      const card = await pending("browser.password-sign-in", () =>
        call("card_request", {
          taskId,
          tabId,
          site: site.origin,
          reason: "Prepare a checkout",
          operationKey: "card",
        }),
      );
      const cardChooser = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: card.requestId },
        owner,
      );
      if (cardChooser.stage !== "card-approval") throw new Error("Expected a card picker");
      const cardChoice = cardChooser.cards[0]!;
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "browser.password-sign-in.respond",
          requestId: card.requestId,
          expectedRevision: card.expectedRevision,
          idempotencyKey: "card-allow",
          decision: {
            kind: "approve-card",
            cardId: cardChoice.id,
            revision: cardChoice.revision,
            permissionVersion: 7,
          },
        },
        owner,
      );
      const cardReply = (await card.result).structuredContent;
      expect(cardReply).not.toHaveProperty("lastFour");
      expect(cardReply).not.toHaveProperty("brand");
      expect(cardReply).toMatchObject({
        status: "completed",
        cardStatus: "ready",
        cardRef: expect.stringMatching(/^crd_/u),
      });
      expect(witnessed).toEqual([true, true]);

      const cardRef = z.object({ cardRef: z.string() }).parse(cardReply).cardRef;
      const checkReferences = (page: string) => `
        print((await ${page}.cdp("Opensteer.fillLogin", ${JSON.stringify({
          loginRef: ready.loginRef,
          field: "password",
        })})).status);
        print((await ${page}.cdp("Opensteer.fillCard", ${JSON.stringify({
          cardRef,
          field: "number",
        })})).status);
      `;
      const fillCommandCount = () =>
        browser
          .receivedCommands()
          .filter(
            (entry) =>
              z
                .object({ method: z.enum(["Opensteer.fillLogin", "Opensteer.fillCard"]) })
                .safeParse(entry.command).success,
          ).length;
      const beforeReplay = fillCommandCount();
      const expectExpired = (result: Awaited<ReturnType<typeof call>>) => {
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        const receipt = z
          .object({
            status: z.literal("completed"),
            taskId: ThreadIdSchema,
            operationId: AgentOperationIdSchema,
          })
          .parse(result.structuredContent);
        expect(result.content).toEqual([
          { type: "text", text: "expired" },
          { type: "text", text: "expired" },
          { type: "text", text: `Receipt: ${JSON.stringify(receipt)}` },
        ]);
      };
      expectExpired(
        await script(
          "other-tab",
          `
        const otherPage = await newPage(${JSON.stringify(site.origin)});
        ${checkReferences("otherPage")}
      `,
        ),
      );
      const sibling = await connection.create({
        userId: host.ownerId,
        label: "Another research assistant",
        clientName: "Another research assistant",
        resource: endpoint.href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId: profile.id }],
        },
      });
      const siblingToken = connectionCredentialPrefix + randomBytes(32).toString("base64url");
      expect(await connection.activate(sibling.id, credentialHash(siblingToken))).toBe(true);
      const siblingCall = await connectAgent(siblingToken);
      expectExpired(
        await siblingCall("browser_use", {
          profileId: profile.id,
          code: `
          const ownPage = await newPage(${JSON.stringify(site.origin)});
          ${checkReferences("ownPage")}
        `,
        }),
      );
      for (const tool of ["saved_login_request", "card_request"]) {
        const ask = (target: string) =>
          siblingCall(tool, {
            tabId: target,
            site: site.origin,
            reason: "Sign in",
          });
        const hidden = await ask(tabId);
        const missing = await ask(createId("tab"));
        expect(hidden.isError).toBe(true);
        expect(hidden.content).toEqual(missing.content);
      }
      const otherSite = site.origin.replace("passwords-fixture.test", "other-fixture.test");
      expectExpired(
        await script(
          "other-site",
          pageBinding +
            `
        await page.goto(${JSON.stringify(otherSite)});
        ${checkReferences("page")}
      `,
        ),
      );
      expect(fillCommandCount()).toBe(beforeReplay);
      const returned = await script(
        "return-to-form",
        pageBinding +
          `
        await page.goto(${JSON.stringify(site.origin)});
      `,
      );
      expect(returned.isError, JSON.stringify(returned.content)).not.toBe(true);

      const stillWaiting = await pending("person.question", () =>
        call("ask_person", {
          taskId,
          operationKey: "still-waiting",
          title: "Check the approval",
          questions: [{ question: "Did it go through?" }],
        }),
      );
      await expect(
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            ...answer,
            idempotencyKey: "old-answer",
            response: { kind: "form", answers: { question_1: ["Done"] } },
          },
          owner,
        ),
      ).rejects.toThrow();
      expect((await host.store.requests.get(stillWaiting.requestId))?.status).toBe("pending");

      const waitingLogin = await pending("browser.password-sign-in", () =>
        call("saved_login_request", {
          taskId,
          tabId,
          site: site.origin,
          reason: "Sign in again",
          operationKey: "cancel-login",
        }),
      );
      const pendingPicker = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: waitingLogin.requestId },
        owner,
      );
      expect(pendingPicker.stage).toBe("approval");
      expect(witnessed).toEqual([true, true, true]);
      const tab = await host.store.database
        .selectFrom("personalTabs")
        .select("pageBinding")
        .where("id", "=", tabId)
        .executeTakeFirstOrThrow();
      if (!tab.pageBinding) throw new Error("Missing Browser Session");
      const staleRef = {
        method: "Opensteer.fillLogin",
        parameters: { loginRef: ready.loginRef, field: "password" },
      };
      const staleCard = {
        method: "Opensteer.fillCard",
        parameters: { cardRef, field: "number" },
      };
      const bind = {
        ownerId: host.ownerId,
        agentBindingId: "session:" + login.row.originatingAgentSessionId,
        sessionId: tab.pageBinding.sessionId,
        scriptTabId: tabId,
        scriptThreadId: taskId,
      };
      const attachment = await host.runtime.browser.attachCdpForAgent(bind, () => undefined);
      close.push(async () => attachment.close());
      const lastFill = browser
        .receivedCommands()
        .findLast(
          (entry) =>
            z.object({ method: z.literal("Opensteer.fillLogin") }).safeParse(entry.command).success,
        );
      const {
        command: { sessionId },
      } = z.object({ command: z.object({ sessionId: z.string() }) }).parse(lastFill);
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "connection.revoke",
          connectionId: agent.id,
          idempotencyKey: "disconnect",
        },
        owner,
      );
      expect(await refusedOrDisconnected(stillWaiting.result)).toBe(true);
      expect((await host.store.requests.get(stillWaiting.requestId))?.status).toBe("cancelled");
      expect((await host.store.requests.get(waitingLogin.requestId))?.status).toBe("cancelled");
      await expect(refusedOrDisconnected(waitingLogin.result)).resolves.toBe(true);
      const approvals = authority.commands.filter(({ type }) => type === "login.approve").length;
      expect(
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "browser.password-sign-in.respond",
            requestId: waitingLogin.requestId,
            expectedRevision: waitingLogin.expectedRevision,
            idempotencyKey: "late-login",
            decision: {
              kind: "approve",
              loginId: choice.id,
              revision: choice.revision,
              remember: false,
              permissionVersion: 6,
            },
          },
          owner,
        ),
      ).toMatchObject({ status: "cancelled" });
      expect(authority.commands.filter(({ type }) => type === "login.approve")).toHaveLength(
        approvals,
      );
      const forwardedBefore = browser.receivedCommands().length;
      for (const command of [staleRef, staleCard])
        expect(
          await attachment.request({ ...command, sessionId }).catch(() => ({ status: "expired" })),
        ).toEqual({ status: "expired" });
      expect(
        browser
          .receivedCommands()
          .slice(forwardedBefore)
          .filter(
            (entry) =>
              z
                .object({ method: z.enum(["Opensteer.fillLogin", "Opensteer.fillCard"]) })
                .safeParse(entry.command).success,
          ),
      ).toHaveLength(0);

      const traffic = JSON.stringify(transcript);
      for (const value of [
        passwordFixture.username,
        passwordFixture.password,
        passwordFixture.code,
      ])
        expect(traffic).not.toContain(value);
    } finally {
      await fixture.dispose();
    }
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "reviews approval-required browser actions, rejects a stale tab close, cancels on stop/narrow/expire, and records a lost open reply as unknown",
  async () => {
    const fixture = await startSessionPersonFixture();
    const {
      site,
      host,
      authority,
      browser,
      profile,
      endpoint,
      connection,
      connectAgent,
      refusedOrDisconnected,
      owner,
      pending,
      transcript,
      setLoseOpenReply,
    } = fixture;
    try {
      const workGrant = {
        scope: "selected" as const,
        tasks: false,
        resources: [{ kind: "browser-profile" as const, profileId: profile.id }],
      };
      const supervised = await connection.create({
        userId: host.ownerId,
        label: "Approval fixture",
        clientName: "Approval fixture",
        resource: endpoint.href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        accessMode: "approval-required",
        grant: workGrant,
      });
      const reviewedToken = connectionCredentialPrefix + randomBytes(32).toString("base64url");
      expect(await connection.activate(supervised.id, credentialHash(reviewedToken))).toBe(true);
      const reviewedCall = await connectAgent(reviewedToken);
      const openScript = `const page = await newPage(${JSON.stringify(site.origin)}); print(page.tabId);\n/* `;
      const reviewedOpen = {
        profileId: profile.id,
        code: openScript.padEnd(requestOperationCallsMaxLength - 2, "x") + "*/",
        operationKey: "reviewed-open",
      };
      const allowOnce = (
        request: { requestId: Request["id"]; expectedRevision: string },
        idempotencyKey: string,
      ) =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "request.respond",
            requestId: request.requestId,
            expectedRevision: request.expectedRevision,
            idempotencyKey,
            response: { kind: "form", answers: { decision: ["allow"] } },
          },
          owner,
        );
      const beforeOpen = browser.receivedCommands().length;
      const queuedOpen = await pending(
        "person.question",
        () => reviewedCall("browser_use", reviewedOpen),
        null,
      );
      expect(browser.receivedCommands()).toHaveLength(beforeOpen);
      expect(reviewedOpen.code).toHaveLength(requestOperationCallsMaxLength);
      const presentation = queuedOpen.row.presentation;
      if (presentation.kind !== "form" || !presentation.detail)
        throw new Error("The Request must have plain detail");
      expect(presentation.detail.length).toBeLessThanOrEqual(requestTextMaxLength);
      expect(presentation.detail.endsWith(requestOperationCallsHeading + reviewedOpen.code)).toBe(
        true,
      );
      expect(queuedOpen.row.agentOperation?.calls).toBe(reviewedOpen.code);
      await allowOnce(queuedOpen, "allow-reviewed-open");
      const realOpen = await queuedOpen.result;
      expect(realOpen.structuredContent).toMatchObject({ status: "completed" });
      const reviewedTabId = tabOutput.parse(realOpen.content)[0].text;

      const other = await host.store.createBrowserProfile({
        ownerId: host.ownerId,
        homeRunnerId: browser.runnerId,
        idempotencyKey: "private",
        name: "Private",
      });
      const newAgent = async (label: string) => {
        const grant = {
          scope: "selected" as const,
          tasks: true,
          resources: [{ kind: "browser-profile" as const, profileId: other.id }],
        };
        const entry = await connection.create({
          userId: host.ownerId,
          label,
          clientName: label,
          resource: endpoint.href,
          expiresAt: new Date(Date.now() + 60 * 60_000),
          accessMode: "approval-required",
          grant,
        });
        const bearer = connectionCredentialPrefix + randomBytes(32).toString("base64url");
        expect(await connection.activate(entry.id, credentialHash(bearer))).toBe(true);
        return { entry, call: await connectAgent(bearer) };
      };
      const restricted = await newAgent("Other agent");
      const authorityCalls = authority.commands.length;
      const requestLogin = (target: string, operationKey: string) =>
        restricted.call("saved_login_request", {
          tabId: target,
          site: site.origin,
          reason: "Continue",
          operationKey,
        });
      const unshared = await requestLogin(reviewedTabId, "unshared");
      const missing = await requestLogin("does-not-exist", "missing");
      expect(unshared.isError).toBe(true);
      expect(unshared.content).toEqual(missing.content);
      expect(authority.commands).toHaveLength(authorityCalls);

      const reviewedClose = (operationKey: string) =>
        pending(
          "person.question",
          () =>
            reviewedCall("browser_use", {
              tabId: reviewedTabId,
              operationKey,
              code: `const page = await openPage(${JSON.stringify(reviewedTabId)}); await page.close();`,
            }),
          null,
        );
      const queuedClose = await reviewedClose("reviewed-close");
      const closeOperation = AgentOperationIdSchema.parse(
        queuedClose.row.agentOperation?.operationId,
      );
      const admittedClose = await host.store.database
        .selectFrom("agentOperations")
        .select("targetGeneration")
        .where("id", "=", closeOperation)
        .executeTakeFirstOrThrow();
      const oldTab = await host.store.database
        .selectFrom("personalTabs")
        .select("generation")
        .where("id", "=", reviewedTabId)
        .executeTakeFirstOrThrow();
      expect(admittedClose.targetGeneration).toBe(String(oldTab.generation));
      const ownerActor = { kind: "person" as const, ownerId: host.ownerId };
      const connectionTab = host.runtime.tabs.connectionTab.bind(host.runtime.tabs);
      const race = vi
        .spyOn(host.runtime.tabs, "connectionTab")
        .mockImplementationOnce(async (...args) => {
          expect(
            (await host.runtime.tabs.close(ownerActor, [reviewedTabId], "person-close")).closed,
          ).toEqual([reviewedTabId]);
          await host.runtime.tabs.reopen(ownerActor, reviewedTabId, "person-reopen");
          return connectionTab(...args);
        });
      await allowOnce(queuedClose, "allow-reviewed-close");
      const closeResult = await queuedClose.result.finally(() => race.mockRestore());
      expect(closeResult.structuredContent).not.toMatchObject({ status: "completed" });
      const settledClose = await host.store.database
        .selectFrom("agentOperations")
        .select("state")
        .where("id", "=", closeOperation)
        .executeTakeFirstOrThrow();
      expect(settledClose.state).toBe("failed");
      const replacement = await host.store.database
        .selectFrom("personalTabs")
        .select(["closedAt", "generation"])
        .where("id", "=", reviewedTabId)
        .executeTakeFirstOrThrow();
      expect(replacement.closedAt).toBeNull();
      expect(replacement.generation).not.toBe(oldTab.generation);
      const beforeFreshClose = browser.receivedCommands().length;
      const freshClose = await reviewedClose("reviewed-close-new-generation");
      await allowOnce(freshClose, "allow-close-new-generation");
      const closed = await freshClose.result;
      expect(closed.structuredContent).toMatchObject({ status: "completed" });
      expect(closed.isError).not.toBe(true);
      expect(browser.receivedCommands().slice(beforeFreshClose)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: expect.objectContaining({ method: "Target.closeTarget" }),
          }),
        ]),
      );

      for (const action of ["stop", "narrow", "expire"] as const) {
        const agent = await newAgent(action);
        const open = await pending(
          "person.question",
          () =>
            agent.call("ask_person", {
              title: "Finish sign-in",
              questions: [{ question: "Did you finish?" }],
              operationKey: "ask",
            }),
          null,
        );
        if (action === "stop") {
          expect(
            await testRpcData(
              host.origin,
              "commands.dispatch",
              {
                type: "agent.session.stop",
                threadId: open.row.originatingThreadId,
                agentSessionId: open.row.originatingAgentSessionId!,
                idempotencyKey: action,
              },
              owner,
            ),
          ).toMatchObject({ ended: true });
        } else if (action === "narrow") {
          const current = (await connection.list(host.ownerId)).find(
            ({ id }) => id === agent.entry.id,
          );
          if (current?.grantRevision === undefined)
            throw new Error("The connection has no grant revision.");
          await testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "connection.update",
              connectionId: agent.entry.id,
              expectedRevision: current.grantRevision,
              grant: { scope: "selected", tasks: true, resources: [] },
              idempotencyKey: action,
            },
            owner,
          );
        } else {
          await host.store.database
            .updateTable("agentConnections")
            .set({ expiresAt: new Date(1) })
            .where("id", "=", agent.entry.id)
            .execute();
          const result = await host.store.driveConnectionCleanups();
          expect(result.failures).toEqual([]);
        }
        expect(
          action === "stop"
            ? (await open.result).isError
            : await refusedOrDisconnected(open.result),
          action,
        ).toBe(true);
        expect((await host.store.requests.get(open.requestId))?.status).toBe("cancelled");
        await expect(
          testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "request.respond",
              requestId: open.requestId,
              expectedRevision: open.expectedRevision,
              idempotencyKey: "late-" + action,
              response: { kind: "form", answers: { question_1: ["Done"] } },
            },
            owner,
          ),
        ).rejects.toThrow();
      }

      const lostAgent = await connection.create({
        userId: host.ownerId,
        label: "Lost reply fixture",
        clientName: "Lost reply fixture",
        resource: endpoint.href,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        accessMode: "full-access",
        grant: workGrant,
      });
      const lostToken = connectionCredentialPrefix + randomBytes(32).toString("base64url");
      if (!(await connection.activate(lostAgent.id, credentialHash(lostToken))))
        throw new Error("Failed to activate lost-reply connection");
      const lostCall = await connectAgent(lostToken);

      // A7: a command the page ran, whose reply the browser cannot return (deeper than the reply
      // may be): the agent is told its outcome is unknown, and the row says so; it happened.
      const ranUrl = `${site.origin}/?reply-limit`;
      const tooDeep = await lostCall("browser_use", {
        profileId: profile.id,
        code: `const page = await newPage(${JSON.stringify(ranUrl)});
          await page.cdp("Runtime.evaluate", {
            expression: "document.title = 'ran'; let o = {}; for (let i = 0; i < 40; i++) o = { o }; o",
            returnByValue: true,
          });`,
        operationKey: "reply-limit-after-effect",
      });
      const uncertain = z
        .object({ operationId: AgentOperationIdSchema })
        .passthrough()
        .parse(tooDeep.structuredContent);
      expect(uncertain).toMatchObject({ status: "unknown", operationId: expect.any(String) });
      const uncertainRow = await host.store.database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .where("id", "=", AgentOperationIdSchema.parse(uncertain.operationId))
        .executeTakeFirstOrThrow();
      expect(uncertainRow).toEqual({ state: "unknown", outcome: "unknown" });
      const seen = await lostCall("browser_use", {
        profileId: profile.id,
        code: `const tab = (await pages()).find((entry) => entry.url === ${JSON.stringify(ranUrl)});
          return tab ? await (await openPage(tab.tabId)).title() : null;`,
        operationKey: "reply-limit-effect-seen",
      });
      expect(JSON.stringify(seen.content)).toContain("ran");

      const loseOpenReply = { url: `${site.origin}/?drop-open-reply`, observed: false };
      setLoseOpenReply(loseOpenReply);
      const lost = await lostCall("browser_use", {
        profileId: profile.id,
        code: `await newPage(${JSON.stringify(loseOpenReply.url)});`,
        operationKey: "lost-browser-open-reply",
      });
      const unknown = z
        .object({ operationId: AgentOperationIdSchema })
        .passthrough()
        .parse(lost.structuredContent);
      expect(loseOpenReply.observed).toBe(true);
      expect(unknown).toMatchObject({
        status: "unknown",
        taskId: expect.any(String),
        operationId: expect.any(String),
      });
      const lostRow = await host.store.database
        .selectFrom("agentOperations")
        .select("state")
        .where("id", "=", AgentOperationIdSchema.parse(unknown.operationId))
        .executeTakeFirstOrThrow();
      expect(lostRow.state).toBe("unknown");

      const traffic = JSON.stringify(transcript);
      for (const value of [
        passwordFixture.username,
        passwordFixture.password,
        passwordFixture.code,
      ])
        expect(traffic).not.toContain(value);
    } finally {
      await fixture.dispose();
    }
  },
);

async function signInFixture() {
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        const valid =
          body.get("username") === passwordFixture.username &&
          body.get("password") === passwordFixture.password;
        response.end(valid ? "<h1>Signed in</h1>" : "<h1>Wrong login</h1>");
        return;
      }
      response.end(`<h1>Sign in</h1><form method="post">
        <label>Email <input name="username" type="email"></label>
        <label>Password <input name="password" type="password"></label>
        <button>Sign in</button></form>`);
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://passwords-fixture.test:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
