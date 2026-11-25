import {
  CloudComputerIdSchema,
  CloudComputerHostnameSchema,
} from "@opensteer/control-plane-protocol";
import { refused } from "@opensteer/core";
import { z } from "zod";
import {
  confirmProviderAcceptance,
  json,
  RemoteRequestError,
  request,
  type HttpOptions,
} from "./http.js";
import type { Addresses, DnsProvider, PublishDnsWrite } from "./provider.js";

const owner = "Opensteer Cloud Computer";
const taggedOwner = owner + ":";
function writeToken(comment: string | null | undefined) {
  if (!comment?.startsWith(taggedOwner)) return;
  const token = z.uuid().safeParse(comment.slice(taggedOwner.length));
  return token.success ? token.data : undefined;
}
function managed(comment: string | null | undefined) {
  return comment === owner || Boolean(writeToken(comment));
}
const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/u),
  name: z.string(),
  type: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  comment: z.string().nullish(),
});

const listResponse = z.object({
  success: z.literal(true),
  result: z.array(recordSchema),
  result_info: z.object({ total_pages: z.number().int().nonnegative().optional() }).optional(),
});
const savedResponse = z.object({ success: z.literal(true), result: recordSchema });
const deletedResponse = z.object({ success: z.literal(true) });
type RecordEntry = z.infer<typeof recordSchema>;

interface CloudflareOptions extends HttpOptions {
  readonly token: string;
  readonly zoneId: string;
  /**
   * The Cloud Computer domain (Account's `OPENSTEER_CLOUD_COMPUTER_DOMAIN`). A zone's token can
   * edit every record in it, and another environment may keep its Cloud Computers in the same
   * zone: only names under this domain are ever listed, written or deleted.
   */
  readonly domain: string;
  readonly baseUrl?: URL;
}

export class CloudflareDns implements DnsProvider {
  readonly #options: CloudflareOptions;
  readonly #records: URL;
  readonly #suffix: string;

  constructor(options: CloudflareOptions) {
    if (!CloudComputerHostnameSchema.safeParse(options.domain).success) {
      throw refused("bad_request", "Invalid Cloud Computer DNS domain");
    }
    this.#options = options;
    this.#suffix = `.${options.domain}`;
    this.#records = new URL(
      `zones/${encodeURIComponent(options.zoneId)}/dns_records`,
      options.baseUrl ?? new URL("https://api.cloudflare.com/client/v4/"),
    );
  }

  async ensureRecords(
    hostname: string,
    addresses: Addresses,
    signal: AbortSignal,
    check?: () => Promise<void>,
    publish?: PublishDnsWrite,
  ): Promise<void> {
    const existing = await this.#list(hostname, signal);
    if (
      existing.some(
        ({ type, comment }) =>
          type === "CNAME" || ((type === "A" || type === "AAAA") && !managed(comment)),
      )
    ) {
      throw refused("conflict", "The Cloud Computer DNS name is already in use");
    }

    for (const [type, content] of [
      ["A", addresses.ipv4],
      ["AAAA", addresses.ipv6],
    ] as const) {
      const matching = existing.filter((record) => record.type === type);
      const current =
        matching.find((record) => sameAddress(type, record.content, content)) ?? matching[0];
      for (const record of matching) {
        if (content === null || record.id !== current?.id) {
          await check?.();
          await this.#delete(record.id, signal);
        }
      }
      if (content === null) continue;
      const body = { type, content, name: hostname, ttl: 1, proxied: false, comment: owner };
      if (!current || current.proxied !== false || !sameAddress(type, current.content, content)) {
        await check?.();
        const url = current ? this.#record(current.id) : this.#records;
        const method = current ? "PATCH" : "POST";
        if (publish) {
          await publish(type, async (token) => {
            await confirmProviderAcceptance(
              this.#request(url, savedResponse, signal, method, {
                ...body,
                comment: taggedOwner + token,
              }),
            );
          });
        } else {
          await this.#request(url, savedResponse, signal, method, body);
        }
      }
    }
  }

  async observeWrites(hostname: string, signal: AbortSignal) {
    return (await this.#list(hostname, signal)).flatMap((entry) => {
      const token = writeToken(entry.comment);
      return token ? [token] : [];
    });
  }

  async removeRecords(
    hostname: string,
    signal: AbortSignal,
    check?: () => Promise<void>,
    observed?: (token: string) => Promise<void>,
  ): Promise<void> {
    for (const record of await this.#list(hostname, signal)) {
      if ((record.type === "A" || record.type === "AAAA") && managed(record.comment)) {
        await check?.();
        const token = writeToken(record.comment);
        if (token) await observed?.(token);
        await this.#delete(record.id, signal);
      }
    }
  }

  /** A name under the domain, on a label boundary: `x.home.example.com`, never `xhome.example.com`. */
  #owns(name: string) {
    return name.length > this.#suffix.length && name.endsWith(this.#suffix);
  }

  async #list(hostname: string, signal: AbortSignal) {
    if (!CloudComputerHostnameSchema.safeParse(hostname).success) {
      throw refused("bad_request", "Invalid Cloud Computer DNS name");
    }
    if (!this.#owns(hostname)) {
      throw refused("bad_request", "The Cloud Computer DNS name is outside its domain");
    }
    return (await this.#lookup({ "name.exact": hostname }, signal)).filter(
      (entry) => entry.name === hostname,
    );
  }

  async listManaged(signal: AbortSignal) {
    const records = await this.#lookup({ "comment.startswith": owner }, signal);
    return records.flatMap((record) => {
      const label = record.name.split(".")[0] ?? "";
      const id = CloudComputerIdSchema.safeParse(label.replace(/^cc-/u, "cc_"));
      return this.#owns(record.name) &&
        managed(record.comment) &&
        (record.type === "A" || record.type === "AAAA") &&
        id.success
        ? [{ id: id.data, hostname: record.name }]
        : [];
    });
  }

  async #lookup(filter: Record<string, string>, signal: AbortSignal) {
    const result: RecordEntry[] = [];
    const url = new URL(this.#records);
    const perPage = 100;
    for (let page = 1; ; page++) {
      url.search = new URLSearchParams({
        ...filter,
        page: String(page),
        per_page: String(perPage),
      }).toString();
      const response = await this.#request(url, listResponse, signal);
      result.push(...response.result);
      if (
        response.result_info?.total_pages !== undefined
          ? page >= response.result_info.total_pages
          : response.result.length < perPage
      )
        return result;
    }
  }

  #record(id: string): URL {
    return new URL(`${this.#records.pathname}/${id}`, this.#records);
  }

  async #delete(id: string, signal: AbortSignal) {
    try {
      await this.#request(this.#record(id), deletedResponse, signal, "DELETE");
    } catch (error) {
      if (!(error instanceof RemoteRequestError) || error.status !== 404) throw error;
    }
  }

  #request<T>(url: URL, schema: z.ZodType<T>, signal: AbortSignal, method = "GET", body?: unknown) {
    return request("Cloudflare", url, this.#options, signal, json(schema), {
      method,
      body,
      headers: { authorization: `Bearer ${this.#options.token}` },
    });
  }
}

function sameAddress(type: "A" | "AAAA", left: string, right: string | null): boolean {
  if (left === right) return true;
  if (type !== "AAAA" || right === null || !z.ipv6().safeParse(left).success) return false;
  return new URL(`http://[${left}]`).hostname === new URL(`http://[${right}]`).hostname;
}
