/**
 * The one check of a browser egress upstream (round I, U2): what a slot proxy starts with
 * (apps/browser-runtime/src/egress-config.ts) and what a pool host writes for it from the
 * account service (apps/pool-agent/src/slot-egress-fetch.ts) pass the same function, so a pool
 * host never writes what its proxy would refuse to start with.
 */

/** No address longer than this, whatever the URL parser would take. */
export const maximumUpstreamUrlLength = 1024;
/** No credential longer than this. */
export const maximumUpstreamCredentialLength = 1024;

/** `https://host:port` with no user info, path, query or fragment, and a port that is not 0. */
export function parseBrowserEgressUpstreamUrl(
  value: string,
): { readonly text: string; readonly hostname: string; readonly port: number } | undefined {
  const text = value.trim();
  if (text.length > maximumUpstreamUrlLength) return undefined;
  const url = URL.parse(text);
  if (!/^https:\/\/(?:\[[^\]]+\]|[^:/?#@\\\s]+):[0-9]+$/iu.test(text) || !url || url.port === "0")
    return undefined;
  return { text, hostname: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || 443) };
}

/** A credential the proxy accepts: not blank, and (for a username) no colon. */
export function browserEgressCredentialAccepted(value: string, kind: "username" | "password") {
  return !!value.trim() && !(kind === "username" && value.includes(":"));
}

/**
 * What a pool host writes as a file the proxy reads: accepted by the proxy, and also no
 * control character (the proxy's reader strips trailing line ends, so one would change the
 * value) and no longer than the bound.
 */
export function browserEgressCredentialWritable(value: string, kind: "username" | "password") {
  return (
    browserEgressCredentialAccepted(value, kind) &&
    value.length <= maximumUpstreamCredentialLength &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
  );
}
