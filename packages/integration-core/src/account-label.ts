export function integrationAccountLabel(account: {
  readonly displayName: string;
  readonly accountIdentifier: string | null;
}): string {
  const identifier = account.accountIdentifier?.trim();
  return identifier && identifier !== account.displayName.trim()
    ? `${account.displayName} (${identifier})`
    : account.displayName;
}
