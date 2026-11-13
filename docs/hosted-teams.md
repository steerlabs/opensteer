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
provisioner, or teams wait at `starting`.

Addresses are never reused: a deleted team stays as a tombstone, and the database tombstones a team
whenever its creator's Account is deleted, whichever release deletes it.

## Setup

Account finishes a hosted team's first-owner setup itself, so nobody handles a setup link. It keeps
the plaintext setup token sealed to the team and its setup generation; the provisioner gets only
its digest and no client ever sees it. Once the provisioner reports the Host running the current
generation, Account exchanges the token at the team's own origin, adopts that Host for the creator,
and completes with `hostedBootstrap`, which the Host accepts only when it advertises
`team-hosted-bootstrap-v1`. In that one transaction the Host commits the creator, by the completion
grant's signed subject, as its only owner and creates #general. The creator then signs in at the
team through ordinary Account OIDC and arrives as owner.

The Host keeps a receipt keyed by hosted team and exact authority. A replayed completion answers
that receipt and changes no membership, so it never reinstates a creator who left, never re-applies
the owner role and never displaces another owner; a Host that already has an owner, or already
knows the creator as someone it removed, refuses setup. When an answer is lost after the Host
committed, Account resends its stored adoption result instead of starting over. Recording the
receipt clears the sealed token and every sealed adoption result for that Host.

A team is `ready` only when Account holds the receipt and the creator's directory entry has
arrived from the Host, not when its pod is up. Each attempt is fenced by its claim and setup
generation, so a slower attempt, a retry or a cancel never lets a stale write land. After 15
minutes a team is `failed`; a retry before the Host has an owner seals a new token and restarts
the Host with a fresh setup window. Self-hosted teams keep `/setup`.

Its creator may cancel a team only while its Host can't have an owner: before Account adopts that
Host. Adoption takes the same origin lock as cancelling, so one of them loses. Once a Deployment or
receipt exists, whatever stage Account shows, only the team's owners may delete it, and only the
team's Host knows who they are: Account asks it with a one-minute Account-signed question. A Host
that can't answer, because it predates hosted bootstrap or is down, deletes nothing: ownership may
have moved on, so there is no creator fallback.

Setup stages move only on provisioner reports judged against the team's current setup generation,
so a late report about an earlier generation never fails or restarts a retry.

The transition to `ready` queues a generic `team-ready` push to the creator's phones, opening the
team's #general; Hosts can't publish that kind. Clients find a hosted team by the `hostedTeamId`
in the team's bootstrap, never by matching its origin.

## Isolation

Team namespaces run `restricted` Pod Security with no service-account token. The NetworkPolicy
admits only the edge namespace and lets pods reach DNS and the public internet, never private ranges;
the link-local DNS addresses (NodeLocal DNSCache and the metadata server) are open on port 53 only.
The provisioner may read or change only objects named `team`, and an admission policy confines its
writes to `team-*` namespaces. The release deployer can change only the provisioner's Deployment.

## Releases

Hosted teams follow Stable: publishing a Stable deploys the provisioner with that release's team
image digests, and it moves teams one at a time. A team on the new release that is not ready holds
the rest and is reported failed after ten minutes; restarts a team asked for (a setup retry,
suspension) are never held. The provisioner is Ready only after a whole reconcile pass succeeds, so a
release that cannot reach Account or list teams is rolled back. The GHCR packages must be public,
because the cluster pulls without credentials.

## Abuse

Operators suspend, resume or delete a team from an Account pod:
`node dist/hosted-team-operator-main.js suspend <slug> <reason>`, `unsuspend <slug>` or
`delete <slug>`. A suspended team scales to no pods and keeps its data.
