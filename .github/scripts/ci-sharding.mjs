/** Weight in ms for a file without a recorded duration; also each recorded file's startup allowance. */
export const unknownDuration = { tests: 1_500, integration: 3_000 };

// Total duration alone can put a bulk seed beside several browser/runtime or
// migration suites, exhausting their operation budgets. No suite needs this today.
export const integrationContention = {
  files: [],
  maxCompanionDuration: 30_000,
};

/** Longest-processing-time first; stable ties make independently computed shards agree. */
export function assignShards(files, durations, count, unknownDuration, contention) {
  if (!Number.isInteger(count) || count < 1 || new Set(files).size !== files.length)
    throw new Error("Invalid shard input");
  const weighted = files.map((file) => {
    const duration = durations[file] ?? unknownDuration;
    if (!Number.isFinite(duration) || duration < 0) throw new Error(`Invalid duration: ${file}`);
    return { file, duration };
  });
  weighted.sort((a, b) => b.duration - a.duration || a.file.localeCompare(b.file, "en"));
  const shards = Array.from({ length: count }, () => []);
  const totals = Array(count).fill(0);
  const reserved = new Set(count > 1 ? contention?.files : []);
  const limit = contention?.maxCompanionDuration ?? Infinity;
  const separate = weighted.some(({ file }) => reserved.has(file));
  const place = ({ file, duration }, index) => {
    shards[index].push(file);
    totals[index] += duration;
  };
  for (const entry of weighted.filter(({ file }) => reserved.has(file))) place(entry, 0);
  for (const entry of weighted.filter(({ file }) => !reserved.has(file))) {
    const candidates = totals.map((total, index) =>
      separate && index === 0 && (durations[entry.file] === undefined || entry.duration > limit)
        ? Infinity
        : total,
    );
    const index = candidates.indexOf(Math.min(...candidates));
    place(entry, index);
  }
  return shards;
}
