import { ownChild } from "../agents/owned-child.test-support.js";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { HostConfig } from "@opensteer/config";
import { createDatabase, migrateToLatest } from "@opensteer/database";
import {
  BrowserServerMessageSchema,
  type BrowserServerMessage,
  type BrowserClientMessage,
  decodeBrowserFrameEnvelope,
  hostApiVersionHeader,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { sql } from "kysely";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostRuntime, type HostRuntime } from "../runtime/runtime.js";
import { startPortableFsManagerFake as startPortableFsController } from "../runtime/portablefs-manager.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const accessToken = "browser-access-".padEnd(40, "a");

integration("Host and Chromium editing contract", () => {
  let browserRuntime: Awaited<ReturnType<typeof startBrowserRuntime>> | undefined;
  let dataDirectory: string | undefined;
  let portableFs: Awaited<ReturnType<typeof startPortableFsController>> | undefined;
  let runtime: HostRuntime | undefined;
  const sockets: WebSocket[] = [];
  let engineProcess: ChildProcess | undefined;
  let engineOwner: ReturnType<typeof ownChild> | undefined;
  let fixture: ReturnType<typeof createServer> | undefined;

  beforeEach(async () => {
    const database = createDatabase({ connectionString: databaseUrl ?? "postgres://unconfigured" });
    await migrateToLatest(database);
    await sql`
      truncate table
        credential_access_audit,
        credential_vault_canaries,
        browser_profile_grants,
        browser_sessions,
        browser_profile_revisions,
        browser_profiles,
        credentials,
        workspace_events,
        commands,
        provider_sessions,
        messages,
        runs,
        threads,
        harness_instances,
        workspaces,
        execution_environments,
        runners,
        deployments,
        users
      restart identity cascade
    `.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
    await database.destroy();
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    const failures: unknown[] = [];
    for (const stop of [
      () =>
        engineOwner?.close(() => {
          if (engineProcess?.connected) engineProcess.send("stop");
        }),
      () => browserRuntime?.close(),
      () => runtime?.close(),
      () => portableFs?.close(),
      async () => {
        fixture?.closeAllConnections();
        if (fixture) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
      },
    ]) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Browser editing cleanup failed");
    if (dataDirectory) await rm(dataDirectory, { force: true, recursive: true });
  });

  it("projects old viewers and attributes native clipboard over the real Host route", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-browser-host-integration-"));
    const hostPort = await freePort();
    const config: HostConfig = {
      acceptsExternalRunners: true,
      authSecret: "browser-auth-secret".padEnd(40, "x"),
      bindAddress: "127.0.0.1",
      canonicalOrigin: new URL(`http://127.0.0.1:${hostPort}`),
      browserRuntime: { attachKeyId: "host-integration" },
      browserProfileKeyPath: undefined,
      credentialKeyPath: undefined,
      databaseUrl: databaseUrl ?? "postgres://unconfigured",
      dataDirectory,
      identity: {
        initialOwnerEnrollment: { lifetimeSeconds: 3_600, token: accessToken },
        localPasswordEnabled: true,
        oidcConfigPath: undefined,
        signupPolicy: "invite-only",
      },
      executionLeaseMs: 90_000,
      maxConcurrentDispatches: 2,
      maxConcurrentTriggerDispatches: 2,
      mode: "development",
      port: hostPort,
      exposure: "networked" as const,
      privateKeyPath: undefined,
      publicKeyPath: undefined,
      runtimeOrigin: new URL(`http://127.0.0.1:${hostPort}`),
      workspace: {
        deletionRetentionDays: 14,
        shape: {
          defaultWorkspaceBacking: "portablefs",
          kind: "server" as const,
        },
        storage: {
          archiveAfterDays: 7,
          authorizationDomain: "opensteer-test",
          defaultBlockLimitBytes: 10 * 1_024 * 1_024 * 1_024,
          defaultInodeLimit: 1_000_000,
          filesServiceUrl: new URL("http://127.0.0.1:4315"),
          kind: "portablefs",
          maxBlockLimitBytes: 100 * 1_024 * 1_024 * 1_024,
          maxInodeLimit: 10_000_000,
          managerCaPath: undefined,
          managerCertPath: undefined,
          managerKeyPath: undefined,
          managerServerName: undefined,
          managerUrl: portableFs.url,
          productIssuer: "opensteer-test",
          productPrivateKeyPath: undefined,
          serviceId: "test-portablefs",
        },
      },
    };
    runtime = await createHostRuntime(config);
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    const cookie = await setupInitialOwner(origin, accessToken);
    const sessionHeaders = { cookie, origin };
    // The browser is a module of an enrolled computer: it dials the Host and
    // relays over its own stream, so no Runtime address is ever configured.
    const enrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["browser"],
        idempotencyKey: "browser-relay-computer",
        name: "Relay computer",
        type: "runner.enrollment.createLocal",
      },
      { headers: sessionHeaders },
    );
    if (enrollment.type !== "runner.enrollment.createLocal") {
      throw new Error("Runner enrollment command mismatch.");
    }
    const evidence = join(
      process.env.OPENSTEER_EDITING_HOST_EVIDENCE_DIR ?? "/tmp/opensteer-editing-host",
      `${Date.now()}`,
    );
    await mkdir(evidence, { recursive: true });
    const checks: string[] = [];
    let failure: string | undefined;
    let captureFailure: string | undefined;
    const viewers: {
      query: string;
      state: () => number;
      messages: BrowserServerMessage[];
      frames: Record<string, unknown>[];
      closed?: { code: number; reason: string };
    }[] = [];
    let capture: (() => Promise<void>) | undefined;
    let engineTrace: (() => Promise<unknown>) | undefined;

    try {
      fixture = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<textarea id="t">native copy</textarea><input id="p" type="password"><button id="copyButton">Copy</button><script>window.events=[];for(const type of ["keydown","copy","cut"])document.addEventListener(type,e=>events.push({type,key:e.key}));copyButton.onclick=()=>navigator.clipboard.writeText("page-owned");t.focus();t.select()</script>',
        );
      });
      fixture.listen(0, "127.0.0.1");
      await once(fixture, "listening");
      const fixtureAddress = fixture.address();
      if (!fixtureAddress || typeof fixtureAddress === "string")
        throw new Error("No fixture address");
      engineProcess = fork(
        fileURLToPath(
          new URL(
            "../../../browser-runtime/src/browser/editing-host-engine.test-support.ts",
            import.meta.url,
          ),
        ),
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      engineOwner = ownChild(engineProcess);
      engineProcess.stderr?.on("data", (chunk) => process.stderr.write(chunk));
      const [ready] = await once(engineProcess, "message");
      const engineAddress = z.object({ type: z.literal("ready"), url: z.string() }).parse(ready);
      const cdp = {
        send: async <Result>(
          method: string,
          parameters?: Record<string, unknown>,
        ): Promise<Result> => {
          const requestId = randomUUID();
          const result = new Promise<Result>((resolve, reject) => {
            const receive = (value: unknown) => {
              const reply = z
                .object({
                  requestId: z.uuid(),
                  result: z.unknown().optional(),
                  error: z.string().optional(),
                })
                .safeParse(value);
              if (!reply.success || reply.data.requestId !== requestId) return;
              engineProcess!.off("message", receive);
              if (reply.data.error) reject(new Error(reply.data.error));
              else resolve(reply.data.result as Result);
            };
            engineProcess!.on("message", receive);
          });
          engineProcess!.send({ requestId, method, parameters });
          return result;
        },
      };
      engineTrace = () => cdp.send("Opensteer.testDiagnostics");
      browserRuntime = await startBrowserRuntime(hostPort, enrollment.token, {
        agentReady: true,
        editing: true,
        runtimeUrl: engineAddress.url,
      });
      const workspace = await testRpcData(
        origin,
        "commands.dispatch",
        { type: "workspace.create", idempotencyKey: "editing-workspace", name: "Editing" },
        { headers: sessionHeaders },
      );
      if (workspace.type !== "workspace.create") throw new Error("Wrong workspace result");
      const opened = await testRpcData(
        origin,
        "commands.dispatch",
        {
          type: "browser.session.start",
          workspaceId: workspace.workspace.id,
          idempotencyKey: "editing-session",
          input: {
            fresh: true,
            reuseExisting: false,
            initialUrl: `http://127.0.0.1:${fixtureAddress.port}/`,
          },
        },
        { headers: sessionHeaders },
      );
      if (opened.type !== "browser.session.start") throw new Error("Wrong browser result");
      expect(browserRuntime.lastClaims()).toMatchObject({ editingVersion: 1 });
      const base = `ws://127.0.0.1:${hostPort}/v1/browser-sessions/${opened.session.id}/connect`;
      const connect = async (query: string) => {
        const socket = new WebSocket(base + query, { headers: { cookie, origin } });
        sockets.push(socket);
        const messages: BrowserServerMessage[] = [];
        const frames: Record<string, unknown>[] = [];
        const viewer: (typeof viewers)[number] = {
          query,
          messages,
          frames,
          state: () => socket.readyState,
        };
        viewers.push(viewer);
        socket.on("close", (code, reason) => {
          viewer.closed = { code, reason: reason.toString() };
        });
        socket.on("message", (raw, binary) => {
          if (binary) {
            const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
            const header = decodeBrowserFrameEnvelope(bytes).header;
            frames.push(header);
            if (header.watchToken)
              socket.send(JSON.stringify({ type: "stream.ack", token: header.watchToken }));
          } else messages.push(BrowserServerMessageSchema.parse(JSON.parse(raw.toString())));
        });
        await expect.poll(() => messages.some((m) => m.type === "browser.snapshot")).toBe(true);
        return {
          socket,
          messages,
          frames,
          send: (message: BrowserClientMessage) => socket.send(JSON.stringify(message)),
        };
      };
      const person = await connect("?editing=1"),
        other = await connect("?editing=1"),
        legacy = await connect(""),
        watch = await connect("?mode=watch&editing=1"),
        oldWatch = await connect("?mode=watch");
      let old = legacy;
      expect(person.messages[0]).toMatchObject({ editingVersion: 1 });
      for (const viewer of [old, oldWatch])
        expect(viewer.messages[0]).not.toHaveProperty("editingVersion");
      checks.push("signed ticket and per-control/watch snapshot opt-in");
      const snapshot = person.messages[0];
      if (snapshot?.type !== "browser.snapshot") throw new Error("Missing snapshot");
      capture = async () => {
        const screenshot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
          format: "png",
        });
        await writeFile(
          join(evidence, "host-chromium.png"),
          Buffer.from(screenshot.data, "base64"),
        );
      };
      const surfaceId = snapshot.surfaces[0]!.id;
      const evaluate = async (expression: string) =>
        (
          await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", {
            expression,
            returnByValue: true,
          })
        ).result.value;
      await expect.poll(() => evaluate("!!document.querySelector('#t')")).toBe(true);
      const operationId = randomUUID();
      person.send({ type: "clipboard.copy", surfaceId, operationId, consumerToken: randomUUID() });
      await expect
        .poll(() =>
          person.messages.some(
            (m) => m.type === "clipboard.result" && m.operationId === operationId,
          ),
        )
        .toBe(true);
      expect(
        person.messages.find((m) => m.type === "clipboard.result" && m.operationId === operationId),
      ).toMatchObject({ outcome: "copied" });
      for (const viewer of [other, old, watch, oldWatch])
        expect(viewer.messages.some((m) => m.type.startsWith("clipboard."))).toBe(false);
      checks.push("clipboard result and parts only reach the initiating controller");
      const oldCopies = () => old.messages.filter((m) => m.type === "clipboard.data");
      const legacyStroke = (key: string, code: string, modifiers: ("meta" | "control")[]) => {
        for (const action of ["down", "up"] as const)
          old.send({ type: "input.key", surfaceId, action, key, code, modifiers });
      };
      await evaluate("t.value='legacy copy';t.focus();t.select()");
      legacyStroke("c", "KeyC", ["meta"]);
      await expect.poll(() => oldCopies().length).toBe(1);
      expect(oldCopies()[0]).toMatchObject({ text: "legacy copy" });
      const modernCopy = async (text: string) => {
        await evaluate(`t.value=${JSON.stringify(text)};t.focus();t.select()`);
        const id = randomUUID();
        person.send({ type: "clipboard.copy", surfaceId, operationId: id });
        await expect
          .poll(() =>
            person.messages.some(
              (m) =>
                m.type === "clipboard.result" && m.operationId === id && m.outcome === "copied",
            ),
          )
          .toBe(true);
      };
      await modernCopy("editing copy");
      expect(oldCopies()).toHaveLength(1);
      await evaluate("t.value='legacy cut';t.focus();t.select()");
      const cutsBefore = await evaluate("events.filter(e=>e.type==='cut').length");
      legacyStroke("x", "KeyX", ["control"]);
      await expect.poll(() => oldCopies().length).toBe(2);
      expect(oldCopies()[1]).toMatchObject({ text: "legacy cut" });
      expect(await evaluate("t.value")).toBe("");
      expect(await evaluate("events.filter(e=>e.type==='cut').length")).toBe(
        Number(cutsBefore) + 1,
      );
      expect(
        browserRuntime
          .receivedCommands()
          .filter(
            (m) =>
              m.type === "input.key" &&
              typeof m.code === "string" &&
              ["KeyC", "KeyX"].includes(m.code),
          ),
      ).toHaveLength(0);
      checks.push(
        "editing and baseline controllers copy alternately; baseline cut deletes once and consumes matching keyup",
      );
      await evaluate(
        "t.value='canceled';t.focus();t.select();window.copyCanceled=false;t.addEventListener('keydown',e=>{e.preventDefault();window.copyCanceled=true},{once:true})",
      );
      legacyStroke("c", "KeyC", ["control"]);
      await expect.poll(() => evaluate("copyCanceled")).toBe(true);
      await modernCopy("after canceled copy");
      expect(oldCopies()).toHaveLength(2);
      await evaluate(
        "p.value='sensitive';p.focus();p.select();window.afterSensitive=false;p.addEventListener('keydown',()=>window.afterSensitive=true,{once:true})",
      );
      legacyStroke("c", "KeyC", ["meta"]);
      legacyStroke("Escape", "Escape", []);
      await expect.poll(() => evaluate("afterSensitive")).toBe(true);
      await modernCopy("after sensitive copy");
      expect(oldCopies()).toHaveLength(2);
      for (const viewer of [other, watch, oldWatch])
        expect(viewer.messages.some((m) => m.type.startsWith("clipboard."))).toBe(false);
      checks.push(
        "canceled and sensitive baseline copy project no clipboard data to any other viewer",
      );
      const legacyRefused = once(old.socket, "close");
      old.send({ type: "input.command", surfaceId, command: "selectAll" });
      const [refusalCode, refusalReason] = await legacyRefused;
      expect(refusalCode).toBe(4002);
      expect(String(refusalReason)).toBe("Browser editing was not negotiated.");
      expect(
        browserRuntime.receivedCommands().filter((m) => m.type === "input.command"),
      ).toHaveLength(0);
      checks.push("legacy socket cannot emit editing commands");
      old = await connect("");
      for (const viewer of [person, other, old, watch, oldWatch])
        viewer.send({ type: "stream.subscribe", surfaceId });
      await expect
        .poll(() => [person, other, old, watch, oldWatch].every((v) => v.frames.length > 0))
        .toBe(true);
      checks.push("binary frames on editing and baseline control/watch sockets");
      const point = (await evaluate(
        "(()=>{const r=copyButton.getBoundingClientRect();return{x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight,width:innerWidth,height:innerHeight}})()",
      )) as { x: number; y: number; width: number; height: number };
      const copied = person.messages.find(
        (m) => m.type === "clipboard.result" && m.operationId === operationId,
      )!;
      const forgedToken = "consumerToken" in copied ? copied.consumerToken : randomUUID();
      for (const action of ["down", "up"] as const)
        other.send({
          type: "input.pointer",
          surfaceId,
          action,
          button: "left",
          x: point.x,
          y: point.y,
          viewportWidth: point.width,
          viewportHeight: point.height,
          consumerToken: forgedToken,
        });
      await expect
        .poll(() => other.messages.some((m) => m.type === "clipboard.written"))
        .toBe(true);
      expect(person.messages.some((m) => m.type === "clipboard.written")).toBe(false);
      for (const viewer of [old, watch, oldWatch])
        expect(viewer.messages.some((m) => m.type.startsWith("clipboard."))).toBe(false);
      checks.push("page copy button reaches the acting controller even with a forged input token");
      const oversized = randomUUID();
      person.send({
        type: "clipboard.paste-data",
        surfaceId,
        operationId: oversized,
        items: [{ type: "image/png", size: 16 * 1024 * 1024 + 1 }],
      });
      await expect
        .poll(() =>
          person.messages.some(
            (m) =>
              m.type === "clipboard.result" &&
              m.operationId === oversized &&
              m.outcome === "too-large",
          ),
        )
        .toBe(true);
      expect(person.socket.readyState).toBe(WebSocket.OPEN);
      checks.push("Host refuses >16 MiB without disconnecting");
      await evaluate("t.value='';t.focus()");
      const paste = async (type: string, data: Buffer) => {
        const id = randomUUID();
        person.send({
          type: "clipboard.paste-data",
          surfaceId,
          operationId: id,
          items: [{ type, size: data.length }],
        });
        for (let index = 0; index < Math.ceil(data.length / (512 * 1024)); index++)
          person.send({
            type: "clipboard.part",
            part: {
              operationId: id,
              index,
              data: data.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString("base64"),
            },
          });
        await expect
          .poll(
            () =>
              person.messages.find((m) => m.type === "clipboard.result" && m.operationId === id),
            { timeout: 10000 },
          )
          .toMatchObject({ outcome: "pasted" });
      };
      await paste("text/plain", Buffer.from("字".repeat(400000)));
      expect(await evaluate("t.value.length")).toBe(400000);
      checks.push("400k CJK native paste through Host and Runner relay");
      await evaluate(
        "t.onpaste=e=>{window.filePaste={trusted:e.isTrusted,type:e.clipboardData.files[0]?.type};e.preventDefault()}",
      );
      const png = await evaluate(
        "(()=>{const c=document.createElement('canvas');c.width=1700;c.height=1700;const x=c.getContext('2d'),d=x.createImageData(c.width,c.height);let n=123456789;for(let i=0;i<d.data.length;i++){n^=n<<13;n^=n>>>17;n^=n<<5;d.data[i]=n&255;}x.putImageData(d,0,0);return c.toDataURL('image/png').split(',')[1]})()",
      );
      const imageBytes = Buffer.from(z.string().parse(png), "base64");
      expect(imageBytes.length).toBeGreaterThan(10000000);
      await paste("image/png", imageBytes);
      expect(await evaluate("filePaste")).toMatchObject({ trusted: true, type: "image/png" });
      checks.push("10 MB PNG trusted file paste through Host and Runner relay");
      await evaluate("t.onpaste=null;t.value='';t.focus()");
      person.send({
        type: "input.key",
        surfaceId,
        action: "down",
        key: "Shift",
        code: "ShiftLeft",
        modifiers: ["shift"],
      });
      for (let index = 0; index < 40; index++) {
        const id = randomUUID();
        other.send({
          type: "clipboard.paste-data",
          surfaceId,
          operationId: id,
          items: [{ type: "text/plain", size: 1 }],
        });
        other.send({ type: "clipboard.part", part: { operationId: id, index: 0, data: "eA==" } });
        await expect
          .poll(() =>
            other.messages.filter((m) => m.type === "clipboard.result" && m.operationId === id),
          )
          .toEqual([expect.objectContaining({ outcome: "refused", operationId: id, surfaceId })]);
      }
      person.send({
        type: "input.key",
        surfaceId,
        action: "up",
        key: "Shift",
        code: "ShiftLeft",
        modifiers: [],
      });
      const recovered = randomUUID();
      other.send({
        type: "clipboard.paste-data",
        surfaceId,
        operationId: recovered,
        items: [{ type: "text/plain", size: 1 }],
      });
      other.send({
        type: "clipboard.part",
        part: { operationId: recovered, index: 0, data: "eA==" },
      });
      await expect
        .poll(() =>
          other.messages.filter(
            (m) => m.type === "clipboard.result" && m.operationId === recovered,
          ),
        )
        .toEqual([expect.objectContaining({ outcome: "pasted" })]);
      expect(await evaluate("t.value")).toBe("x");
      checks.push(
        "40 ownership refusals each settle once, and the same socket can paste after release",
      );
      for (const viewer of [old, oldWatch])
        expect(
          viewer.messages.some((m) =>
            [
              "browser.editing",
              "browser.contextmenu",
              "clipboard.result",
              "clipboard.written",
              "clipboard.part",
            ].includes(m.type),
          ),
        ).toBe(false);
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      await writeFile(
        join(evidence, "wire.json"),
        JSON.stringify(
          viewers.map((viewer) => ({ ...viewer, state: viewer.state() })),
          null,
          2,
        ),
      );
      await writeFile(
        join(evidence, "relay.json"),
        JSON.stringify(
          {
            open: browserRuntime?.streamOpen(),
            errors: browserRuntime?.protocolErrors(),
            commands: browserRuntime?.receivedCommands().map((message) => ({
              type: message.type,
              operationId: message.operationId,
              ...(message.type === "clipboard.part"
                ? {
                    part: {
                      index: (message.part as { index: number }).index,
                      bytes: Buffer.from((message.part as { data: string }).data, "base64").length,
                    },
                  }
                : {}),
            })),
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(evidence, "engine.json"),
        JSON.stringify(await engineTrace?.(), null, 2),
      );
      try {
        await capture?.();
      } catch (error) {
        captureFailure = String(error);
      }
      await writeFile(
        join(evidence, "report.json"),
        JSON.stringify(
          { passed: !failure && !captureFailure, failure, captureFailure, checks },
          null,
          2,
        ),
      );
      console.info(`Host editing evidence: ${evidence}`);
    }
    if (captureFailure) throw new Error(captureFailure);
  }, 60_000);
});
async function setupInitialOwner(origin: string, token: string): Promise<string> {
  const exchanged = await fetch(`${origin}/v1/rpc/auth.setup.exchange`, {
    body: JSON.stringify({ token }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      origin,
    },
    method: "POST",
  });
  if (!exchanged.ok) throw new Error(`Setup exchange failed with HTTP ${exchanged.status}.`);
  const admissionCookies = responseCookies(exchanged);
  const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
    body: JSON.stringify({
      email: "browser-owner@example.com",
      kind: "password",
      password: "browser-owner-password",
    }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      cookie: admissionCookies.join("; "),
      origin,
    },
    method: "POST",
  });
  if (!claimed.ok) throw new Error(`Owner claim failed with HTTP ${claimed.status}.`);
  const sessionCookies = responseCookies(claimed);
  if (sessionCookies.length === 0) throw new Error("Host did not issue a session cookie.");
  return sessionCookies.join("; ");
}

function responseCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value));
}
