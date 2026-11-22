/**
 * The agent's two interfaces. The Home's: one signed POST per request on a TCP port, checked
 * against the slot's Home key and term, answered with a reply signed by the slot's control key.
 * The provisioner's: the same shape on a separate listener with its own key.
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  browserPoolAgentAdminBytes,
  browserPoolAgentAdminReplyBytes,
  browserPoolAgentReplyBytes,
  browserPoolAgentRequestBytes,
  browserPoolAgentRequestWindowMs,
  browserPoolAgentSignatureHeader,
  signBrowserPoolAgentBytes,
  verifyBrowserPoolAgentBytes,
  type BrowserPoolAgentAdminEnvelope,
  type BrowserPoolAgentAdminReply,
  type BrowserPoolAgentEnvelope,
  type BrowserPoolAgentRefusal,
  type BrowserPoolAgentReply,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import {
  AgentUnavailable,
  ProfilesNotMounted,
  SlotConflict,
  SlotFenced,
  SlotNotFound,
  type PoolAgent,
} from "./agent.js";

const maximumBodyBytes = 64 * 1024;
export const maximumConnections = 256;

const phase = z.enum(["running", "paused", "stopped"]);
const fence = z.strictObject({
  slot: z.string().min(1).max(256),
  term: z.number().int().positive(),
  instance: z.string().min(1).max(128),
  epoch: z.number().int().positive(),
});
const intent = z.strictObject({
  id: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
});
const call = z.strictObject({
  id: z.string().uuid(),
  slotId: z.string().min(1).max(256),
  term: z.number().int().positive(),
  kind: z.enum(["start", "pause", "resume", "stop", "sign"]),
  expect: z.strictObject({
    instance: z.string().max(128).nullable(),
    epoch: z.number().int().positive().nullable(),
    phase,
    savedStateId: z.string().max(128).nullable(),
  }),
  control: z
    .strictObject({
      kind: z.enum(["install", "retire", "release", "seal", "adopt", "complete"]),
      fence,
      intent: intent.optional(),
      attempt: z.number().int().nonnegative().optional(),
    })
    .optional(),
  intent: intent.optional(),
});
const envelopeSchema = z.strictObject({
  v: z.literal(1),
  slotId: z.string().min(1).max(256),
  term: z.number().int().positive(),
  issuedAt: z.string().datetime(),
  nonce: z.string().min(16).max(64),
  request: z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("status") }),
    z.strictObject({ op: z.literal("result"), id: z.string().uuid() }),
    z.strictObject({ op: z.literal("apply"), call }),
  ]),
});

const spki = z.string().min(40).max(200);
/** An absolute host path with no `.` or `..` part; the driver also confines it by real path. */
const hostFile = z
  .string()
  .regex(/^\/[A-Za-z0-9._/-]{1,255}$/u)
  .refine((value) => !value.split("/").some((part) => part === ".." || part === "."));
const adminSchema = z.strictObject({
  v: z.literal(1),
  host: z.string().min(1).max(128),
  issuedAt: z.string().datetime(),
  nonce: z.string().min(16).max(64),
  request: z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("create"),
      slotId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
      term: z.number().int().positive(),
      homeKey: spki,
      relayKey: spki.optional(),
      ticketKey: z
        .strictObject({ keyId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u), spki })
        .optional(),
      guest: z.strictObject({
        vcpus: z.number().int().min(1).max(32),
        memoryMib: z.number().int().min(256).max(65_536),
        // Round G: the agent makes the profile; the earlier path form must name the same file.
        profileMib: z.number().int().min(64).max(1_048_576).optional(),
        profilePath: hostFile.optional(),
        egress: z
          .strictObject({
            upstreamUrl: z.string().regex(/^https:\/\/[^\s/?#@]+:[0-9]{1,5}$/u),
            usernameFile: hostFile,
            passwordFile: hostFile,
            caFile: hostFile.optional(),
          })
          .optional(),
      }),
    }),
    z.strictObject({
      op: z.literal("replace-key"),
      slotId: z.string().min(1).max(128),
      term: z.number().int().positive(),
      homeKey: spki,
      relayKey: spki.optional(),
      ticketKey: z
        .strictObject({ keyId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u), spki })
        .optional(),
    }),
    z.strictObject({
      op: z.literal("delete"),
      slotId: z.string().min(1).max(128),
      term: z.number().int().positive(),
      eraseProfile: z.boolean().optional(),
    }),
    z.strictObject({ op: z.literal("list") }),
  ]),
});

