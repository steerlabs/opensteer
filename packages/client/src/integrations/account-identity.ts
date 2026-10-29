/** What the Host recorded about an account that a person can tell it apart by. */
export interface IntegrationAccountFacts {
  readonly accountIdentifier: string | null;
  readonly createdAt: string;
  readonly displayName: string;
  readonly id: string;
}

/** Who the account is at the provider, when its name does not already say so. */
export function integrationAccountIdentity(
  account: Pick<IntegrationAccountFacts, "accountIdentifier" | "displayName">,
): string | null {
  const identifier = account.accountIdentifier?.trim() ?? "";
  return identifier &&
    !account.displayName.trim().toLocaleLowerCase().includes(identifier.toLocaleLowerCase())
    ? identifier
    : null;
}

/**
 * The line beside an account's name that tells it apart from the others it is
 * listed with: who it is at the provider, or else when it was added here.
 *
 * Names are the owner's and can repeat — a key the provider names no account
 * for is saved under the integration's own name — so a name alone never says
 * which account a row is. Only recorded facts are shown: nothing is renamed,
 * no key is hinted at, and no identifier a person did not choose appears.
 */
export function integrationAccountDetail(
  account: IntegrationAccountFacts,
  accounts: readonly IntegrationAccountFacts[],
  now: Date = new Date(),
): string {
  const identity = integrationAccountIdentity(account);
  if (identity !== null) return identity;
  const day = addedDay(account.createdAt, now);
  // Two accounts of one name, added the same day: the time is what differs.
  const twins = accounts.filter(
    (other) =>
      other.id !== account.id &&
      other.displayName.trim().toLocaleLowerCase() ===
        account.displayName.trim().toLocaleLowerCase() &&
      integrationAccountIdentity(other) === null &&
      addedDay(other.createdAt, now) === day,
  );
  if (twins.length === 0) return `Added ${day}`;
  const seconds = twins.some(
    (other) => addedTime(other.createdAt) === addedTime(account.createdAt),
  );
  return `Added ${day}, ${addedTime(account.createdAt, seconds)}`;
}

function addedDay(createdAt: string, now: Date): string {
  const added = new Date(createdAt);
  return new Intl.DateTimeFormat(
    "en-US",
    added.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  ).format(added);
}

function addedTime(createdAt: string, seconds = false): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  }).format(new Date(createdAt));
}
