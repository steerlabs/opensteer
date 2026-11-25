export type AntigravityPlatform = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

export interface AntigravityReleaseMember {
  readonly name: "antigravity";
  readonly sizeBytes: number;
  readonly type: "file";
}

export interface AntigravityReleaseAsset {
  readonly archive: {
    readonly sha256: string;
    readonly sha512?: string;
    readonly sizeBytes: number;
    readonly url: string;
  };
  readonly members: readonly [AntigravityReleaseMember];
}

/**
 * Google's pinned 1.5.16 standalone Go Antigravity CLI release (`antigravity acp`).
 * Replaces the legacy 1.4.1 Python/PAR runtime, fixing Claude thinking-signature
 * corruption on resume and enabling native mid-turn prompt steering.
 */
export const antigravityReleaseManifest = {
  version: "1.5.16",
  platforms: {
    "darwin-arm64": {
      archive: {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-arm/cli_mac_arm64.tar.gz",
        sizeBytes: 86_506_312,
        sha256: "ba47202f712de4c4a78fd787d81ba206d73e11c97572fc69420f29a77efc8d95",
        sha512:
          "33f5617dc74fea606d47b2483c6d271c850c9f3c9c55b724c664c3c0d4b82100d819fbcf55714f851765f6628d4296883ac8939b4fdeb55d5e6b9ce923135d18",
      },
      members: [{ name: "antigravity", sizeBytes: 230_641_440, type: "file" }],
    },
    "darwin-x64": {
      archive: {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/darwin-x64/cli_mac_x64.tar.gz",
        sizeBytes: 92_242_508,
        sha256: "14cd76a31e42ad461d6f8adf7631306cac37553f547aba0a0f111b0824d21c0c",
        sha512:
          "b3eae073ee633032e9d473cdc7725c30bdfe2e09436bc36cfb3422e7e5fa3733de9591a7f78d02362294e7bf87e345d70e5d839689e526129a6f3fc041857a05",
      },
      members: [{ name: "antigravity", sizeBytes: 240_522_160, type: "file" }],
    },
    "linux-x64": {
      archive: {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/linux-x64/cli_linux_x64.tar.gz",
        sizeBytes: 101_821_670,
        sha256: "9bdab234d06bad1a61be2321072652eb06be78baff1acbfae47331da5a090abc",
        sha512:
          "3dee9f26e298156db673f6ce2a0f5dfed5b30006e04ceb9809c68070e7b717587b33a3da0f8bc2eda45af81a50bc8b14c82b28ae5832bcfe3e7fd49397117b31",
      },
      members: [{ name: "antigravity", sizeBytes: 275_067_592, type: "file" }],
    },
    "linux-arm64": {
      archive: {
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/linux-arm/cli_linux_arm64.tar.gz",
        sizeBytes: 92_724_848,
        sha256: "7ddeec790084e550af18adb04a5b6c5fdf2db3e1026854f49901a04cb4265c7e",
        sha512:
          "23c193151499a4986fd5fa0d8132665cc8ffbad6cc0b3ff4fd53a2cb68abb76b149a992b836d53063443cd89add335f14d8134fb02abdcecbf6e1eaef6c53d33",
      },
      members: [{ name: "antigravity", sizeBytes: 257_774_256, type: "file" }],
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

/** Why this computer cannot run Antigravity, when Google publishes no release for it. */
export function antigravityUnavailableReason(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string | undefined {
  if (antigravityPlatform(platform, architecture)) return undefined;
  if (platform === "win32") {
    return "Google publishes no Windows release of Antigravity's agent server, so Antigravity is not available on this computer";
  }
  return `Google does not publish Antigravity ${antigravityReleaseManifest.version} for ${platform}-${architecture}`;
}
