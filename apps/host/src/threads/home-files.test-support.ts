import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { OpensteerError, type RunnerId } from "@opensteer/core";
import { RunnerConnectionFenceSchema, type RunnerHomeFileResult } from "@opensteer/protocol";
import { HomeFilesError, HomeFilesHandler } from "@opensteer/runner";
import { RunFileRelay } from "../agents/run-file-relay.js";
import type { HomeFilesTransport } from "./rooted-file-reader.js";

export const defaultNativeFsHelperBinary = fileURLToPath(
  new URL("../../../runner/native-fs-helper/opensteer-native-fs", import.meta.url),
);

export const testNativeFsHelperBinary = fileURLToPath(
  new URL("../../../runner/native-fs-helper/opensteer-native-fs-test", import.meta.url),
);

export function createInProcessHomeFilesTransport(options: {
  readonly agentHomePath: string;
  readonly runnerId: RunnerId;
  readonly dataDirectory?: string;
  readonly homeDirectory?: string;
  readonly helperBinary?: string;
  readonly online?: () => boolean;
  readonly supported?: () => boolean;
}): {
  readonly handler: HomeFilesHandler;
  readonly relay: RunFileRelay;
  readonly transport: HomeFilesTransport;
} {
  const relay = new RunFileRelay();
  const fence = RunnerConnectionFenceSchema.parse({
    bootId: `rbt_${randomUUID()}`,
    connectionGeneration: 1,
    connectionId: `rcn_${randomUUID()}`,
    connectionLeaseId: `rls_${randomUUID()}`,
    runnerId: options.runnerId,
  });
  const handler = new HomeFilesHandler({
    agentHomePath: options.agentHomePath,
    dataDirectory: options.dataDirectory ?? options.agentHomePath,
    helperBinary: options.helperBinary ?? defaultNativeFsHelperBinary,
    ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
    transfers: {
      async upload(transfer, file, signal) {
        signal.throwIfAborted();
        await relay.upload(transfer.id, transfer.token, {
          name: file.name,
          sizeBytes: file.size,
          stream: Readable.from(file.body),
        });
      },
      async download(transfer, maxBytes, signal) {
        const incoming = await relay.download(transfer.id, transfer.token, signal);
        try {
          if (incoming.sizeBytes > maxBytes) {
            throw new HomeFilesError("file_too_large", "Transfer exceeds limit");
          }
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of incoming.stream) {
            signal.throwIfAborted();
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += bytes.byteLength;
            if (total > maxBytes) {
              throw new HomeFilesError("file_too_large", "Transfer exceeds limit");
            }
            chunks.push(bytes);
          }
          incoming.settled();
          return Buffer.concat(chunks, total);
        } catch (error) {
          incoming.settled(error instanceof Error ? error : new Error("Transfer failed"));
          incoming.stream.destroy();
          throw error;
        }
      },
    },
  });
  const transport: HomeFilesTransport = {
    relay,
    async requestHomeFile(runnerId, request, signal): Promise<RunnerHomeFileResult> {
      signal.throwIfAborted();
      if (runnerId !== options.runnerId || options.online?.() === false) {
        throw new OpensteerError({
          code: "runner_offline",
          message: "The hosting computer is offline",
        });
      }
      if (options.supported?.() === false) {
        throw new OpensteerError({
          code: "conflict",
          reason: "unsupported-runner",
          message: "Update the hosting computer to access Agent home files",
        });
      }
      const requestId = randomUUID();
      try {
        const data = await handler.handle({ ...fence, ...request, requestId }, signal);
        return { ...fence, data, ok: true, requestId, type: "runner.home-files.result" };
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof HomeFilesError) {
          return {
            ...fence,
            errorCode: error.code,
            message: error.message.slice(0, 500),
            ok: false,
            requestId,
            ...(error.sizeBytes !== undefined ? { sizeBytes: error.sizeBytes } : {}),
            type: "runner.home-files.result",
          };
        }
        throw error;
      }
    },
  };
  return { handler, relay, transport };
}
