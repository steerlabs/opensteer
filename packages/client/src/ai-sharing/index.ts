import { z } from "zod";
import type { HostSnapshot } from "../host/client.js";

export type AiSharingScope = "content" | "audio";
export const aiSharingDisclosureVersion = 1;
export const genericAiCompany = "the AI services set up on your computer";

const companies = new Map(
  Object.entries({
    codex: "OpenAI",
    openai: "OpenAI",
    "openai-codex": "OpenAI",
    claude: "Anthropic",
    anthropic: "Anthropic",
    grok: "xAI",
    xai: "xAI",
    antigravity: "Google",
    google: "Google",
    vertex: "Google",
    muse: "Meta",
    meta: "Meta",
    cursor: "Cursor",
    bedrock: "Amazon",
    foundry: "Microsoft",
    "github-copilot": "GitHub",
    openrouter: "OpenRouter",
    deepseek: "DeepSeek",
    minimax: "MiniMax",
    mistral: "Mistral AI",
    moonshot: "Moonshot AI",
    qwen: "Alibaba",
    zai: "Z.ai",
  }),
);

export function aiCompanies(snapshot: Pick<HostSnapshot, "harnesses" | "environments">): string[] {
  const result = new Set<string>();
  for (const account of snapshot.harnesses) {
    if (!account.enabled) continue;
    result.add(companies.get(account.sourceId) ?? genericAiCompany);
    const engineCompany = companies.get(account.driverKind);
    if (engineCompany) result.add(engineCompany);
    if (account.endpoint) result.add(genericAiCompany);
    const catalog = snapshot.environments
      .find((environment) => environment.id === account.environmentId)
      ?.harnessCatalogs.find((item) => item.harnessInstanceId === account.id);
    for (const model of catalog?.models ?? [])
      result.add(companies.get(model.providerId) ?? genericAiCompany);
  }
  return [...(result.size ? result : [genericAiCompany])].sort();
}

const RecordSchema = z.strictObject({
  company: z.string().min(1).max(160),
  scope: z.enum(["content", "audio"]),
  version: z.number().int().positive(),
  timestamp: z.iso.datetime(),
});
export type AiSharingRecord = z.infer<typeof RecordSchema>;
export const AiSharingRecordsSchema = z.array(RecordSchema).max(200);

export function missingAiConsent(
  records: readonly AiSharingRecord[],
  companies: readonly string[],
  scope: AiSharingScope,
): string[] {
  return companies.filter(
    (company) =>
      !records.some(
        (record) =>
          record.company === company &&
          record.scope === scope &&
          record.version === aiSharingDisclosureVersion,
      ),
  );
}

export interface AiSharingPrompt {
  readonly companies: readonly string[];
  readonly scope: AiSharingScope;
}

interface AiSharingPorts {
  readonly records: readonly AiSharingRecord[];
  readonly save: (records: readonly AiSharingRecord[]) => void;
  readonly confirm: (prompt: AiSharingPrompt) => Promise<boolean>;
  readonly now: () => string;
}
export class AiSharing {
  #records: readonly AiSharingRecord[];
  #pending: Promise<boolean> | null = null;
  readonly #ports: AiSharingPorts;
  readonly #listeners = new Set<() => void>();
  constructor(ports: AiSharingPorts) {
    this.#ports = ports;
    this.#records = ports.records.filter((record) => record.version === aiSharingDisclosureVersion);
  }
  readonly getSnapshot = () => this.#records;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #save(records: readonly AiSharingRecord[]): void {
    this.#ports.save(records);
    this.#records = records;
    for (const listener of this.#listeners) listener();
  }
  stop(company: string): void {
    this.#save(this.#records.filter((record) => record.company !== company));
  }
  async ensure(scope: AiSharingScope, readCompanies: () => readonly string[]): Promise<boolean> {
    if (this.#pending) {
      if (!(await this.#pending)) return false;
      return this.ensure(scope, readCompanies);
    }
    const currentCompanies = readCompanies();
    const missing = missingAiConsent(this.#records, currentCompanies, scope);
    if (!missing.length) return true;
    const pending = (async () => {
      if (!(await this.#ports.confirm({ companies: currentCompanies, scope }))) return false;
      this.#save([
        ...this.#records.filter(
          (record) => record.scope !== scope || !missing.includes(record.company),
        ),
        ...missing.map((company) => ({
          company,
          scope,
          version: aiSharingDisclosureVersion,
          timestamp: this.#ports.now(),
        })),
      ]);
      return true;
    })();
    this.#pending = pending;
    try {
      if (!(await pending)) return false;
    } finally {
      this.#pending = null;
    }
    return this.ensure(scope, readCompanies);
  }
}
