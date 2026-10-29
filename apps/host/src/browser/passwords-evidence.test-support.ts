import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Failure evidence is scanned before scrubbing; redaction cannot make a leak pass. */
export class PasswordsJourneyEvidence {
  readonly directory: string;
  readonly cases = new Map<string, { status: string; detail?: string }>();
  readonly rawScans: { path: string; matches: number }[] = [];
  readonly #canaries: readonly string[];
  readonly #command: string;
  constructor(
    journey: string,
    command: string,
    cases: readonly string[],
    canaries: readonly string[],
    directoryRoot?: string,
  ) {
    this.directory = resolve(
      process.env.OPENSTEER_PASSWORDS_ANYWHERE_EVIDENCE_DIR ??
        directoryRoot ??
        "/tmp/opensteer-passwords-anywhere/evidence",
      journey,
    );
    this.#command = process.env.OPENSTEER_PASSWORDS_ANYWHERE_COMMAND ?? command;
    this.#canaries = canaries.filter(Boolean);
    for (const name of cases) this.cases.set(name, { status: "not-executed" });
  }
  scan(path: string, value: string | Buffer): void {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const matches = this.#canaries.reduce(
      (count, canary) =>
        count +
        Number(bytes.includes(Buffer.from(canary))) +
        Number(bytes.includes(Buffer.from(canary, "utf16le"))),
      0,
    );
    this.rawScans.push({ path, matches });
  }
  scrub(value: string): string {
    for (const canary of this.#canaries) value = value.replaceAll(canary, "[SAVED FIELD REDACTED]");
    return value;
  }
  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
    this.scan(name, text);
    await writeFile(join(this.directory, name), this.scrub(text));
  }
  async run(name: string, action: () => Promise<void>): Promise<void> {
    if (!this.cases.has(name)) throw new Error(`Unselected Passwords case: ${name}`);
    this.cases.set(name, { status: "running" });
    try {
      await action();
      this.cases.set(name, { status: "passed" });
    } catch (error) {
      const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.scan(`${name}:failure`, diagnostic);
      this.cases.set(name, { status: "failed", detail: this.scrub(diagnostic) });
      // Do not let the test runner echo a canary from a failed assertion.
      throw new Error(this.scrub(diagnostic));
    }
  }
  async finish(diagnostics: Record<string, string> = {}): Promise<void> {
    for (const [name, text] of Object.entries(diagnostics)) await this.write(name, text);
    await this.write("manifest.json", {
      sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      command: this.#command,
      processArguments: process.argv,
      versions: {
        node: process.version,
        pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      },
      selected: [...this.cases.keys()],
      executed: [...this.cases]
        .filter(([, result]) => result.status !== "not-executed")
        .map(([name]) => name),
      results: Object.fromEntries(this.cases),
      passed: [...this.cases.values()].every(({ status }) => status === "passed"),
    });
    const exported: { path: string; matches: number }[] = [];
    const names = (await readdir(this.directory, { recursive: true })).sort();
    for (const name of names) {
      if (name === "SHA256SUMS" || !(await stat(join(this.directory, name))).isFile()) continue;
      const before = this.rawScans.length;
      this.scan(name, await readFile(join(this.directory, name)));
      exported.push(...this.rawScans.splice(before));
    }
    const matches = [...this.rawScans, ...exported].reduce((sum, entry) => sum + entry.matches, 0);
    await writeFile(
      join(this.directory, "leak-scan.json"),
      JSON.stringify({ passed: matches === 0, matches, raw: this.rawScans, exported }, null, 2) +
        "\n",
    );
    const sums: string[] = [];
    for (const name of (await readdir(this.directory, { recursive: true })).sort()) {
      if (name !== "SHA256SUMS" && (await stat(join(this.directory, name))).isFile())
        sums.push(
          `${createHash("sha256")
            .update(await readFile(join(this.directory, name)))
            .digest("hex")}  ${name}`,
        );
    }
    await writeFile(join(this.directory, "SHA256SUMS"), sums.join("\n") + "\n");
    if (matches)
      throw new Error(
        `Saved-field leak detected (${matches} matches); see leak-scan.json. Raw content withheld.`,
      );
  }
}
