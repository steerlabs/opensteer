import { localNamespace } from "../plugins/provider-names.js";
import { sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  hostApiVersionHeader,
  runFileNameHeader,
  runFileTransferContentType,
  runFileTransferPath,
  runFileTransferProofPayload,
  runnerIntegrationsProtocolVersion,
  type HostRunFileRequest,
  type HostToRunnerMessage,
  type RunFileTransfer,
} from "@opensteer/protocol";
import { ComputerAppError, RunFiles, type ComputerAppProvider } from "@opensteer/runner";
import type WebSocket from "ws";
import { startHeldRequest } from "../mcp/held-request.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectComputerAppMachine,
  integrationGateway,
  pluginCall,
  requestComputerAppSetup,
  setComputerApp,
} from "./computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  resetMachineAccessDatabase,
  startMachineAccessWireHost,
  type PrimaryConnection,
} from "./machine-access-protocol.test-support.js";

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

  async function connected(appFiles: boolean, runFileProof = false) {
    const host = await startMachineAccessWireHost(databaseUrl, {
      remoteAccess: true,
      manualRunner: true,
    });
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
      runFileProof,
      token: host.hostingRunnerEnrollmentToken,
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
      gateway.call("app_access_request", {
        access: "read-write",
        dataApp: "messages",
        reason: "Work with a photo",
      }),
    );
    const [request] = await host.store.integrationRequests.listPendingIntegrationAccessRequests(
      host.ownerId,
    );
    if (!request) throw new Error("The access Request was not created");
    await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: "files-access",
        requestId: request.request.id,
        expectedRevision: (await host.store.requests.revision(request.request.id))!,
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
    const namespace = localNamespace("messages-studio-mac", `app_device_${enabled.connection.id}`);
    return {
      caller,
      gateway,
      origin: host.origin,
      root,
      sent,
      target: runFiles("target"),
      exportAttachment: `tools[${JSON.stringify(namespace)}].export_attachment`,
      sendMessage: `tools[${JSON.stringify(namespace)}].send_message`,
    };
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

  async function redeemWithoutProof(origin: URL, transfer: RunFileTransfer, method: "GET" | "PUT") {
    const response = await fetch(new URL(runFileTransferPath(transfer.id), origin), {
      method,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        authorization: `Bearer ${transfer.token}`,
        ...(method === "PUT"
          ? {
              "content-type": runFileTransferContentType,
              [runFileNameHeader]: "chart.png",
            }
          : {}),
      },
      ...(method === "PUT" ? { body: photo } : {}),
    });
    await response.arrayBuffer();
    return response.status;
  }

  function provingFiles(target: RunFiles, primary: PrimaryConnection, request: HostRunFileRequest) {
    return new RunFiles({
      ...target.options,
      proof: (id, method) =>
        sign(
          null,
          Buffer.from(runFileTransferProofPayload(request, id, method)),
          primary.privateKey,
        ).toString("base64url"),
    });
  }

  const runners = [
    { runner: "a proving Runner", runFileProof: true },
    { runner: "a legacy Runner", runFileProof: false },
  ];

  it.each(runners)(
    "hands an attachment from another computer to $runner",
    async ({ runFileProof }) => {
      const { caller, gateway, origin, root, target, exportAttachment } = await connected(
        true,
        runFileProof,
      );
      const signal = new AbortController().signal;
      let unsignedStatus: number | undefined;
      answerRunFiles(caller.primary.socket, caller.primary.fence, async (request) => {
        if (request.type !== "host.run-file.receive") throw new Error("Expected a receive");
        const [transfer] = request.transfers;
        if (!transfer) throw new Error("Expected a transfer");
        if (runFileProof) {
          unsignedStatus = await redeemWithoutProof(origin, transfer, "GET");
          if (unsignedStatus !== 403) return { message: "The transfer accepted an unsigned GET." };
        }
        const files = runFileProof ? provingFiles(target, caller.primary, request) : target;
        const file = await files.download(transfer, signal);
        return { paths: [await files.install(file, join(root, "exports"), signal)] };
      });
      const exported = (await pluginCall(gateway, exportAttachment, { attachmentId: "at_1" }))
        .value;
      if (runFileProof) expect(unsignedStatus).toBe(403);
      expect(exported).toMatchObject({
        mediaType: "image/heic",
        name: "IMG_1.HEIC",
        sizeBytes: photo.byteLength,
      });
      const { path } = exported as { readonly path: string };
      expect(path.startsWith(join(root, "exports"))).toBe(true);
      await expect(readFile(path)).resolves.toEqual(photo);
    },
  );

  it.each(runners)(
    "sends a file from $runner through an app on another computer",
    async ({ runFileProof }) => {
      const { caller, gateway, origin, sent, target, sendMessage } = await connected(
        true,
        runFileProof,
      );
      const signal = new AbortController().signal;
      let unsignedStatus: number | undefined;
      answerRunFiles(caller.primary.socket, caller.primary.fence, async (request) => {
        if (request.type !== "host.run-file.send") throw new Error("Expected a send");
        const file = request.files[0];
        if (!file) throw new Error("Expected a file");
        if (runFileProof) {
          unsignedStatus = await redeemWithoutProof(origin, file.transfer, "PUT");
          if (unsignedStatus !== 403) return { message: "The transfer accepted an unsigned PUT." };
        }
        const files = runFileProof ? provingFiles(target, caller.primary, request) : target;
        await files.upload(
          file.transfer,
          { body: Readable.from([photo]), name: "chart.png", size: photo.byteLength },
          signal,
        );
        return { paths: [] };
      });
      const result = await pluginCall(gateway, sendMessage, {
        files: ["chart.png"],
        to: { conversationId: "chat-1" },
      });
      if (runFileProof) expect(unsignedStatus).toBe(403);
      expect(result.value).toEqual({ accepted: true });
      expect(sent).toEqual([photo]);
    },
  );

  it("never lets a transfer error hide a send that may have happened", async () => {
    const { caller, gateway, target, sendMessage } = await connected(true);
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
    expect(
      (
        await pluginCall(gateway, sendMessage, {
          files: ["chart.png"],
          to: { conversationId: "uncertain" },
        })
      ).failure,
    ).toContain("Check whether it happened before trying again.");
  });

  it("tells the agent to update a computer that cannot move files", async () => {
    const { gateway, exportAttachment } = await connected(false);
    expect(
      (await pluginCall(gateway, exportAttachment, { attachmentId: "at_1" })).failure,
    ).toContain("Update Opensteer on Studio Mac to use Export attachment.");
  });
});