export interface PoolAgentServerOptions {
  readonly agent: PoolAgent;
  /**
   * The host's private key. It signs the answer that a slot was deleted (re-check finding 4): a
   * deleted slot has no key of its own any more.
   */
  readonly hostKey: KeyObject;
  readonly now?: () => number;
  readonly log?: (event: Readonly<Record<string, unknown>>) => void;
}

/** The Home-facing interface. */
export function createHomeServer(options: PoolAgentServerOptions): Server {
  const now = options.now ?? Date.now;
  return harden(
    createServer((request, response) => {
      void handle(request, response, async (body, signature) => {
        const parsed = envelopeSchema.safeParse(json(body));
        if (!parsed.success)
          return { status: 400, reply: refusal("bad-request", "The request is malformed.") };
        const envelope = parsed.data as BrowserPoolAgentEnvelope;
        // The key, its term and its generation are read together. An unknown slot, another
        // key, or another term all get the same answer: nobody learns which slots exist.
        const authority = options.agent.authority(envelope.slotId);
        const bytes = browserPoolAgentRequestBytes(envelope);
        if (
          !authority ||
          !signature ||
          envelope.term !== authority.term ||
          !verifyBrowserPoolAgentBytes(bytes, authority.key, signature)
        )
          return { status: 401, reply: unauthenticated };
        if (Math.abs(now() - Date.parse(envelope.issuedAt)) > browserPoolAgentRequestWindowMs)
          return {
            status: 400,
            reply: refusal("stale-request", "The request is outside its time window."),
          };
        const controlKey = options.agent.controlKey(envelope.slotId);
        // Its own Home is told, signed by the host key, that a deleted slot is gone: the
        // guest's end is evidence. Every other answer is signed by the slot's control key.
        const reply =
          authority.deleted || !controlKey
            ? refusal("unknown-slot", "The slot was deleted.")
            : await answer(options.agent, envelope, authority.generation);
        const deleted = reply.op === "refused" && reply.code === "unknown-slot";
        return {
          status: 200,
          reply,
          sign: { bytes, key: deleted || !controlKey ? options.hostKey : controlKey },
        };
      });
    }),
  );
}

const unauthenticated = refusal(
  "unauthenticated",
  "The request is not signed by this slot's Home for this term.",
);

async function answer(
  agent: PoolAgent,
  envelope: BrowserPoolAgentEnvelope,
  generation: number,
): Promise<BrowserPoolAgentReply> {
  const request = envelope.request;
  try {
    switch (request.op) {
      case "status":
        return {
          op: "status",
          status: await agent.status(envelope.slotId, envelope.term, generation),
        };
      case "result":
        return {
          op: "result",
          result: await agent.result(envelope.slotId, envelope.term, request.id, generation),
        };
      case "apply":
        if (request.call.slotId !== envelope.slotId || request.call.term !== envelope.term)
          return refusal("bad-request", "The call names another slot or term than its envelope.");
        return { op: "apply", result: await agent.apply(request.call, generation) };
    }
  } catch (error) {
    if (error instanceof SlotNotFound) return refusal("unknown-slot", "The slot was deleted.");
    if (error instanceof SlotFenced) return unauthenticated;
    if (error instanceof AgentUnavailable) return refusal("unavailable", error.message);
    // The step's outcome is settled by the next call for the slot; the caller reads it by id.
    return refusal("unavailable", "The pool agent could not finish the request.");
  }
}

/**
 * The provisioner-facing interface, on its own listener and key. A request names this host
 * (review G2), and every answer is signed by the host key whose public half the provisioner
 * pinned when it enrolled the host.
 */
