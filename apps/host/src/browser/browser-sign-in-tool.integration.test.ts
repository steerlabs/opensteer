import { testRpcData } from "../server/test-host-api-request.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  startPrivateMachineHost,
  waitForValue,
} from "../integrations/personal-machine.test-support.js";
import { hostInternalRoutePaths } from "../server/internal-routes.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";
import { passwordsAnywhereJourneys } from "./passwords-anywhere.test-support.js";
import { passwordFixture, startPasswordsAuthority } from "./passwords-authority.test-support.js";
import { PasswordsJourneyEvidence } from "./passwords-evidence.test-support.js";

passwordsAnywhereJourneys();

const command =
  "pnpm test:integration apps/host/src/browser/browser-sign-in-tool.integration.test.ts apps/host/src/browser/browser-source-service.integration.test.ts";
const cases = [
  "sessionless-before-browser",
  "sessionful-sign-in",
  "personal-reuse",
  "same-owner-task-reuse",
  "browser-close-keeps-lease",
  "revocation",
];

describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "agent login authorization across authority and browser streams",
  () => {
    let finish: () => Promise<void> = async () => {};
    afterEach(async () => {
      const cleanup = finish;
      finish = async () => {};
      await cleanup();
    });
    it("keeps sessionful use_saved_login and origin-fill admission while the personal lease outlives a browser", async () => {
      const evidence = new PasswordsJourneyEvidence("host/browser-reuse", command, cases, [
        passwordFixture.password,
      ]);
      const cleanups: (() => Promise<unknown>)[] = [];
      let traffic: unknown = [];
      finish = async () => {
        const teardown: unknown[] = [];
        for (const close of cleanups.reverse()) {
          try {
            await close();
            teardown.push({ stopped: true });
          } catch (error) {
            teardown.push({ stopped: false, message: String(error) });
          }
        }
        await evidence.write("platform-traffic.json", traffic);
        await evidence.write("teardown.json", teardown);
        await evidence.finish();
        expect(
          teardown.every(
            (entry) => z.object({ stopped: z.literal(true) }).safeParse(entry).success,
          ),
        ).toBe(true);
      };
      const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
      cleanups.push(() => database.drop());
      const host = await startPrivateMachineHost(database.url);
      cleanups.push(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "Personal vault Mac",
        environmentId: host.ownerEnvironmentId,
        loginFill: true,
        token: host.hostingRunnerEnrollmentToken,
        integrations: { platform: "darwin", protocolVersion: 5, passwordSignIn: 2, cardUse: 1 },
        browser: {
          runtimeId: "browser-runtime-integration",
          wireVersion: 2,
          cdpBoundary: 1,
          sharedControl: 1,
          signIn: { version: 3 },
          cardFill: 1,
        },
      });
      cleanups.push(() => caller.close());
      const authority = await startPasswordsAuthority(host.hostPort, caller.primary);
      cleanups.push(() => authority.close());

      const run = await dispatchCallerRun(host, caller, {
        key: "browser-reuse",
        title: "Login reuse",
      });
      const connect = async (token: string) => {
        const client = new Client({ name: "passwords-browser-reuse", version: "1" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(hostInternalRoutePaths.mcp, host.origin), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }) as unknown as Transport,
        );
        cleanups.push(() => client.close());
        return client;
      };
      const client = await connect(run.toolsToken);
      let loginRef = "";
      await evidence.run("sessionless-before-browser", async () => {
        expect(await host.store.listBrowserSessions(host.ownerId)).toEqual([]);
        const result = await client.callTool({
          name: "use_saved_login",
          arguments: { site: passwordFixture.site, reason: "Sign in to the fixture app" },
        });
        await evidence.write("sessionless-result.json", result);
        loginRef = z
          .object({
            status: z.literal("ready"),
            loginRef: z.string(),
            account: z.literal(passwordFixture.account),
          })
          .parse(result.structuredContent).loginRef;
        expect(
          authority.commands.filter((c) => c.type === "login.authorize" && "loginRef" in c),
        ).toHaveLength(1);
        expect(await host.store.listBrowserSessions(host.ownerId)).toEqual([]);
      });
      const runtime = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
        primary: caller.primary,
        agentReady: true,
        signIn: true,
        targetedStreaming: true,
      });
      cleanups.push(() => runtime.close());
      await waitForValue(async () => (host.runtime.browser.available ? true : undefined));
      const open = async () => {
        const result = await client.callTool({
          name: "browser_session_open",
          arguments: { fresh: true },
        });
        expect(result.isError).not.toBe(true);
        return z
          .object({ session: z.object({ id: BrowserSessionIdSchema }) })
          .parse(result.structuredContent).session.id;
      };
      const sessionId = await open();
      await evidence.run("sessionful-sign-in", async () => {
        const result = await client.callTool({
          name: "use_saved_login",
          arguments: { sessionId, site: passwordFixture.site, reason: "Continue in browser" },
        });
        expect(result.structuredContent).toEqual({
          status: "ready",
          site: passwordFixture.site,
          loginRef,
          account: passwordFixture.account,
        });
        expect(
          authority.commands.filter((c) => c.type === "login.authorize" && "loginRef" in c),
        ).toHaveLength(1);
        expect(
          runtime.receivedCommands().filter((c) => c.type === "login.authorize" && "loginRef" in c),
        ).toEqual([]);
      });
      const attach = async (binding: typeof run, browserSessionId = sessionId) => {
        const connection = await host.runtime.browser.attachCdpForAgent(
          {
            agentBindingId: `run:${binding.runId}`,
            ownerId: host.ownerId,
            sessionId: browserSessionId,
          },
          () => undefined,
        );
        cleanups.push(async () => connection.close());
        return connection;
      };
      const fill = {
        method: "Opensteer.fillLogin",
        sessionId: "page-cdp",
        parameters: { loginRef, field: "password" },
      };
      const connection = await attach(run);
      const fulfillFill = async (
        connection: Awaited<ReturnType<typeof attach>>,
        browserSessionId = sessionId,
      ) => {
        const count = runtime.receivedCommands().length;
        const pending = connection.request(fill);
        void pending.catch(() => undefined);
        const forwarded = await waitForValue(async () =>
          runtime
            .receivedCommands()
            .slice(count)
            .find(
              (m) =>
                m.type === "cdp.command" &&
                (m.command as { method: string }).method === fill.method,
            ),
        );
        runtime.sendServer(
          { type: "cdp.result", requestId: forwarded.requestId, result: { status: "filled" } },
          browserSessionId,
        );
        expect(await pending).toEqual({ status: "filled" });
      };
      await evidence.run("personal-reuse", async () => {
        await fulfillFill(connection);
      });
      const cardResult = client.callTool({
        name: "use_card",
        arguments: { site: passwordFixture.site, sessionId, reason: "Fill the approved purchase" },
      });
      void cardResult.catch(() => undefined);
      const cardPending = await vi.waitFor(
        async () => {
          const rows = await host.store.requests.listPendingPasswordSignIns({
            after: null,
            limit: 64,
          });
          expect(rows, "use_card did not open its Request").toHaveLength(1);
          return { requestId: rows[0]!.id };
        },
        { timeout: 10_000 },
      );
      const chooser = await testRpcData(
        host.origin,
        "browser.password-sign-in.get",
        { requestId: cardPending.requestId },
        { headers: host.ownerHeaders },
      );
      expect(chooser.stage).toBe("card-approval");
      if (chooser.stage !== "card-approval") throw new Error("Missing card chooser");
      const choice = chooser.cards[0]!;
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "browser.password-sign-in.respond",
          idempotencyKey: "card-approve",
          requestId: cardPending.requestId,
          decision: {
            kind: "approve-card",
            cardId: choice.id,
            revision: choice.revision,
            permissionVersion: 7,
          },
        },
        { headers: host.ownerHeaders },
      );
      const approved = await cardResult;
      expect(approved.structuredContent).toMatchObject({
        status: "ready",
        brand: "Visa",
        lastFour: "4242",
      });
      const reused = await client.callTool({
        name: "use_card",
        arguments: { site: passwordFixture.site, sessionId, reason: "Continue approved purchase" },
      });
      const cardReady = z
        .object({
          status: z.literal("ready"),
          cardRef: z.string(),
          brand: z.literal("Visa"),
          lastFour: z.literal("4242"),
        })
        .parse(reused.structuredContent);
      expect(approved.structuredContent).toMatchObject(cardReady);
      const cardFill = {
        method: "Opensteer.fillCard",
        sessionId: "page-cdp",
        parameters: { cardRef: cardReady.cardRef, field: "number" },
      };
      const beforeCardFill = runtime.receivedCommands().length;
      const pendingCardFill = connection.request(cardFill);
      const forwardedCardFill = await waitForValue(async () =>
        runtime
          .receivedCommands()
          .slice(beforeCardFill)
          .find(
            (m) =>
              m.type === "cdp.command" &&
              (m.command as { method: string }).method === "Opensteer.fillCard",
          ),
      );
      runtime.sendServer(
        {
          type: "cdp.result",
          requestId: forwardedCardFill.requestId,
          result: { status: "filled" },
        },
        sessionId,
      );
      expect(await pendingCardFill).toEqual({ status: "filled" });
      const durableCard = await host.store.requests.get(
        cardPending.requestId as import("@opensteer/core").RequestId,
      );
      expect(durableCard?.status).toBe("fulfilled");
      expect(JSON.stringify(durableCard)).not.toContain(cardReady.cardRef);
      await evidence.run("same-owner-task-reuse", async () => {
        const other = await dispatchCallerRun(host, caller, {
          key: "foreign",
          title: "Other task",
        });
        const foreignClient = await connect(other.toolsToken);
        const opened = await foreignClient.callTool({
          name: "browser_session_open",
          arguments: { fresh: true },
        });
        const foreignSession = z
          .object({ session: z.object({ id: BrowserSessionIdSchema }) })
          .parse(opened.structuredContent).session.id;
        const foreign = await attach(other, foreignSession);
        await fulfillFill(foreign, foreignSession);
        expect(
          authority.commands.filter((c) => c.type === "login.authorize" && "loginRef" in c),
        ).toHaveLength(1);
      });
      await evidence.run("browser-close-keeps-lease", async () => {
        const secondSession = await open();
        const second = await attach(run, secondSession);
        await host.runtime.browser.closeAgentSession({
          agentBindingId: `run:${run.runId}`,
          ownerId: host.ownerId,
          sessionId,
        });
        expect(await connection.request(fill)).toEqual({ status: "expired" });
        await fulfillFill(second, secondSession);
        const result = await client.callTool({
          name: "use_saved_login",
          arguments: { site: passwordFixture.site, reason: "Return to the phone app" },
        });
        expect(result.structuredContent).toMatchObject({ status: "ready", loginRef });
        expect(
          authority.commands.filter((c) => c.type === "login.authorize" && "loginRef" in c),
        ).toHaveLength(1);
      });
      await evidence.run("revocation", async () => {
        const operation = authority.commands.find((c) => c.type === "login.authorize");
        if (operation?.type !== "login.authorize") throw new Error("Missing authorization");
        await authority.end(operation.operationId);
        const next = await client.callTool({
          name: "use_saved_login",
          arguments: { site: passwordFixture.site, reason: "Reauthorize" },
        });
        const ready = z
          .object({ status: z.literal("ready"), loginRef: z.string() })
          .parse(next.structuredContent);
        expect(ready.loginRef).not.toBe(loginRef);
      });
      expect(authority.protocolErrors).toEqual([]);
      expect(runtime.protocolErrors()).toEqual([]);
      traffic = { authority: authority.commands, browser: runtime.receivedCommands() };
    });
  },
);
