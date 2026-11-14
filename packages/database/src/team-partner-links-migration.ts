import { sql, type Kysely } from "kysely";

export async function migrateTeamPartnerLinks(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table team_sharing_settings (
      singleton_key text primary key check (singleton_key = 'team'),
      policy text not null default 'admins' check (policy in ('off','admins','members-propose','members'))
    );
    insert into team_sharing_settings(singleton_key) values ('team');
    create table team_partner_invites (
      id uuid primary key,
      verifier_hash text not null,
      created_by text not null references team_members(user_id),
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      consumed_at timestamptz,
      revoked_at timestamptz
    );
    create table team_partner_links (
      id uuid primary key,
      partner_team_id text not null,
      partner_origin text not null,
      partner_host_key_fingerprint text not null,
      partner_host_instance_id text not null,
      partner_authority jsonb not null,
      partner_name text not null,
      role text not null check (role in ('dialer','listener')),
      state text not null check (state in ('pending','active','revoked')),
      local_approved boolean not null,
      partner_approved boolean not null,
      created_by text not null references team_members(user_id),
      approved_by text references team_members(user_id),
      created_at timestamptz not null default now(),
      approved_at timestamptz,
      last_seen_at timestamptz,
      last_error text check (last_error in ('identity-mismatch','unsupported-partner-version','unreachable')),
      revoked_at timestamptz,
      revoked_by text check (revoked_by in ('local','partner')),
      check (state != 'active' or (local_approved and partner_approved)),
      check ((state = 'revoked') = (revoked_at is not null))
    );
    create unique index team_partner_links_live_team on team_partner_links(partner_team_id)
      where state != 'revoked';
  `.execute(database);
}
