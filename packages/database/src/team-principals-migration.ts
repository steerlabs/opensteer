import { sql, type Kysely } from "kysely";

export async function migrateTeamPrincipals(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table team_principals (
      id text primary key,
      home_team_id text not null,
      home_user_id text not null,
      member_user_id text unique references team_members(user_id),
      display_name text,
      handle text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(home_team_id, home_user_id),
      constraint team_principals_identity check (
        (member_user_id is not null and id=member_user_id and home_user_id=member_user_id
          and display_name is null and handle is null)
        or (member_user_id is null and display_name is not null and handle is not null)
      )
    );
    create function opensteer_check_team_principal() returns trigger language plpgsql as $$
    begin
      if (new.member_user_id is not null) is distinct from
        (new.home_team_id=(select id from deployments where singleton_key='primary')) then
        raise check_violation using message='Principal home team must match its membership';
      end if;
      return new;
    end $$;
    create trigger team_principals_identity before insert or update on team_principals
      for each row execute function opensteer_check_team_principal();

    insert into team_principals(id,home_team_id,home_user_id,member_user_id,created_at,updated_at)
      select m.user_id,d.id,m.user_id,m.user_id,m.joined_at,m.changed_at
      from team_members m cross join deployments d where d.singleton_key='primary';
    do $$ begin
      if exists(select 1 from team_members m where not exists(
        select 1 from team_principals p where p.member_user_id=m.user_id)) then
        raise check_violation using message='Team members require a Deployment identity';
      end if;
    end $$;
    create function opensteer_create_member_principal() returns trigger language plpgsql as $$
    declare home_team_id text;
    begin
      select id into strict home_team_id from deployments where singleton_key='primary';
      insert into team_principals(id,home_team_id,home_user_id,member_user_id,created_at,updated_at)
        values(new.user_id,home_team_id,new.user_id,new.user_id,new.joined_at,new.changed_at);
      return new;
    end $$;
    create trigger team_members_principal after insert on team_members
      for each row execute function opensteer_create_member_principal();

    alter table team_messages drop constraint team_messages_author_user_id_fkey,
      add foreign key(author_user_id) references team_principals(id);
    alter table team_mentions drop constraint team_mentions_target_user_id_fkey,
      add foreign key(target_user_id) references team_principals(id);
    alter table team_blobs drop constraint team_blobs_uploader_user_id_fkey,
      add foreign key(uploader_user_id) references team_principals(id);
    alter table team_message_pins drop constraint team_message_pins_pinned_by_fkey,
      add foreign key(pinned_by) references team_principals(id);
    alter table team_note_versions drop constraint team_note_versions_writer_user_id_fkey,
      add foreign key(writer_user_id) references team_principals(id);

    alter table team_channel_members add column member_user_id text generated always as
      (case when subject_kind='person' then subject_id end) stored references team_members(user_id);
    alter table team_topic_grants add column member_user_id text generated always as
      (case when subject_kind='person' then subject_id end) stored references team_members(user_id);
  `.execute(database);
}
