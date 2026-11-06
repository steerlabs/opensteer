import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  runnerIntegrationsProtocolVersion,
  type HostRunFileRequest,
  type HostToRunnerMessage,
} from "@opensteer/protocol";
import { ComputerAppError, RunFiles, type ComputerAppProvider } from "@opensteer/runner";
import type WebSocket from "ws";
import { startHeldRequest } from "../integrations/held-request.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  operation,
  requestComputerAppSetup,
  setComputerApp,
} from "./computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  resetMachineAccessDatabase,
  startMachineAccessHost,
} from "./machine-access.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
// Needs the PostgreSQL that `pnpm test:integration` provides.
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";
const photo = Buffer.from("the exact bytes of a photo");

function messagesProvider(received: Buffer[]): ComputerAppProvider {
  return {
    definitionId: "apple-messages",
    async inspect() {
      return ["query_messages", "export_attachment", "send_message"].map((name) => ({
        detail: null,
        operation: name,
        remedy: null,
        state: "ready" as const,
      }));
    },
    async invoke(name, args, _signal, invocation) {
      const directory = invocation.scratchDirectory;
      if (!directory) throw new Error("The Runner gave this call no scratch directory");
      if (name === "export_attachment") {
        await writeFile(join(directory, "IMG_1.HEIC"), photo);
        return {
          file: "IMG_1.HEIC",
          mediaType: "image/heic",
          name: "IMG_1.HEIC",
          sizeBytes: photo.byteLength,
        };
      }
      const [file] = args.files as readonly string[];
      received.push(await readFile(join(directory, file!)));
      if ((args.to as { conversationId?: string }).conversationId === "uncertain")
        throw new ComputerAppError("outcome-unknown", "Messages did not confirm the send.");
      return { accepted: true };
    },
    platforms: ["darwin"],
  };
}

