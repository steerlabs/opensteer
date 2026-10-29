/** Longest-processing-time first; stable ties make independently computed shards agree. */
export function assignShards(files, durations, count, unknownDuration) {
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
  for (const { file, duration } of weighted) {
    const index = totals.indexOf(Math.min(...totals));
    shards[index].push(file);
    totals[index] += duration;
  }
  return shards;
}
