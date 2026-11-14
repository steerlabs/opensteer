import { isPublicIp, tlsServerName } from "@opensteer/access/host";
import { OpensteerError, TeamOriginSchema } from "@opensteer/core";
import { teamStorageFullMessage, teamStorageFullReason } from "@opensteer/database/team-files";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import { TeamLinkViewSchema, type TeamLinkRedeemSchema } from "@opensteer/protocol";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocket } from "ws";
import type { z } from "zod";
import {
  linkError,
  teamLinkMaxFrameBytes,
  teamLinkRoutes,
} from "../team-link-endpoint/contracts.js";
import { teamLinkVersionError } from "./discovery.js";

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["100.64.0.0", 10],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
privateAddresses.addAddress("::1", "ipv6");
const metadataAddresses = new BlockList();
metadataAddresses.addAddress("100.100.100.200", "ipv4");
metadataAddresses.addAddress("fd00:ec2::254", "ipv6");

export function allowedTeamAddress(address: string, publicOnly = false): boolean {
  const family = isIP(address);
  if (family && metadataAddresses.check(address, family === 4 ? "ipv4" : "ipv6")) return false;
  if (publicOnly) return isPublicIp(address);
  return (
    isPublicIp(address) ||
    (family !== 0 && privateAddresses.check(address, family === 4 ? "ipv4" : "ipv6"))
  );
}

export class TeamLinkNetwork {
  readonly publicOnly: () => Promise<boolean>;
  constructor(publicOnly: () => Promise<boolean> = async () => false) {
    this.publicOnly = publicOnly;
  }
  async #route(origin: string) {
    const url = new URL(TeamOriginSchema.parse(origin));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const publicOnly = await this.publicOnly();
    if (
      !addresses.length ||
      addresses.some((item) => !allowedTeamAddress(item.address, publicOnly))
    )
      throw linkError();
    const address = addresses[0]!;
    return { url, address, hostname };
  }

  async request(
    origin: string,
    path: string,
    input: {
      readonly method?: "GET" | "POST";
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: Readable | string;
      readonly signal: AbortSignal;
    },
  ): Promise<IncomingMessage> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#"))
      throw linkError("bad_request");
    const { url, address, hostname } = await this.#route(origin);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          hostname: address.address,
          family: address.family,
          port: Number(url.port || 443),
          servername: tlsServerName(hostname),
          path,
          method: input.method ?? "GET",
          headers: { ...input.headers, host: url.host, "accept-encoding": "identity" },
          signal: input.signal,
          timeout: 15_000,
        },
        (incoming) => {
          if (incoming.statusCode !== 200) {
            incoming.destroy();
            if (incoming.statusCode === 426) {
              reject(teamLinkVersionError(Number(incoming.headers[teamApiVersionHeader])));
              return;
            }
            if (incoming.statusCode === 507) {
              reject(
                new OpensteerError({
                  code: "resource_exhausted",
                  reason: teamStorageFullReason,
                  message: teamStorageFullMessage,
                }),
              );
              return;
            }
            reject(
              linkError(
                incoming.statusCode === 401
                  ? "unauthorized"
                  : incoming.statusCode === 403
                    ? "forbidden"
                    : "runner_offline",
              ),
            );
            return;
          }
          resolve(incoming);
        },
      );
      outgoing.on("error", () => reject(linkError("runner_offline")));
      outgoing.on("timeout", () => outgoing.destroy(linkError("timeout")));
      if (typeof input.body === "string" || input.body === undefined) outgoing.end(input.body);
      else
        void pipeline(input.body, outgoing).catch(() =>
          outgoing.destroy(linkError("runner_offline")),
        );
    });
  }

  async json(
    origin: string,
    path: string,
    input: { readonly body?: unknown; readonly signal: AbortSignal },
  ) {
    const response = await this.request(origin, path, {
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
      ...(input.body === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(input.body),
            headers: {
              "content-type": "application/json",
              [teamApiVersionHeader]: String(teamApiVersion),
            },
          }),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > teamLinkMaxFrameBytes) {
        response.destroy();
        throw linkError("resource_exhausted");
      }
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw linkError("bad_request");
    }
  }

  discover(origin: string, signal: AbortSignal): Promise<unknown> {
    return this.json(origin, "/.well-known/opensteer", { signal });
  }
  async redeem(origin: string, input: z.infer<typeof TeamLinkRedeemSchema>, signal: AbortSignal) {
    return TeamLinkViewSchema.parse(
      await this.json(origin, teamLinkRoutes.redeem, { body: input, signal }),
    );
  }

  async connect(origin: string, secret: string, signal: AbortSignal): Promise<WebSocket> {
    return this.connectSocket(origin, teamLinkRoutes.socket, signal, {
      authorization: `Bearer ${secret}`,
      [teamApiVersionHeader]: String(teamApiVersion),
    });
  }

  async connectSocket(
    origin: string,
    path: string,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<WebSocket> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#"))
      throw linkError("bad_request");
    const { url, address } = await this.#route(origin);
    const target = new URL(path, url);
    target.protocol = "wss:";
    const socket = new WebSocket(target, {
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: teamLinkMaxFrameBytes,
      headers,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    });
    const stop = () => {
      socket.on("error", () => undefined);
      socket.terminate();
    };
    signal.addEventListener("abort", stop, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", stop));
    return new Promise((resolve, reject) => {
      socket.once("open", () => {
        if (signal.aborted) {
          stop();
          reject(linkError("runner_offline"));
        } else resolve(socket);
      });
      socket.once("error", () => reject(linkError("runner_offline")));
      socket.once("unexpected-response", (_request, response) => {
        response.destroy();
        stop();
        reject(
          response.statusCode === 426
            ? teamLinkVersionError(Number(response.headers[teamApiVersionHeader]))
            : linkError(response.statusCode === 401 ? "unauthorized" : "runner_offline"),
        );
      });
    });
  }
}
