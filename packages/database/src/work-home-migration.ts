import { sql, type Kysely } from "kysely";

export const workHomeMigrationName = "0047_work_home";

const auditTables = [
  ["agent_connections", "insert or update"],
  ["agent_sessions", "insert or update"],
  ["agent_operations", "insert or update"],
  ["requests", "insert or update"],
  ["devices", "insert or update"],
  ["auth_sessions", "insert or delete"],
  ["commands", "insert"],
  ["work_home_policy", "update"],
] as const;

export async function enableWorkHomeTriggers<DB>(db: Kysely<DB>): Promise<void> {
  for (const [table] of auditTables) {
    await sql`alter table ${sql.table(table)} enable trigger work_audit_capture`.execute(db);
  }
  await sql`
    alter table devices enable trigger work_device_enrollment;
    alter table auth_sessions enable trigger work_sign_in;
    alter table agent_operations enable trigger work_operation_policy
  `.execute(db);
}

export async function applyWorkHome(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table work_home_policy (
      singleton boolean primary key default true check (singleton),
      assignment_id text not null,
      deployment_id text not null,
      organization_name text not null,
      state text not null default 'active' check (state in ('active','offboarding','ended')),
      revision integer not null default 0 check (revision >= 0),
      policy jsonb not null
    );
    create table work_audit_head (
      singleton boolean primary key default true check (singleton),
      sequence integer not null default 0,
      hash text not null default repeat('0', 64),
      acknowledged_sequence integer not null default 0,
      sending_through integer
    );
    create table work_audit_outbox (
      sequence integer primary key,
      record jsonb not null,
      hash text not null
    );
    alter table agent_operations add column work_policy_revision integer;
    alter table commands add column work_owner_stop boolean;
    alter table runner_enrollments add column work_enrollment_previewed_at timestamptz;

    create function work_audit_append(fields jsonb, moment timestamptz) returns void
    language plpgsql as $$
    declare
      head work_audit_head%rowtype;
      entry jsonb;
      canonical text;
      next_hash text;
    begin
      select * into strict head from work_audit_head where singleton for no key update;
      entry := fields || jsonb_build_object(
        'sequence', head.sequence + 1,
        'at', to_char(moment at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
      select '{' || string_agg(to_json(key)::text || ':' || value::text, ',' order by key collate "C") || '}'
        into canonical from jsonb_each(entry);
      next_hash := encode(sha256(decode(head.hash, 'hex') || convert_to(canonical, 'UTF8')), 'hex');
      insert into work_audit_outbox values (head.sequence + 1, entry, next_hash);
      update work_audit_head set sequence = head.sequence + 1, hash = next_hash where singleton;
    end
    $$;

    create function work_home_gate() returns trigger language plpgsql as $$
    declare
      current_policy work_home_policy%rowtype;
    begin
      if tg_table_name = 'auth_sessions' then
        select * into strict current_policy from work_home_policy where singleton for share;
      else
        select * into strict current_policy from work_home_policy where singleton;
      end if;
      if current_policy.state <> 'active' then
        raise exception 'Sign-in and new work on this Home have ended' using errcode = '42501';
      end if;
      if tg_table_name = 'devices' then
        if current_policy.policy->>'devices' <> 'assignee-may-enroll' and
          not exists (select 1 from devices where id = new.id and removed_at is null) and
          (new.owner_kind <> 'deployment' or exists (
            select 1 from devices where owner_kind = 'deployment' and removed_at is null
          )) then
          raise exception 'Your organization doesn''t allow this' using errcode = '42501';
        end if;
      elsif tg_table_name = 'agent_operations' then
        new.work_policy_revision := current_policy.revision;
      end if;
      return new;
    end
    $$;

    create trigger work_device_enrollment before insert on devices
      for each row execute function work_home_gate();
    create trigger work_sign_in before insert on auth_sessions
      for each row execute function work_home_gate();
    create trigger work_operation_policy before insert or update of handed_off_at, mode, grant_revision on agent_operations
      for each row execute function work_home_gate();
    alter table devices disable trigger work_device_enrollment;
    alter table auth_sessions disable trigger work_sign_in;
    alter table agent_operations disable trigger work_operation_policy;

    create function work_audit_capture() returns trigger language plpgsql as $$
    declare
      connection_fields jsonb;
      event jsonb;
      target_kind text;
      target_id text;
      tool_family text;
      switch_name text;
      changed_at timestamptz := clock_timestamp();
    begin
      case tg_table_name
      when 'agent_connections' then
        connection_fields := jsonb_build_object(
          'connectionId', new.id, 'grantId', 'grt_' || substr(new.id, 5),
          'grantRevision', new.grant_revision
        );
        if tg_op = 'INSERT' then
          event := connection_fields || jsonb_build_object('kind','connection.consent','ownerId',new.user_id);
        elsif old.revoked_at is null and new.revoked_at is not null then
          event := connection_fields || jsonb_build_object('kind','connection.disconnected');
        elsif new.cleanup_reason = 'expired' and old.cleanup_reason is distinct from new.cleanup_reason then
          event := connection_fields || jsonb_build_object('kind','connection.expired');
        elsif new."grant" is distinct from old."grant" or new.access_mode is distinct from old.access_mode then
          event := connection_fields || jsonb_build_object('kind','connection.grant_changed','ownerId',new.user_id);
        end if;
      when 'agent_sessions' then
        if tg_op = 'INSERT' or (old.status <> 'ended' and new.status = 'ended') then
          event := jsonb_build_object(
            'kind', case when tg_op = 'INSERT' then 'agent_session.started' else 'agent_session.ended' end,
            'connectionId', new.connection_id, 'agentSessionId', new.id
          );
          if tg_op = 'UPDATE' and new.end_reason = 'stopped' then
            perform work_audit_append(jsonb_build_object('kind','stop','ownerId',new.user_id), changed_at);
          end if;
        end if;
      when 'agent_operations' then
        if (new.outcome is not null and (tg_op = 'INSERT' or old.outcome is null)) or
          (new.handed_off_at is not null and (tg_op = 'INSERT' or old.handed_off_at is null)) then
          target_kind := new.target#>>'{grant,kind}';
          case target_kind
            when 'browser-profile' then
              tool_family := 'browser';
              target_id := new.target#>>'{grant,profileId}';
            when 'chrome-tabs' then
              tool_family := 'browser';
              target_id := new.target#>>'{grant,sourceId}';
            when 'device' then
              tool_family := 'computer';
              target_id := new.target#>>'{device,id}';
            when 'computer-app' then
              tool_family := 'computer';
              target_id := new.target#>>'{grant,approvalId}';
            when 'plugin' then
              tool_family := 'plugins';
              target_id := coalesce(new.target#>>'{grant,target,serverId}',
                new.target#>>'{grant,target,integrationConnectionId}', new.target#>>'{grant,target,pluginId}');
          end case;
          if target_id !~ '^([a-z][a-z0-9]{1,11}_)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
            target_id := null;
          end if;
          event := jsonb_build_object(
            'kind','operation.direct', 'connectionId',new.connection_id,'agentSessionId',new.session_id,
            'operationId',new.id,'toolFamily',tool_family,'targetKind',target_kind,'grantedResourceId',target_id,
            'effectiveMode',new.mode,'grantId','grt_' || substr(new.connection_id, 5),
            'grantRevision',new.grant_revision,'policyRevision',coalesce(new.work_policy_revision, 0),
            'decidedBy',case when new.decision->>'by' = 'person' or new.decision->>'reason' = 'person' then 'owner'
              when new.decision->>'by' in ('structural-read','full-access','reviewer') then 'policy' else 'system' end,
            'handedOffAt',to_char(new.handed_off_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'outcome',case when new.outcome is null then 'allowed' when new.outcome = 'completed' then 'completed'
              when new.outcome = 'unknown' then 'unknown'
              when new.outcome = 'refused' then case when new.decision->>'reason' = 'stopped' then 'stopped' else 'denied' end
              else 'failed' end
          );
        end if;
      when 'requests' then
        if tg_op = 'INSERT' and new.status = 'pending' then
          event := jsonb_build_object('kind','request.opened','requestId',new.id);
        elsif tg_op = 'UPDATE' and old.status = 'pending' and (new.response->>'outcome' = 'expired' or new.cancellation_reason = 'plugin-expired') then
          event := jsonb_build_object('kind','request.expired','requestId',new.id);
        elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status <> 'pending' and
          new.resolved_by is not null and new.settlement_provenance->>'kind' is distinct from 'agent' then
          event := jsonb_build_object(
            'kind','request.answered','requestId',new.id,'ownerId',new.resolved_by,
            'outcome',case new.status when 'fulfilled' then 'approved' when 'declined' then 'denied' else 'canceled' end
          );
        end if;
      when 'devices' then
        if tg_op = 'INSERT' then
          event := jsonb_build_object('kind','device.enrolled','deviceId',new.id);
        elsif old.removed_at is null and new.removed_at is not null then
          event := jsonb_build_object('kind','device.removed','deviceId',new.id);
        elsif old.access_policy is distinct from new.access_policy then
          foreach switch_name in array array['apps','browser','commands','forwarding'] loop
            if old.access_policy->switch_name is distinct from new.access_policy->switch_name then
              perform work_audit_append(jsonb_build_object(
                'kind','device.switch_changed','deviceId',new.id,'switch',switch_name,
                'enabled',case new.access_policy->>switch_name when 'true' then 'enabled' else 'disabled' end
              ), changed_at);
            end if;
          end loop;
        end if;
      when 'auth_sessions' then
        if tg_op = 'INSERT' then
          event := jsonb_build_object('kind','owner.signed_in','ownerId',new.user_id);
        elsif old.expires_at > changed_at and old.absolute_expires_at > changed_at then
          event := jsonb_build_object('kind','owner.signed_out','ownerId',old.user_id);
        end if;
      when 'commands' then
        if (new.type = 'run.interrupt' and new.work_owner_stop) or
          (new.type = 'node.stop' and new.authority_source->>'kind' = 'user-session') then
          event := jsonb_build_object('kind','stop','ownerId',new.requested_by);
        end if;
      when 'work_home_policy' then
        if old.revision < new.revision then
          event := jsonb_build_object('kind','policy.applied','revision',new.revision);
        end if;
      end case;
      if event is not null then perform work_audit_append(event, changed_at); end if;
      return null;
    end
    $$;
  `.execute(db);
  for (const [table, events] of auditTables) {
    await sql`
      create constraint trigger work_audit_capture after ${sql.raw(events)} on ${sql.table(table)}
        deferrable initially deferred for each row execute function work_audit_capture()
    `.execute(db);
    await sql`alter table ${sql.table(table)} disable trigger work_audit_capture`.execute(db);
  }
}
