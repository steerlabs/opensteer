import {
  integrationAccountDetail,
  type IntegrationAccountFacts,
} from "@opensteer/client/integrations";

export function accountOptionLabel(
  account: IntegrationAccountFacts,
  accounts: readonly IntegrationAccountFacts[],
): string {
  return `${account.displayName} — ${integrationAccountDetail(account, accounts)}`;
}

export function IntegrationAccountIdentity({
  account,
  accounts,
}: {
  readonly account: IntegrationAccountFacts;
  /** The accounts it is shown among, which decide what tells it apart. */
  readonly accounts: readonly IntegrationAccountFacts[];
}) {
  return (
    <span className="intg-account-identity">
      <span className="intg-account-identity__name">{account.displayName}</span>
      <span className="intg-account-identity__identifier">
        {integrationAccountDetail(account, accounts)}
      </span>
    </span>
  );
}
