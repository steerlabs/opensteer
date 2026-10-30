import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { journeySteps, passkeyJourneySteps } from "./native-browser-journey-contract.js";
const nativeBrowserCases: Record<string, string> = { ...journeySteps, ...passkeyJourneySteps };
const serialCases = new Set(Object.keys(nativeBrowserCases));

export type NativeCaseId = string;
export type NativeCaseStatus = "PASS" | "FAIL" | "NOT-AUTOMATABLE";
export interface NativeCaseResult {
  id: NativeCaseId;
  title: string;
  status: NativeCaseStatus;
  tags: "serial"[];
  reason?: string;
  measurements?: unknown;
  evidence: string[];
  subcases?: unknown;
}
export class NativeSmokeArtifacts {
  readonly results = new Map<NativeCaseId, NativeCaseResult>();
  readonly trace: { sequence: number; elapsedNs: string; type: string; data: unknown }[] = [];
  readonly #started = process.hrtime.bigint();
  readonly directory: string;
  private deferSuccess: boolean;
  readonly selected: ReadonlySet<NativeCaseId>;
  constructor(
    directory: string,
    selected: ReadonlySet<NativeCaseId> = new Set(
      Object.keys(nativeBrowserCases) as NativeCaseId[],
    ),
    deferSuccess = false,
  ) {
    this.deferSuccess = deferSuccess;
    this.selected = selected;
    this.directory = directory;
    for (const name of ["logs", "cases", "recordings", "frames"])
      mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
  }
  event(type: string, data: unknown): void {
    const row = {
      sequence: this.trace.length + 1,
      elapsedNs: String(process.hrtime.bigint() - this.#started),
      type,
      data,
    };
    this.trace.push(row);
    appendFileSync(path.join(this.directory, "trace.jsonl"), `${JSON.stringify(row)}\n`);
  }
  json(name: string, value: unknown): string {
    const caseResult = /^cases\/([^/]+)\/result\.json$/.exec(name);
    if (
      this.deferSuccess &&
      caseResult &&
      this.results.get(caseResult[1] as NativeCaseId)?.status === "PASS"
    )
      name = name.replace(/result\.json$/, "pending-result.json");
    const file = path.join(this.directory, name);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return file;
  }
  result(
    id: NativeCaseId,
    status: NativeCaseStatus,
    details: Omit<NativeCaseResult, "id" | "title" | "status" | "tags">,
  ): void {
    if (!this.selected.has(id)) return;
    const value: NativeCaseResult = {
      id,
      title: nativeBrowserCases[id] ?? id,
      status,
      tags: serialCases.has(id) ? ["serial"] : [],
      ...details,
    };
    this.results.set(id, value);
    if (this.deferSuccess && status === "PASS") {
      this.json(`cases/${id}/pending-result.json`, value);
      this.event("case.pending", { id, status });
      return;
    }
    this.json(`cases/${id}/result.json`, value);
    this.event("case.result", { id, status, reason: details.reason });
    process.stdout.write(
      `${id} ${status}${details.reason ? ` ${details.reason.split("\n")[0]}` : ""}\n`,
    );
    this.summary();
  }
  finalizeCaseResults(): void {
    this.deferSuccess = false;
    for (const value of this.results.values()) {
      if (value.status !== "PASS") continue;
      this.result(value.id, "PASS", {
        measurements: value.measurements,
        evidence: value.evidence,
        ...(value.subcases === undefined ? {} : { subcases: value.subcases }),
      });
    }
  }
  summary(): void {
    const rows = [...this.results.values()];
    this.json("summary.json", {
      counts: {
        PASS: rows.filter((r) => r.status === "PASS").length,
        FAIL: rows.filter((r) => r.status === "FAIL").length,
        "NOT-AUTOMATABLE": rows.filter((r) => r.status === "NOT-AUTOMATABLE").length,
      },
      total: Object.keys(nativeBrowserCases).length,
      selected: [...this.selected],
      excluded: Object.keys(nativeBrowserCases).filter(
        (id) => !this.selected.has(id as NativeCaseId),
      ),
      completed: rows.length,
      cases: rows,
    });
  }
  remaining(reason: string): void {
    for (const id of Object.keys(nativeBrowserCases) as NativeCaseId[]) {
      if (this.selected.has(id) && !this.results.has(id))
        this.result(id, "FAIL", { reason, evidence: ["logs/child-stderr.log", "trace.jsonl"] });
    }
  }
}
