export function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function redact(value) {
  return String(value)
    .replace(/(#token=)[\w.-]+/gu, "$1[redacted]")
    .replace(/(\/v1\/browser\/connect\/)[\w-]+/gu, "$1[redacted]");
}

export const requiredFreeKiB = 50 * 1024 * 1024;

export function homeImageBuilds(builder) {
  const bake = ["buildx", "bake", "--builder", builder, "-f", "deploy/container/docker-bake.hcl"];
  return [
    {
      platform: "linux/amd64",
      args: [
        ...bake,
        "--set",
        "home-*.platform=linux/amd64",
        "--set",
        "home-*.output=type=cacheonly",
        "home",
      ],
    },
    {
      platform: "linux/arm64",
      args: [...bake, "--set", "home-*.platform=linux/arm64", "--load", "home"],
    },
  ];
}

export function assertBuildSpace(location, dfOutput) {
  const rows = dfOutput.trim().split("\n").slice(1);
  if (!rows.length) throw new Error(`No filesystem usage returned for ${location}.`);
  for (const row of rows) {
    const match = row.trim().match(/^\S+\s+\d+\s+\d+\s+(\d+)\s+\d+%\s+(.+)$/u);
    if (!match) throw new Error(`Cannot parse filesystem usage for ${location}.`);
    const available = Number(match[1]);
    if (available < requiredFreeKiB) {
      const gib = (available / (1024 * 1024)).toFixed(1);
      throw new Error(
        `${location} (${match[2]}) has ${gib} GiB free. The Home build requires 50 GiB free before it starts.`,
      );
    }
  }
}