integration("files between a Run and an app on another computer", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);
  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));

  let closers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of closers) await close().catch(() => undefined);
    closers = [];
  }, 60_000);

  async function connected(appFiles: boolean) {
    const host = await startMachineAccessHost(databaseUrl, { signupPolicy: "open" });
    closers.unshift(() => host.close());
    const root = await mkdtemp(join(tmpdir(), "computer-app-files-"));
    closers.push(() => rm(root, { force: true, recursive: true }));
    const runFiles = (name: string) =>
      new RunFiles({
        dataDirectory: join(root, name),
        helperBinary: process.execPath,
        transport: { hostOrigin: new URL(host.origin), mode: "development" },
      });
    const caller = await connectCallerMachine(host, {
      name: "Caller",
      runFiles: true,
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "computer-app-files-caller",
        name: "Caller",
      }),
    });
    closers.unshift(() => caller.close());
    const sent: Buffer[] = [];
    const computer = await connectComputerAppMachine(host, messagesProvider(sent), {
      desktop: { files: runFiles("source") },
      integrations: {
        ...(appFiles ? { appFiles: 1 } : {}),
        platform: "darwin",
        protocolVersion: runnerIntegrationsProtocolVersion,
      },
    });
    closers.unshift(() => computer.close());
    const setup = await requestComputerAppSetup(host, computer.runnerId, "read-write", "files");
    const enabled = await setComputerApp(host, computer, setup, setup.id);
    const run = await dispatchCallerRun(host, caller, { key: "files-run", title: "Use Messages" });
    closers.unshift(() => run.complete());
    const gateway = await integrationGateway(run.integrationTools);
    closers.unshift(() => gateway.close());
    const held = await startHeldRequest(host, run.runId, () =>
      gateway.call("integration_request", {
        access: "read-write",
        integration: "apple-messages",
        reason: "Work with a photo",
      }),
    );
    const [request] = await host.store.requests.listPendingIntegrationAccessRequests(host.ownerId);
    if (!request) throw new Error("The access Request was not created");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "files-access",
        requestId: request.request.id,
        response: {
          kind: "external",
          value: {
            access: "read-write",
            alias: "Messages on Studio Mac",
            connectionId: enabled.connection.id,
            decision: "fulfilled",
            isDefault: true,
          },
        },
        type: "request.respond",
      },
      { headers: host.ownerHeaders },
    );
    await expect(held.result).resolves.toMatchObject({ status: "fulfilled" });
    const search = await gateway.call("integration_search", { query: "Messages" });
    return { caller, gateway, root, search, sent, target: runFiles("target") };
  }

  /** The Execution Runner's half, as host-connection answers it. */
  function answerRunFiles(
    socket: WebSocket,
    fence: object,
    answer: (
      request: HostRunFileRequest,
    ) => Promise<{ readonly paths: readonly string[] } | { readonly message: string }>,
  ) {
    socket.on("message", (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as HostToRunnerMessage;
      if (message.type !== "host.run-file.receive" && message.type !== "host.run-file.send") return;
      void answer(message).then((result) =>
        socket.send(
          JSON.stringify({
            ...fence,
            ...("message" in result
              ? { message: result.message, ok: false }
              : { ok: true, ...result }),
            requestId: message.requestId,
            type: "runner.run-file.result",
          }),
        ),
      );
    });
  }

  it("hands a Run an attachment from another computer, at a path local to it", async () => {
    const { caller, gateway, root, search, target } = await connected(true);
    const signal = new AbortController().signal;
    answerRunFiles(caller.primary.socket, caller.primary.fence, async (request) => {
      if (request.type !== "host.run-file.receive") throw new Error("Expected a receive");
      const file = await target.download(request.transfers[0]!, signal);
      return { paths: [await target.install(file, join(root, "exports"), signal)] };
    });
    const exported = await gateway.call("integration_call", {
      arguments: { attachmentId: "at_1" },
      ...operation(search, "export_attachment").address,
    });
    expect(exported).toMatchObject({
      mediaType: "image/heic",
      name: "IMG_1.HEIC",
      sizeBytes: photo.byteLength,
    });
    const { path } = exported as { readonly path: string };
    expect(path.startsWith(join(root, "exports"))).toBe(true);
    await expect(readFile(path)).resolves.toEqual(photo);
  });

  it("sends a file from a Run through an app on another computer", async () => {
    const { caller, gateway, search, sent, target } = await connected(true);
    const signal = new AbortController().signal;
    answerRunFiles(caller.primary.socket, caller.primary.fence, async (request) => {
      if (request.type !== "host.run-file.send") throw new Error("Expected a send");
      await target.upload(
        request.files[0]!.transfer,
        { body: Readable.from([photo]), name: "chart.png", size: photo.byteLength },
        signal,
      );
      return { paths: [] };
    });
    await expect(
      gateway.call("integration_call", {
        arguments: { files: ["chart.png"], to: { conversationId: "chat-1" } },
        ...operation(search, "send_message").address,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(sent).toEqual([photo]);
  });

  it("never lets a transfer error hide a send that may have happened", async () => {
    const { caller, gateway, search, target } = await connected(true);
    const signal = new AbortController().signal;
    answerRunFiles(caller.primary.socket, caller.primary.fence, async (request) => {
      if (request.type !== "host.run-file.send") throw new Error("Expected a send");
      await target.upload(
        request.files[0]!.transfer,
        { body: Readable.from([photo]), name: "chart.png", size: photo.byteLength },
        signal,
      );
      return { message: "The upload's answer was lost." };
    });
    await expect(
      gateway.call("integration_call", {
        arguments: { files: ["chart.png"], to: { conversationId: "uncertain" } },
        ...operation(search, "send_message").address,
      }),
    ).rejects.toThrow("Check whether it happened before trying again.");
  });

  it("tells the agent to update a computer that cannot move files", async () => {
    const { gateway, search } = await connected(false);
    await expect(
      gateway.call("integration_call", {
        arguments: { attachmentId: "at_1" },
        ...operation(search, "export_attachment").address,
      }),
    ).rejects.toThrow("Update Opensteer on Studio Mac to use Export attachment.");
  });
});
