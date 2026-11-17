export interface BrowserUserAgentMetadata {
  readonly brands: readonly { readonly brand: string; readonly version: string }[];
  readonly fullVersionList: readonly { readonly brand: string; readonly version: string }[];
  readonly fullVersion: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly architecture: string;
  readonly model: string;
  readonly mobile: boolean;
  readonly bitness: string;
}

export interface BrowserIdentity {
  readonly userAgent: string;
  readonly clientHints: { readonly brands: string; readonly platform: string } | undefined;
  readonly userAgentMetadata: BrowserUserAgentMetadata | undefined;
}

export interface BrowserSystemIdentity {
  readonly architecture: string;
  readonly bitness: string;
  readonly platformVersion: string;
  readonly fullVersion?: string;
}

// Chromium seeds its GREASE brand from the major version: two consecutive
// separators from this list around "A", a version from the second list, and
// the pair's order from the major's parity. Computing it keeps the identity
// correct on the next engine bump instead of silently dropping client hints.
const greaseSeparators = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const greaseVersions = ["8", "99", "24"];

export function greaseBrand(major: number): { brand: string; version: string } {
  return {
    brand: `Not${greaseSeparators[major % 11]}A${greaseSeparators[(major + 1) % 11]}Brand`,
    version: greaseVersions[major % 3]!,
  };
}

function buildMetadata(
  major: number,
  fullVersion: string,
  platform: string,
  system: BrowserSystemIdentity | undefined,
): BrowserUserAgentMetadata {
  const grease = greaseBrand(major);
  const greaseBrandEntry = { brand: grease.brand, version: grease.version };
  const chromiumBrandEntry = { brand: "Chromium", version: String(major) };
  const greaseFullEntry = { brand: grease.brand, version: `${grease.version}.0.0.0` };
  const chromiumFullEntry = { brand: "Chromium", version: fullVersion };
  const greaseFirst = major % 2 === 0;
  return {
    brands: greaseFirst
      ? [greaseBrandEntry, chromiumBrandEntry]
      : [chromiumBrandEntry, greaseBrandEntry],
    fullVersionList: greaseFirst
      ? [greaseFullEntry, chromiumFullEntry]
      : [chromiumFullEntry, greaseFullEntry],
    fullVersion,
    platform,
    platformVersion: system?.platformVersion ?? "",
    architecture: system?.architecture ?? "",
    model: "",
    mobile: false,
    bitness: system?.bitness ?? "",
  };
}

/** The one identity every browser session presents, derived from the engine. */
export function browserIdentity(
  sessionUserAgent: string,
  system?: BrowserSystemIdentity,
): BrowserIdentity {
  const userAgent = chromeUserAgent(sessionUserAgent);
  const majorText = /Chrome\/(\d+)\./u.exec(userAgent)?.[1];
  if (!majorText) return { userAgent, clientHints: undefined, userAgentMetadata: undefined };
  const major = Number(majorText);
  const platform = userAgent.includes("Windows NT")
    ? "Windows"
    : userAgent.includes("Macintosh")
      ? "macOS"
      : "Linux";
  // The session user agent is already reduced by the time pages are created,
  // so the caller supplies the engine's real full version when it has one.
  const fullVersion =
    system?.fullVersion ??
    /Chrome\/(\d+\.\d+\.\d+\.\d+)/u.exec(sessionUserAgent)?.[1] ??
    `${major}.0.0.0`;
  const userAgentMetadata = buildMetadata(major, fullVersion, platform, system);
  return {
    userAgent,
    clientHints: {
      brands: userAgentMetadata.brands
        .map((entry) => `"${entry.brand}";v="${entry.version}"`)
        .join(", "),
      platform,
    },
    // A CDP user-agent override without metadata empties navigator.userAgentData,
    // so the JS identity must travel with the string, from the same source as
    // the wire hints above.
    userAgentMetadata,
  };
}

/** Metadata for a reduced UA built from an engine version, as Playwright needs. */
export function reducedUserAgentMetadata(
  version: string,
  platform: string,
  system?: BrowserSystemIdentity,
): BrowserUserAgentMetadata | undefined {
  const majorText = version.split(".")[0];
  const major = Number(majorText);
  if (!majorText || !Number.isInteger(major) || major <= 0) return undefined;
  return buildMetadata(major, version, platform, system);
}

export function chromeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s[^\s/]+\/[^\s]+(?=\sChrome\/)/gu, "")
    .replace(/\sElectron\/[^\s]+/gu, "")
    .replace(/Chrome\/(\d+)\.\d+\.\d+\.\d+/u, "Chrome/$1.0.0.0");
}
