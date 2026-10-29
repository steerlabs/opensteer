import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import type { Reporter, TestModule, TestSpecification } from "vitest/node";
/** Discovery comes from an unsharded Vitest list invocation of the same config. */
export default class InventoryReporter implements Reporter {
  private executed: string[] = [];
  private selected: string[] = [];
  onTestRunStart(specs: readonly TestSpecification[]) {
    this.selected = specs.map((spec) => relative(process.cwd(), spec.moduleId)).sort();
  }
  onTestModuleEnd(module: TestModule) {
    if (module.state() !== "skipped") this.executed.push(relative(process.cwd(), module.moduleId));
  }
  onTestRunEnd() {
    const path = process.env.CI_INVENTORY_PATH;
    if (!path) throw new Error("Missing CI_INVENTORY_PATH");
    const raw: unknown = JSON.parse(readFileSync(process.env.CI_DISCOVERY_PATH!, "utf8"));
    if (
      !Array.isArray(raw) ||
      raw.some((p) => !p || typeof p !== "object" || !("file" in p) || typeof p.file !== "string")
    )
      throw new Error("Invalid discovery");
    const discovered = raw.map((p) => relative(process.cwd(), String(p.file))).sort();
    writeFileSync(
      path,
      JSON.stringify(
        {
          version: 1,
          lane: process.env.CI_LANE,
          shard: Number(process.env.CI_SHARD),
          total: Number(process.env.CI_SHARDS),
          discovered,
          selected: this.selected,
          executed: this.executed.sort(),
        },
        null,
        2,
      ) + "\n",
    );
  }
}
