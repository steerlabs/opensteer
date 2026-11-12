# Hosted teams

A hosted team is the self-hosted [team server](teams.md), run by Opensteer from the same published
images: one namespace `team-<slug>` in the `teams-1` cluster (`opensteer-prod`) holding the team
Host, its own Postgres and its gateway in one pod, at `https://<slug>.teams.opensteer.com`.
Everyone's agents still run on their own computers. Opensteer's operators can technically read what
a hosted team stores, and the create page says so. The platform (cluster, edge, DNS, the
provisioner's permissions) lives in the private `opensteer-infra` repo under `kubernetes/prod/teams-1`.

## Who decides what

Account decides which teams exist; [apps/team-provisioner](../apps/team-provisioner) pulls that list
and makes the cluster match, so Account never holds cluster credentials. Account admits only a
Google-signed ID token for `OPENSTEER_HOSTED_TEAMS_PROVISIONER_EMAIL` with its own public URL as
audience, and offers no hosted teams without that setting. Turn it on in
[account.env](../deploy/account/account.env) only after a Stable promotion has deployed the
provisioner, or teams wait at "starting".

Account shows the first-owner setup token to the creator once and stores only its digest. Addresses
are never reused: a deleted team stays as a tombstone, and the database tombstones a team whenever
its creator's Account is deleted, whichever release deletes it.

## Isolation

Team namespaces run `restricted` Pod Security with no service-account token. The NetworkPolicy
admits only the edge namespace and lets pods reach DNS and the public internet, never private ranges;
the link-local DNS addresses (NodeLocal DNSCache and the metadata server) are open on port 53 only.
The provisioner may read or change only objects named `team`, and an admission policy confines its
writes to `team-*` namespaces. The release deployer can change only the provisioner's Deployment.

## Releases

Hosted teams follow Stable: publishing a Stable deploys the provisioner with that release's team
image digests, and it moves teams one at a time. A team on the new release that is not ready holds
the rest and is reported failed after ten minutes; restarts a team asked for (a new setup link,
suspension) are never held. The provisioner is Ready only after a whole reconcile pass succeeds, so a
release that cannot reach Account or list teams is rolled back. The GHCR packages must be public,
because the cluster pulls without credentials.

## Abuse

Operators suspend, resume or delete a team from an Account pod:
`node dist/hosted-team-operator-main.js suspend <slug> <reason>`, `unsuspend <slug>` or
`delete <slug>`. A suspended team scales to no pods and keeps its data.
