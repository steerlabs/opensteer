import { type Kysely, sql } from "kysely";
import { Migrator, type Migration, type MigrationResultSet } from "kysely/migration";
import { CONTROL_PLANE_BASELINE_SCHEMA_SQL } from "./baseline-schema.js";
import type { ControlPlaneDatabaseSchema } from "./schema.js";

const baselineMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql.raw(CONTROL_PLANE_BASELINE_SCHEMA_SQL).execute(database);
  },
};

/**
 * A refused refresh now records which of the three distinct recoveries it demands, plus the
 * provider's own error code beside it. The regenerated baseline already declares both, so this
 * only catches up a database created before it; migration names are the durable key Kysely
 * records, so a released name is never renamed or renumbered.
 */
const hostedOAuthRefreshFailureClassificationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.hosted_oauth_broker_refreshes
      add column if not exists provider_error text
    `.execute(database);
    await sql`
      alter table public.hosted_oauth_broker_refreshes
      drop constraint if exists hosted_oauth_broker_refresh_provider_error_check,
      add constraint hosted_oauth_broker_refresh_provider_error_check check (
        provider_error is null or provider_error ~ '^[a-z0-9_]{1,64}$'
      )
    `.execute(database);
    await sql`
      alter table public.hosted_oauth_broker_refreshes
      drop constraint if exists hosted_oauth_broker_refresh_failure_check,
      add constraint hosted_oauth_broker_refresh_failure_check check (
        failure_code is null
        or failure_code = any (array[
          'account-link-mismatch',
          'authorization-denied',
          'catalog-version-skew',
          'client-rejected',
          'grant-rejected',
          'invalid-provider-response',
          'provider-exchange-failed',
          'scope-escalation',
          'stale-provider-application'
        ])
      )
    `.execute(database);
  },
};

export const hostIdentityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.deployments
      drop constraint if exists control_plane_deployments_epoch_check,
      drop column authority_epoch
    `.execute(database);
  },
};

export const directoryVisibilityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table if not exists public.deployment_directory_visibility (
        deployment_id text not null references public.deployments(id) on delete cascade,
        account_id text not null references public.users(id) on delete cascade,
        hidden_at timestamptz not null,
        primary key (deployment_id, account_id)
      )
    `.execute(database);
    await sql`
      create index if not exists deployment_directory_visibility_account
      on public.deployment_directory_visibility (account_id, deployment_id)
    `.execute(database);
  },
};

export const cloudDeploymentsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.cloud_deployment_operations (
        operation_id uuid primary key,
        owner_account_id text not null references public.users(id) on delete cascade,
        deployment_id text not null unique,
        name text not null check (length(name) between 1 and 120),
        canonical_origin text not null unique,
        status text not null check (status in ('creating', 'ready', 'failed', 'deleting', 'deleted')),
        desired_state text not null check (desired_state in ('present', 'deleted')),
        error text,
        sealed_material text,
        last_reconciled_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check ((status = 'deleted') = (sealed_material is null)),
        check (status <> 'ready' or desired_state = 'present'),
        check (status not in ('deleting', 'deleted') or desired_state = 'deleted')
      )
    `.execute(database);
    await sql`create index cloud_deployment_operations_owner on public.cloud_deployment_operations(owner_account_id, created_at)`.execute(
      database,
    );
  },
};

/**
 * Hiding became a member-only preference: an owner's row leaves the directory
 * through unlink, deletion or un-adoption, so any owner hide marker left by
 * the earlier "Remove from Account list" is a contradiction and goes.
 */
export const ownerDirectoryVisibilityMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      delete from public.deployment_directory_visibility visibility
      using public.deployments deployment
      where deployment.id = visibility.deployment_id
        and deployment.owner_account_id = visibility.account_id
    `.execute(database);
  },
};

/**
 * The push device registry and its delivery ledger.
 *
 * A device row is keyed by (account, installation) so a token rotation updates
 * the install that already exists; the unique (platform, token_hash) is the
 * second half of that promise — a token the operating system has handed to a
 * different install can belong to only one registration, and the newer one
 * wins by replacing the older row rather than sitting beside it.
 *
 * Deliveries carry the deployment, thread and kind because the dedupe that
 * keeps a replayed backlog off a lock screen is per (device, thread, kind)
 * inside the freshness window, not per notification alone.
 *
 * Publications are the third table because delivery rows cannot be the record
 * of what this Account did with one: a publication that reached nobody writes
 * none, and the ones it writes are cascaded away with the device. A Host
 * retrying either case would otherwise have its publication fanned out again,
 * so the receipt is kept apart from both and outlives them.
 */
export const notificationsMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      create table public.notification_devices (
        id uuid primary key,
        account_id text not null references public.users(id) on delete cascade,
        installation_id text not null check (installation_id ~ '^[A-Za-z0-9_-]{16,128}$'),
        application text not null check (application = 'mobile'),
        platform text not null check (platform in ('android', 'ios')),
        token_ciphertext text not null check (length(token_ciphertext) between 1 and 8192),
        token_hash text not null check (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
        approvals_enabled boolean not null,
        run_outcomes_enabled boolean not null,
        registered_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        disabled_at timestamptz,
        constraint notification_devices_installation_unique unique (account_id, installation_id),
        constraint notification_devices_token_unique unique (platform, token_hash)
      )
    `.execute(database);
    await sql`
      create index notification_devices_account_active
      on public.notification_devices (account_id)
      where disabled_at is null
    `.execute(database);
    await sql`
      create table public.notification_deliveries (
        notification_id text not null check (notification_id ~ '^ntf_[0-9a-f-]{36}$'),
        device_id uuid not null references public.notification_devices(id) on delete cascade,
        deployment_id text not null references public.deployments(id) on delete cascade,
        thread_id text not null,
        request_id text,
        kind text not null check (
          kind in ('request-opened', 'run-completed', 'run-failed', 'run-interrupted')
        ),
        expires_at timestamptz not null,
        status text not null check (status in ('pending', 'delivered', 'failed', 'dropped')),
        attempts integer not null default 0 check (attempts between 0 and 1000000),
        next_attempt_at timestamptz not null default now(),
        lease_token text check (lease_token is null or length(lease_token) between 32 and 128),
        lease_expires_at timestamptz,
        provider_outcome text check (
          provider_outcome is null or length(provider_outcome) between 1 and 512
        ),
        created_at timestamptz not null default now(),
        completed_at timestamptz,
        primary key (notification_id, device_id),
        constraint notification_deliveries_lease_check check (
          (lease_token is null) = (lease_expires_at is null)
        ),
        constraint notification_deliveries_completion_check check (
          (status = 'pending') = (completed_at is null)
        )
      )
    `.execute(database);
    await sql`
      create index notification_deliveries_due
      on public.notification_deliveries (next_attempt_at, created_at)
      where status = 'pending'
    `.execute(database);
    // The replay guard: at most one live notification per device, Thread and
    // kind. A Host that re-publishes a backlog therefore refreshes one row
    // instead of stacking alerts on a lock screen.
    await sql`
      create index notification_deliveries_collapse
      on public.notification_deliveries (device_id, thread_id, kind, expires_at)
    `.execute(database);
    await sql`
      create table public.notification_publications (
        deployment_id text not null references public.deployments(id) on delete cascade,
        notification_id text not null check (notification_id ~ '^ntf_[0-9a-f-]{36}$'),
        thread_id text not null,
        kind text not null check (
          kind in ('request-opened', 'run-completed', 'run-failed', 'run-interrupted')
        ),
        deliveries integer not null default 0 check (deliveries between 0 and 4096),
        received_at timestamptz not null default now(),
        primary key (deployment_id, notification_id)
      )
    `.execute(database);
    await sql`
      create index notification_publications_received
      on public.notification_publications (deployment_id, received_at)
    `.execute(database);
  },
};

/**
 * The hosting template split into a pinned placement and a live release, so a present deployment
 * converges to the release its Account runs, and the page can say what it is waiting on.
 */
export const cloudDeploymentReleaseMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.cloud_deployment_operations
        add column progress text,
        add column applied_release text
    `.execute(database);
  },
};

/** Persist the initiating Account member so revocation fences unfinished OAuth. */
export const hostedOAuthAccountSubjectMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.hosted_oauth_broker_attempts add column if not exists account_subject text;
      alter table public.hosted_oauth_broker_refreshes add column if not exists account_subject text
    `.execute(database);
    await sql`
      update public.hosted_oauth_broker_attempts attempt
      set account_subject = deployment.owner_account_id
      from public.deployments deployment
      where deployment.id = attempt.deployment_id
    `.execute(database);
    await sql`
      update public.hosted_oauth_broker_refreshes refresh
      set account_subject = deployment.owner_account_id
      from public.deployments deployment
      where deployment.id = refresh.deployment_id
    `.execute(database);
    await sql`
      alter table public.hosted_oauth_broker_attempts alter column account_subject set not null;
      alter table public.hosted_oauth_broker_refreshes alter column account_subject set not null
    `.execute(database);
    await sql`
      alter table public.hosted_oauth_broker_attempts
        drop constraint if exists hosted_oauth_broker_attempts_account_subject_fkey,
        add constraint hosted_oauth_broker_attempts_account_subject_fkey
        foreign key (account_subject) references public.users(id) on delete cascade;
      alter table public.hosted_oauth_broker_refreshes
        drop constraint if exists hosted_oauth_broker_refreshes_account_subject_fkey,
        add constraint hosted_oauth_broker_refreshes_account_subject_fkey
        foreign key (account_subject) references public.users(id) on delete cascade
    `.execute(database);
  },
};

/** Keep exact report destinations through the Account's durable push queue. */
export const reportNotificationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.notification_deliveries
        add column message_id text,
        drop constraint notification_deliveries_kind_check,
        add constraint notification_deliveries_kind_check check (
          kind in ('request-opened', 'run-completed', 'run-failed', 'run-interrupted', 'report-published')
        );
      alter table public.notification_publications
        drop constraint notification_publications_kind_check,
        add constraint notification_publications_kind_check check (
          kind in ('request-opened', 'run-completed', 'run-failed', 'run-interrupted', 'report-published')
        );
    `.execute(database);
  },
};

/**
 * Hosts from Host API epoch 30 publish replies; older Hosts keep publishing the
 * kinds they always did, so those stay valid beside it.
 *
 * A newer alert now replaces only an older one for the same device, Thread and
 * kind that is still waiting to be sent, instead of suppressing everything for
 * the rest of the window, so the index that served the window check is
 * replaced by one over pending rows alone.
 */
export const replyNotificationMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.notification_deliveries
        drop constraint notification_deliveries_kind_check,
        add constraint notification_deliveries_kind_check check (
          kind in (
            'reply-published', 'request-opened', 'run-failed',
            'report-published', 'run-completed', 'run-interrupted'
          )
        );
      alter table public.notification_publications
        drop constraint notification_publications_kind_check,
        add constraint notification_publications_kind_check check (
          kind in (
            'reply-published', 'request-opened', 'run-failed',
            'report-published', 'run-completed', 'run-interrupted'
          )
        );
      drop index public.notification_deliveries_collapse;
      create index notification_deliveries_pending_stream
      on public.notification_deliveries (device_id, thread_id, kind)
      where status = 'pending';
    `.execute(database);
  },
};

export const notificationDeviceEnvironmentMigration: Migration = {
  async up(database) {
    // Legacy iOS tokens have no known environment. Re-registration must supply
    // the entitlement rather than sending them to an invented APNs origin.
    await sql`delete from public.notification_devices where platform = 'ios'`.execute(database);
    await sql`
      alter table public.notification_devices
        add column aps_environment text,
        add constraint notification_devices_aps_environment_check check (
          (platform = 'ios' and aps_environment is not null and aps_environment in ('development', 'production'))
          or (platform = 'android' and aps_environment is null)
        );
      drop index public.notification_deliveries_pending_stream;
    `.execute(database);
  },
};

/**
 * Columns and tables Better Auth 1.7's JWT and OAuth provider plugins read and
 * write. The provider replaced a client's `public`/`type` pair with
 * `application_type`; a public client still has to use PKCE.
 */
