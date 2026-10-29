import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { assignShards, unknownDuration } from "../.github/scripts/ci-sharding.mjs";

const durations = JSON.parse(
  readFileSync(new URL("../.github/scripts/ci-durations.json", import.meta.url), "utf8"),
) as Record<"tests" | "integration", Record<string, number>>;

export default class CiSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const lane = process.env.CI_LANE;
    if (lane !== "tests" && lane !== "integration") return super.sort(files);
    const weight = (file: TestSpecification) =>
      durations[lane][relative(this.ctx.config.root, file.moduleId)] ?? unknownDuration[lane];
    return [...files].sort((a, b) => weight(b) - weight(a) || a.moduleId.localeCompare(b.moduleId));
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const lane = process.env.CI_LANE;
    if (lane !== "tests" && lane !== "integration") return super.shard(files);
    const shard = this.ctx.config.shard;
    if (!shard) throw new Error("Missing shard configuration");
    const paths = files.map((file) => relative(this.ctx.config.root, file.moduleId));
    const selected = new Set<string>(
      assignShards(paths, durations[lane], shard.count, unknownDuration[lane])[shard.index - 1],
    );
    return files.filter((file) => selected.has(relative(this.ctx.config.root, file.moduleId)));
  }
}
