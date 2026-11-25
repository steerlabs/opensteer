/** A browser pool host release for tests: every Cloud Computer's Account needs the pool. */
export function browserPoolRelease(sha256: string) {
  const artifact = (name: string) => ({
    [`${name}Url`]: `https://releases.example.test/${name}`,
    [`${name}Sha256`]: sha256,
  });
  return {
    version: "1.0.0",
    installerUrl: "https://releases.example.test/pool-host.sh",
    installerSha256: sha256,
    artifacts: Object.assign(
      {},
      ...["agent", "relay", "rootfs", "kernel", "egress"].map(artifact),
    ) as Record<string, string>,
  };
}