export const betterAuth17Migration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table public.auth_jwks add column alg text, add column crv text;

      alter table public.oauth_clients
        add column client_discovery_id text,
        add column client_credentials_scopes jsonb default '[]'::jsonb,
        add column backchannel_logout_uri text,
        add column backchannel_logout_session_required boolean,
        add column application_type text,
        add column jwks text,
        add column jwks_uri text,
        add column dpop_bound_access_tokens boolean default false,
        drop constraint control_plane_oauth_clients_public_pkce_check;
      update public.oauth_clients set application_type = case
        when type = 'native' then 'native'
        when type in ('web', 'user-agent-based') then 'web'
      end;
      alter table public.oauth_clients
        drop column public,
        drop column type,
        add constraint control_plane_oauth_clients_public_pkce_check check (
          token_endpoint_auth_method is distinct from 'none'
          or (coalesce(require_pkce, false) and application_type in ('native', 'web'))
        );

      alter table public.oauth_refresh_token
        add column authorization_code_id text,
        add column resources jsonb,
        add column requested_user_info_claims jsonb,
        add column rotated_at timestamptz,
        add column rotation_replay_response text,
        add column rotation_replay_expires_at timestamptz,
        add column confirmation jsonb;
      create index oauth_refresh_token_authorization_code_id
        on public.oauth_refresh_token (authorization_code_id);

      alter table public.oauth_access_tokens
        add column authorization_code_id text,
        add column resources jsonb,
        add column requested_user_info_claims jsonb,
        add column revoked timestamptz,
        add column confirmation jsonb;
      create index oauth_access_tokens_authorization_code_id
        on public.oauth_access_tokens (authorization_code_id);

      alter table public.oauth_consents
        add column resources jsonb,
        add column requested_user_info_claims jsonb;

      create table public.oauth_resource (
        id text primary key,
        identifier text not null unique,
        name text not null,
        access_token_ttl integer,
        refresh_token_ttl integer,
        signing_algorithm text,
        signing_key_id text,
        allowed_scopes jsonb,
        custom_claims jsonb,
        dpop_bound_access_tokens_required boolean default false,
        disabled boolean default false,
        created_at timestamptz,
        updated_at timestamptz,
        policy_version integer default 1,
        metadata jsonb
      );
      create table public.oauth_client_resource (
        id text primary key,
        client_id text not null
          references public.oauth_clients (client_id) on delete cascade,
        resource_id text not null
          references public.oauth_resource (identifier) on delete cascade,
        metadata jsonb,
        created_at timestamptz,
        unique (client_id, resource_id)
      );
      create index oauth_client_resource_resource_id
        on public.oauth_client_resource (resource_id);
      create table public.oauth_client_assertion (
        id text primary key,
        expires_at timestamptz not null
      );
    `.execute(database);
  },
};

const migrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "0001_baseline": baselineMigration,
      "0002_hosted_oauth_refresh_failure_classification":
        hostedOAuthRefreshFailureClassificationMigration,
      "0003_host_identity": hostIdentityMigration,
      "0004_directory_visibility": directoryVisibilityMigration,
      "0005_cloud_deployments": cloudDeploymentsMigration,
      "0006_owner_directory_visibility": ownerDirectoryVisibilityMigration,
      "0007_cloud_deployment_release": cloudDeploymentReleaseMigration,
      "0008_notifications": notificationsMigration,
      "0009_hosted_oauth_account_subject": hostedOAuthAccountSubjectMigration,
      "0010_report_notifications": reportNotificationMigration,
      "0011_reply_notifications": replyNotificationMigration,
      "0012_notification_device_environment": notificationDeviceEnvironmentMigration,
      "0013_better_auth_17": betterAuth17Migration,
    };
  },
};

export async function migrateControlPlaneToLatest(
  database: Kysely<ControlPlaneDatabaseSchema>,
): Promise<MigrationResultSet> {
  const migrator = new Migrator({ db: database, provider: migrationProvider });
  const result = await migrator.migrateToLatest();
  assertMigrationSucceeded(result);
  return result;
}

function assertMigrationSucceeded(result: MigrationResultSet): void {
  const failure = result.results?.find((entry) => entry.status === "Error");
  if (result.error || failure) {
    throw new Error(
      `Control-plane migration failed${failure ? ` at ${failure.migrationName}` : ""}`,
      { cause: result.error },
    );
  }
}
