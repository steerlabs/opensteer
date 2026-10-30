/** Packet fields contain DNS, HTTP Host and TLS SNI, including unsuccessful attempts. */
export function forbiddenUpdateHosts(
  records: readonly string[],
  since: number,
  beta: boolean,
): string[] {
  const betaAccount = new Set([
    "accounts.beta.opensteer.com",
    "beta.opensteer.com",
    "portal.beta.opensteer.com",
  ]);
  return records.filter((line) => {
    const fields = line.split("|");
    if (Number(fields[0]) < since) return false;
    return fields
      .slice(3, 6)
      .flatMap((field) => field.split(","))
      .some((value) => {
        const host = value.toLowerCase().replace(/\.$/u, "").replace(/:\d+$/u, "");
        if (beta && betaAccount.has(host)) return false;
        return /(?:^|\.)(?:github\.com|githubusercontent\.com|githubassets\.com|opensteer\.com)$/u.test(
          host,
        );
      });
  });
}
