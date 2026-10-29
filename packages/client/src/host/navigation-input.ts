import { parse } from "tldts";

export type NavigationInput =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "search"; readonly query: string };

export function parseNavigationInput(value: string): NavigationInput {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  const ipv6 = /^([0-9a-f:]+)([/?#].*)?$/iu.exec(trimmed);
  if (ipv6 && (ipv6[1]!.match(/:/gu)?.length ?? 0) >= 2) {
    const address = navigationUrl(`http://[${ipv6[1]}]${ipv6[2] ?? ""}`);
    if (address.kind === "url") return address;
  }
  const explicitPort = /^(?:\[[^\]]+\]|[^/:\s]+):\d+(?:[/?#]|$)/u.test(trimmed);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) && !explicitPort;
  if (hasScheme) return navigationUrl(trimmed);
  if (/\s/u.test(trimmed)) return { kind: "search", query: trimmed };
  let url: URL;
  try {
    url = new URL(`https://${trimmed}`);
  } catch {
    return { kind: "search", query: trimmed };
  }
  const host = url.hostname;
  const localhost = host === "localhost" || host.endsWith(".localhost");
  const ip = host.startsWith("[") || parse(host).isIp;
  const knownTld = host.includes(".") && parse(host).isIcann;
  if (!localhost && !ip && !explicitPort && !knownTld) return { kind: "search", query: trimmed };
  return navigationUrl(`${localhost || ip || explicitPort ? "http" : "https"}://${trimmed}`);
}

function navigationUrl(value: string): NavigationInput {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? { kind: "url", url: url.toString() }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export function webSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}
export function normalizeNavigationInput(value: string): string | null {
  const parsed = parseNavigationInput(value);
  return parsed.kind === "url"
    ? parsed.url
    : parsed.kind === "search"
      ? webSearchUrl(parsed.query)
      : null;
}
