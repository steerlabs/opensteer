import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const teamAdministrationMigration: Migration = {
  async up(database) {
    await sql`
      create table public.team_invitations (
        id uuid primary key,
        selector text not null unique check (selector ~ '^[A-Za-z0-9_-]{24,96}$'),
        token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
        intended_email text not null,
        member_kind text not null check (member_kind in ('full', 'guest')),
        created_by text not null references public.users(id) on delete restrict,
        created_at timestamptz not null,
        expires_at timestamptz not null check (expires_at > created_at),
        accepted_at timestamptz,
        accepted_by text references public.users(id) on delete restrict,
        revoked_at timestamptz,
        revoked_by text references public.users(id) on delete restrict,
        command_id text not null,
        request_fingerprint text not null,
        check ((accepted_at is null) = (accepted_by is null)),
        check ((revoked_at is null) = (revoked_by is null)),
        unique (created_by, command_id)
      );
      create index team_invitations_created on public.team_invitations(created_at, id);
      create index team_invitations_accepted on public.team_invitations(accepted_by, accepted_at, id)
        where accepted_by is not null;
      alter table public.auth_sessions add column member_generation bigint;
      alter table public.agent_connections
        add column member_generation bigint,
        add column membership_generation bigint;
      alter table public.auth_sessions add constraint auth_sessions_member_generation_bounds
        check (member_generation between 1 and 9007199254740991) not valid;
      alter table public.agent_connections
        add constraint agent_connections_member_generation_bounds
          check (member_generation between 1 and 9007199254740991) not valid,
        add constraint agent_connections_membership_generation_bounds check (
          membership_generation is null or
          (membership_generation between 1 and 9007199254740991 and workspace_id is not null)
        ) not valid;
    `.execute(database);
  },
};
