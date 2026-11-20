import { CloudComputerHostnameSchema } from "@opensteer/control-plane-protocol";
import { refused } from "@opensteer/core";
import { z } from "zod";
import { json, RemoteRequestError, request, type HttpOptions } from "./http.js";
import type { Addresses, DnsProvider } from "./provider.js";

const owner = "Opensteer Cloud Computer";
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
  readonly baseUrl?: URL;
}

export class CloudflareDns implements DnsProvider {
  readonly #options: CloudflareOptions;
  readonly #records: URL;

  constructor(options: CloudflareOptions) {
    this.#options = options;
    this.#records = new URL(
      `zones/${encodeURIComponent(options.zoneId)}/dns_records`,
      options.baseUrl ?? new URL("https://api.cloudflare.com/client/v4/"),
    );
  }

  async ensureRecords(hostname: string, addresses: Addresses, signal: AbortSignal): Promise<void> {
    const existing = await this.#list(hostname, signal);
    if (
      existing.some(
        ({ type, comment }) =>
          type === "CNAME" || ((type === "A" || type === "AAAA") && comment !== owner),
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
        if (content === null || record.id !== current?.id) await this.#delete(record.id, signal);
      }
      if (content === null) continue;
      const body = { type, content, name: hostname, ttl: 1, proxied: false, comment: owner };
      if (!current) {
        await this.#request(this.#records, savedResponse, signal, "POST", body);
      } else if (current.proxied !== false || !sameAddress(type, current.content, content)) {
        await this.#request(this.#record(current.id), savedResponse, signal, "PATCH", body);
      }
    }
  }

  async removeRecords(hostname: string, signal: AbortSignal): Promise<void> {
    for (const record of await this.#list(hostname, signal)) {
      if ((record.type === "A" || record.type === "AAAA") && record.comment === owner) {
        await this.#delete(record.id, signal);
      }
    }
  }

  async #list(hostname: string, signal: AbortSignal) {
    if (!CloudComputerHostnameSchema.safeParse(hostname).success) {
      throw refused("bad_request", "Invalid Cloud Computer DNS name");
    }
    const result: RecordEntry[] = [];
    const url = new URL(this.#records);
    const perPage = 100;
    for (let page = 1; ; page++) {
      url.search = new URLSearchParams({
        "name.exact": hostname,
        page: String(page),
        per_page: String(perPage),
      }).toString();
      const response = await this.#request(url, listResponse, signal);
      result.push(...response.result.filter((entry) => entry.name === hostname));
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