export function createAdminServer(
  options: PoolAgentServerOptions & {
    readonly provisionerKey: KeyObject;
    readonly hostId: string;
    readonly hostKey: KeyObject;
  },
): Server {
  const now = options.now ?? Date.now;
  return harden(
    createServer((request, response) => {
      void handle(request, response, async (body, signature) => {
        const parsed = adminSchema.safeParse(json(body));
        if (!parsed.success)
          return { status: 400, reply: refusal("bad-request", "The request is malformed.") };
        const envelope = parsed.data as BrowserPoolAgentAdminEnvelope;
        const bytes = browserPoolAgentAdminBytes(envelope);
        if (
          !signature ||
          envelope.host !== options.hostId ||
          !verifyBrowserPoolAgentBytes(bytes, options.provisionerKey, signature)
        )
          return {
            status: 401,
            reply: refusal(
              "unauthenticated",
              "The request is not signed by the provisioner for this host.",
            ),
          };
        if (Math.abs(now() - Date.parse(envelope.issuedAt)) > browserPoolAgentRequestWindowMs)
          return {
            status: 400,
            reply: refusal("stale-request", "The request is outside its time window."),
          };
        return {
          status: 200,
          reply: await administer(options.agent, envelope),
          sign: { bytes, key: options.hostKey, admin: true },
        };
      });
    }),
  );
}

async function administer(
  agent: PoolAgent,
  envelope: BrowserPoolAgentAdminEnvelope,
): Promise<BrowserPoolAgentAdminReply> {
  const request = envelope.request;
  try {
    switch (request.op) {
      case "create":
        return { op: "create", slot: await agent.createSlot(request) };
      case "replace-key":
        return { op: "replace-key", slot: await agent.replaceKey(request) };
      case "delete":
        // Round G: what was seen gone. A removal that fails makes the delete fail instead.
        return {
          op: "delete",
          slotId: request.slotId,
          ...(await agent.deleteSlotWithEvidence(request.slotId, request.term, {
            eraseProfile: request.eraseProfile === true,
          })),
        };
      case "list":
        return { op: "list", slots: agent.summaries() };
    }
  } catch (error) {
    // A definite refusal: nothing was made or erased.
    if (error instanceof SlotConflict)
      return { op: "refused", code: "conflict", message: error.message };
    // The profile disk is not the mount expected: no profile was made or erased. A delete may
    // have ended the guest and its credentials first; a repeated delete finishes it.
    if (error instanceof ProfilesNotMounted)
      return { op: "refused", code: "profile-disk-missing", message: error.message };
    if (error instanceof SlotNotFound)
      return { op: "refused", code: "unknown-slot", message: error.message };
    return {
      op: "refused",
      code: "unavailable",
      message: "The pool agent could not finish the request.",
    };
  }
}

export function parseProvisionerKey(spkiBase64: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The provisioner key must be Ed25519.");
  return key;
}

export async function listen(
  server: Server,
  target: { host: string; port: number } | { path: string },
) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if ("path" in target) server.listen(target.path, resolve);
    else server.listen(target.port, target.host, resolve);
  });
  return server.address() as AddressInfo | string;
}

function harden(server: Server): Server {
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  // A call can take as long as its slowest step (a restore, a cold boot) plus the queue.
  server.timeout = 0;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  // Review G10: a bounded number of connections, whoever opens them.
  server.maxConnections = maximumConnections;
  return server;
}

interface Answer {
  readonly status: number;
  readonly reply: unknown;
  readonly sign?: { readonly bytes: Buffer; readonly key: KeyObject; readonly admin?: boolean };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  work: (body: Buffer, signature: string | undefined) => Promise<Answer>,
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/v1")
      return send(response, { status: 404, reply: refusal("bad-request", "Not found.") });
    const header = request.headers[browserPoolAgentSignatureHeader];
    const body = await readBody(request);
    if (body === undefined)
      return send(response, {
        status: 413,
        reply: refusal("bad-request", "The request is too large."),
      });
    send(response, await work(body, typeof header === "string" ? header : undefined));
  } catch {
    send(response, { status: 500, reply: refusal("unavailable", "The pool agent failed.") });
  }
}

function send(response: ServerResponse, answer: Answer): void {
  if (response.headersSent) return;
  const signature = answer.sign
    ? signBrowserPoolAgentBytes(
        (answer.sign.admin ? browserPoolAgentAdminReplyBytes : browserPoolAgentReplyBytes)(
          answer.sign.bytes,
          answer.reply,
        ),
        answer.sign.key,
      )
    : undefined;
  const text = JSON.stringify({ reply: answer.reply, ...(signature ? { signature } : {}) });
  response.writeHead(answer.status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximumBodyBytes) {
        over = true;
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? undefined : Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

function refusal(code: BrowserPoolAgentRefusal, message: string) {
  return { op: "refused", code, message } as const;
}
