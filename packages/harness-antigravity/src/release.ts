export type AntigravityPlatform = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export interface AntigravityReleaseMember {
  readonly name: "agy_acp_server.par" | "localharness_external";
  readonly sizeBytes: number;
  readonly type: "file";
}

export interface AntigravityReleaseAsset {
  readonly archive: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly url: string;
  };
  readonly members: readonly [AntigravityReleaseMember, AntigravityReleaseMember];
}

/**
 * Google's complete 1.4.1 ACP release. Later 1.4 releases write a system skill
 * into every Workspace, so a bump requires re-qualification rather than only
 * replacing these hashes.
 */
export const antigravityReleaseManifest = {
  version: "1.4.1",
  platforms: {
    "darwin-arm64": {
      archive: {
        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-arm64.zip",
        sizeBytes: 112_737_434,
        sha256: "f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17",
      },
      members: [
        { name: "agy_acp_server.par", sizeBytes: 280_996_576, type: "file" },
        { name: "localharness_external", sizeBytes: 120_246_928, type: "file" },
      ],
    },
    "darwin-x64": {
      archive: {
        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.1-darwin-x86_64.zip",
        sizeBytes: 118_349_036,
        sha256: "27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307",
      },
      members: [
        { name: "agy_acp_server.par", sizeBytes: 285_186_624, type: "file" },
        { name: "localharness_external", sizeBytes: 124_910_048, type: "file" },
      ],
    },
    "linux-x64": {
      archive: {
        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-x86_64.zip",
        sizeBytes: 336_170_339,
        sha256: "2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384",
      },
      members: [
        { name: "agy_acp_server.par", sizeBytes: 930_826_753, type: "file" },
        { name: "localharness_external", sizeBytes: 131_187_512, type: "file" },
      ],
    },
    "linux-arm64": {
      archive: {
        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.1-linux-arm64.zip",
        sizeBytes: 321_922_507,
        sha256: "609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da",
      },
      members: [
        { name: "agy_acp_server.par", sizeBytes: 933_416_796, type: "file" },
        { name: "localharness_external", sizeBytes: 124_895_000, type: "file" },
      ],
    },
  },
} as const satisfies {
  readonly version: string;
  readonly platforms: Record<AntigravityPlatform, AntigravityReleaseAsset>;
};

export function antigravityPlatform(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): AntigravityPlatform | undefined {
  const key = `${platform}-${architecture}`;
  return key in antigravityReleaseManifest.platforms ? (key as AntigravityPlatform) : undefined;
}
