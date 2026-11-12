export const PERSONAL_TEAM_BASELINE_SQL = String.raw`
create table team_members (
  "user_id" text not null,
  "handle" text not null,
  "role" text not null check (role in ('owner', 'admin', 'member')),
  "state" text not null check (state in ('active', 'removed')),
  "generation" bigint not null default 1,
  "joined_at" timestamptz not null default now(),
  "changed_at" timestamptz not null default now(),
  "changed_by" text,
  primary key ("user_id")
);

create table team_access_state (
  "singleton_key" text not null check (singleton_key in ('team')),
  "revision" bigint not null default 0,
  "directory_revision" bigint not null default 0,
  "updated_at" timestamptz not null default now(),
  primary key ("singleton_key")
);

create table team_groups (
  "id" text not null,
  "name" text not null,
  "normalized_name" text not null,
  "created_by" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz,
  primary key ("id")
);

create table team_group_people (
  "group_id" text not null,
  "user_id" text not null,
  "added_by" text not null,
  "added_at" timestamptz not null default now(),
  primary key ("group_id", "user_id")
);

create table team_group_edges (
  "parent_group_id" text not null,
  "child_group_id" text not null,
  "added_by" text not null,
  "added_at" timestamptz not null default now(),
  primary key ("parent_group_id", "child_group_id")
);

create table team_invites (
  "id" text not null,
  "selector" text not null,
  "verifier_hash" text not null,
  "max_uses" integer not null,
  "used_count" integer not null default 0,
  "expires_at" timestamptz not null default now(),
  "revoked_at" timestamptz,
  "created_by" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create table team_invite_uses (
  "invite_id" text not null,
  "user_id" text not null,
  "accepted_at" timestamptz not null default now(),
  "member_generation" bigint not null,
  primary key ("invite_id", "user_id")
);

create table team_audit (
  "id" bigint generated always as identity not null,
  "occurred_at" timestamptz not null default now(),
  "actor_user_id" text,
  "actor_kind" text not null check (actor_kind in ('human', 'agent', 'system')),
  "link_id" text,
  "agent_request_id" text,
  "action" text not null,
  "resource_kind" text not null,
  "resource_id" text,
  "channel_id" text,
  "outcome" text not null check (outcome in ('allowed', 'denied')),
  "metadata" jsonb not null,
  primary key ("id")
);

create table team_notices (
  "id" text not null,
  "recipient_user_id" text not null,
  "kind" text not null check (kind in ('admin-self-added')),
  "resource_kind" text not null check (resource_kind in ('channel', 'topic')),
  "resource_id" text not null,
  "audit_id" bigint not null,
  "dedupe_key" text not null,
  "created_at" timestamptz not null default now(),
  "read_at" timestamptz,
  primary key ("id")
);

create table team_channels (
  "id" text not null,
  "kind" text not null,
  "name" text,
  "normalized_name" text,
  "created_by" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "archived_at" timestamptz,
  "people_only" boolean not null,
  "instructions_markdown" text not null,
  "instructions_revision" bigint not null default 0,
  "change_seq" bigint not null default 0,
  "latest_message_id" bigint,
  "dm_key" text,
  primary key ("id")
);

create table team_channel_members (
  "channel_id" text not null,
  "subject_kind" text not null check (subject_kind in ('person', 'group')),
  "subject_id" text not null,
  "level" text not null check (level in ('read', 'post')),
  "manage" boolean not null,
  "added_by" text not null,
  "added_at" timestamptz not null default now(),
  primary key ("channel_id", "subject_kind", "subject_id")
);

create table team_channel_member_state (
  "channel_id" text not null,
  "user_id" text not null,
  "last_read_message_id" bigint,
  "notification_level" text not null check (notification_level in ('mentions', 'all', 'muted')),
  "updated_at" timestamptz not null default now(),
  primary key ("channel_id", "user_id")
);

create table team_messages (
  "id" bigint generated always as identity not null,
  "channel_id" text not null,
  "thread_root_id" bigint,
  "author_user_id" text not null,
  "author_kind" text not null check (author_kind in ('human', 'agent')),
  "agent_request_id" text,
  "client_message_id" text not null,
  "body_markdown" text not null,
  "plain_text" text not null,
  "search_document" tsvector generated always as (to_tsvector('simple'::regconfig, plain_text)) stored not null,
  "created_at" timestamptz not null default now(),
  "edited_at" timestamptz,
  "deleted_at" timestamptz,
  "change_seq" bigint not null,
  primary key ("id")
);

create table team_mentions (
  "message_id" bigint not null,
  "channel_id" text not null,
  "target_user_id" text not null,
  "target_kind" text not null check (target_kind in ('person', 'agent')),
  "created_at" timestamptz not null default now(),
  primary key ("message_id", "target_user_id", "target_kind")
);

create table team_message_pins (
  "message_id" bigint not null,
  "channel_id" text not null,
  "pinned_by" text not null,
  "pinned_at" timestamptz not null default now(),
  primary key ("message_id")
);

create table team_blobs (
  "id" text not null,
  "channel_id" text not null,
  "uploader_user_id" text not null,
  "uploader_kind" text not null check (uploader_kind in ('human', 'agent')),
  "agent_request_id" text,
  "client_upload_id" text not null,
  "storage_key" text not null,
  "filename" text not null,
  "declared_type" text not null,
  "verified_type" text,
  "size_bytes" bigint not null,
  "sha256" text,
  "state" text not null check (state in ('uploading', 'ready', 'deleting')),
  "received_bytes" bigint not null default 0,
  "preview_storage_key" text,
  "preview_media_type" text,
  "preview_size_bytes" bigint,
  "created_at" timestamptz not null default now(),
  "expires_at" timestamptz not null default now(),
  "completed_at" timestamptz,
  primary key ("id")
);

create table team_message_attachments (
  "message_id" bigint not null,
  "position" integer not null,
  "blob_id" text not null,
  "channel_id" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("message_id", "position")
);

create table team_topic_grants (
  "topic_id" text not null,
  "subject_kind" text not null check (subject_kind in ('person', 'group')),
  "subject_id" text not null,
  "level" text not null check (level in ('read', 'write', 'manage')),
  "added_by" text not null,
  "added_at" timestamptz not null default now(),
  primary key ("topic_id", "subject_kind", "subject_id")
);

create table team_channel_topics (
  "channel_id" text not null,
  "topic_id" text not null,
  "attached_by" text not null,
  "attached_at" timestamptz not null default now(),
  primary key ("channel_id", "topic_id")
);

create table team_outbox (
  "id" bigint generated always as identity not null,
  "kind" text not null check (kind in ('message', 'agent-status', 'notice')),
  "channel_id" text,
  "message_id" bigint,
  "notice_id" text,
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create table team_links (
  "id" text not null,
  "owner_user_id" text not null,
  "personal_deployment_id" text,
  "installation_label" text,
  "state" text not null check (state in ('pending', 'active', 'revoked')),
  "code_hash" text not null,
  "code_expires_at" timestamptz not null default now(),
  "credential_hash" text,
  "last_seen_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "revoked_at" timestamptz,
  primary key ("id")
);

create table team_agent_requests (
  "id" text not null,
  "owner_user_id" text not null,
  "channel_id" text not null,
  "thread_root_id" bigint not null,
  "trigger_message_id" bigint not null,
  "link_id" text not null,
  "state" text not null,
  "steps" jsonb not null,
  "created_at" timestamptz not null default now(),
  "accepted_at" timestamptz,
  "expires_at" timestamptz,
  "finished_at" timestamptz,
  "reply_message_id" bigint,
  "failure_code" text,
  "change_seq" bigint not null,
  primary key ("id")
);

create table personal_team_links (
  "id" text not null,
  "team_deployment_id" text not null,
  "team_host_instance_id" text not null,
  "host_key_fingerprint" text not null,
  "approved_origin" text not null,
  "authority_envelope" jsonb not null,
  "remote_link_id" text,
  "remote_owner_user_id" text,
  "state" text not null check (state in ('joining', 'active', 'unreachable', 'leaving', 'revoked', 'needs_update')),
  "credential_reference" text,
  "created_at" timestamptz not null default now(),
  "last_contact_at" timestamptz,
  primary key ("id")
);

create table personal_team_requests (
  "team_deployment_id" text not null,
  "request_id" text not null,
  "trigger_message_id" bigint not null,
  "local_task_id" text not null,
  "local_input_id" text not null,
  "run_id" text,
  "publication_state" text not null check (publication_state in ('pending', 'accepted', 'blocked')),
  "terminal_state" text check (terminal_state in ('done', 'failed', 'stopped', 'cancelled')),
  "accepted_message_id" bigint,
  "explicit_reply" boolean not null default false,
  "source" jsonb not null,
  "created_at" timestamptz not null default now(),
  "finished_at" timestamptz,
  primary key ("team_deployment_id", "request_id")
);

create table personal_settings (
  "singleton_key" text not null check (singleton_key in ('personal')),
  "owner_id" text not null,
  "agent_home_computer_id" text not null,
  "agent_home_path" text not null,
  "voice_thread_id" text,
  "time_zone" text,
  "quiet_task_days" integer not null,
  "execution_preferences" jsonb not null,
  "background_model_preferences" jsonb not null,
  primary key ("singleton_key")
);

create table deployment_event_state (
  "deployment_id" text not null,
  "sequence" bigint not null default 0,
  primary key ("deployment_id")
);

create table agent_connections (
  "id" text not null,
  "user_id" text not null,
  "label" text not null,
  "client_name" text not null,
  "access_mode" text not null,
  "resource" text not null,
  "token_hash" text,
  "created_at" timestamptz not null default now(),
  "last_used_at" timestamptz,
  "expires_at" timestamptz not null default now(),
  "revoked_at" timestamptz,
  primary key ("id")
);

create table apps (
  "tab_opened_at" timestamptz,
  "id" text not null,
  "thread_id" text not null,
  "run_id" text not null,
  "title" text not null,
  "latest_version" integer not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table app_versions (
  "app_id" text not null,
  "version" integer not null,
  "sha256" text,
  "size_bytes" integer,
  "server" jsonb,
  "created_by_run" text,
  "publish_key" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("app_id", "version")
);

create table attachments (
  "id" text not null,
  "uploader_id" text not null,
  "name" text not null,
  "media_type" text not null,
  "size_bytes" integer not null,
  "kind" text check (kind in ('image', 'file')),
  "width" integer,
  "height" integer,
  "sha256" text,
  "state" text not null check (state in ('uploading', 'ready', 'deleting')),
  "idempotency_key" text not null,
  "request_fingerprint" text not null,
  "message_id" text,
  "thread_id" text,
  "created_at" timestamptz not null default now(),
  "expires_at" timestamptz not null default now(),
  primary key ("id")
);

create table computer_use_policies (
  "deployment_id" text not null,
  "runner_id" text not null,
  "owner_user_id" text not null,
  "app_approval" text not null check (app_approval in ('ask', 'automatic')),
  "revision" integer not null,
  "updated_at" timestamptz not null default now(),
  primary key ("deployment_id", "runner_id", "owner_user_id")
);

create table computer_use_stops (
  "run_id" text not null,
  "runner_id" text not null,
  "stopped_at" timestamptz not null default now(),
  primary key ("run_id", "runner_id")
);

create table computer_app_setup_requests (
  "kind" text not null check (kind in ('app', 'policy', 'server')),
  "policy_app_approval" text check (policy_app_approval in ('automatic')),
  "thread_id" text,
  "reason" text,
  "thread_title" text,
  "id" text not null,
  "deployment_id" text not null,
  "owner_user_id" text not null,
  "runner_id" text not null,
  "definition_id" text not null,
  "definition_digest" text not null,
  "access" text not null check (access in ('read', 'read-write')),
  "app" jsonb,
  "app_key" text,
  "server" jsonb,
  "created_at" timestamptz not null default now(),
  "expires_at" timestamptz not null default now(),
  primary key ("id")
);

create table deployments (
  "id" text not null,
  "singleton_key" text not null check (singleton_key in ('primary')),
  "active_host_instance_id" text not null,
  "canonical_origin" text not null,
  "lifecycle" text not null check (lifecycle in ('active', 'transferring', 'sealed')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deployment_shape" jsonb not null,
  primary key ("id")
);

create table users (
  "id" text not null,
  "display_name" text not null,
  "email" text not null,
  "email_verified" boolean not null,
  "image" text,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table auth_accounts (
  "id" text not null,
  "account_id" text not null,
  "provider_id" text not null,
  "user_id" text not null,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table auth_sessions (
  "member_generation" bigint,
  "id" text not null,
  "user_id" text not null,
  "token" text not null,
  "expires_at" timestamp with time zone not null default now(),
  "ip_address" text,
  "user_agent" text,
  "absolute_expires_at" timestamp with time zone not null default now(),
  "device_label" text not null,
  "last_seen_at" timestamp with time zone not null default now(),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "created_via" text,
  "account_issuer" text,
  "account_subject" text,
  "grant_id" text,
  primary key ("id")
);

create table notification_preview_keys (
  "user_id" text not null,
  "installation_id" text not null,
  "auth_session_id" text not null,
  "account_id" text not null,
  "key_id" text not null,
  "encrypted_key" bytea not null,
  "encryption_key_version" integer not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("user_id", "installation_id")
);

create table personal_remote_access (
  "singleton_key" text not null check (singleton_key in ('personal')),
  "generation" bigint not null,
  "mode" text not null check (mode in ('off', 'connect', 'private')),
  "route_origin" text,
  "updated_at" timestamp with time zone not null default now(),
  primary key ("singleton_key")
);

insert into personal_remote_access(singleton_key, generation, mode, route_origin)
values ('personal', 0, 'off', null);

create table personal_remote_account_link (
  "account_operation" jsonb,
  "singleton_key" text not null check (singleton_key in ('opensteer-account')),
  "challenge_id" text not null,
  "grant_id" text not null,
  "issuer" text not null,
  "host_credential" text not null,
  "link_generation" text not null,
  "state" text not null check (state in ('activating', 'active')),
  "subject" text not null,
  "linked_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("singleton_key")
);

create table personal_account_link_keys (
  "challenge_id" text not null,
  "public_key" text not null,
  "private_key" text not null,
  "expires_at" timestamptz not null default now(),
  primary key ("challenge_id")
);

create table personal_remote_pairing_codes (
  "credential_hash" text not null,
  "expires_at" timestamp with time zone not null default now(),
  "generation" bigint not null,
  "id" text not null,
  "issued_by_session_id" text not null,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table personal_desktop_update (
  "position" bigint generated always as identity not null,
  "id" text not null,
  "requested_by" text not null,
  "idempotency_key" text not null,
  "intent" jsonb not null,
  "state" text not null,
  "from_version" text,
  "target_version" text,
  "incarnation_id" text,
  "detail" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table personal_remote_administration (
  "position" bigint generated always as identity not null,
  "execution_id" text not null,
  "requested_intent" jsonb not null,
  "id" text not null,
  "requested_by" text not null,
  "idempotency_key" text not null,
  "intent" jsonb not null,
  "state" text not null check (state in ('pending', 'running', 'succeeded', 'failed')),
  "detail" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table personal_remote_sessions (
  "auth_session_id" text not null,
  "delivery" text not null,
  "route_generation" bigint not null,
  "route_kind" text not null check (route_kind in ('connect', 'private')),
  "route_origin" text not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("auth_session_id")
);

create table personal_remote_session_grant_uses (
  "grant_id" text not null,
  "generation" bigint not null,
  "consumed_at" timestamp with time zone not null default now(),
  primary key ("grant_id")
);

create table auth_verifications (
  "id" text not null,
  "identifier" text not null,
  "value" text not null,
  "expires_at" timestamp with time zone not null default now(),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table auth_rate_limits (
  "id" text not null,
  "key" text not null,
  "count" integer not null,
  "last_request" bigint not null,
  primary key ("id")
);

create table auth_sso_providers (
  "id" text not null,
  "issuer" text not null,
  "oidc_config" text,
  "saml_config" text,
  "user_id" text not null,
  "provider_id" text not null,
  "organization_id" text,
  "domain" text not null,
  primary key ("id")
);

create table auth_admissions (
  "id" text not null,
  "purpose" text not null check (purpose in ('setup', 'recovery', 'invitation')),
  "subject_selector" text not null,
  "browser_nonce_hash" text not null,
  "reserved_email" text,
  "reserved_at" timestamp with time zone,
  "expires_at" timestamp with time zone not null default now(),
  "consumed_at" timestamp with time zone,
  "consumed_by" text,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table auth_jwks (
  "id" text not null,
  "public_key" text not null,
  "private_key" text not null,
  "created_at" timestamp with time zone not null default now(),
  "expires_at" timestamp with time zone,
  "alg" text,
  "crv" text,
  primary key ("id")
);

-- Better Auth's Kysely adapter serializes OAuth string arrays as JSON on PostgreSQL.
create table host_oauth_resources (
  "id" text not null,
  "identifier" text not null,
  "name" text not null,
  "access_token_ttl" integer,
  "refresh_token_ttl" integer,
  "signing_algorithm" text,
  "signing_key_id" text,
  "allowed_scopes" jsonb,
  "custom_claims" jsonb,
  "dpop_bound_access_tokens_required" boolean,
  "disabled" boolean,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "policy_version" integer,
  "metadata" jsonb,
  primary key ("id")
);

create table host_oauth_client_resources (
  "id" text not null,
  "client_id" text not null,
  "resource_id" text not null,
  "metadata" jsonb,
  "created_at" timestamptz,
  primary key ("id")
);

create table host_oauth_client_assertions (
  "id" text not null,
  "expires_at" timestamptz not null default now(),
  primary key ("id")
);

create table host_oauth_clients (
  "id" text not null,
  "client_id" text not null,
  "client_secret" text,
  "disabled" boolean not null,
  "skip_consent" boolean,
  "enable_end_session" boolean,
  "subject_type" text,
  "scopes" jsonb,
  "user_id" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "software_id" text,
  "software_version" text,
  "software_statement" text,
  "redirect_uris" jsonb not null,
  "post_logout_redirect_uris" jsonb,
  "token_endpoint_auth_method" text,
  "grant_types" jsonb,
  "response_types" jsonb,
  "require_pkce" boolean,
  "reference_id" text,
  "metadata" jsonb,
  "client_discovery_id" text,
  "client_credentials_scopes" jsonb,
  "backchannel_logout_uri" text,
  "backchannel_logout_session_required" boolean,
  "application_type" text,
  "jwks" text,
  "jwks_uri" text,
  "dpop_bound_access_tokens" boolean,
  primary key ("id")
);

create table host_oauth_refresh_tokens (
  "id" text not null,
  "token" text not null,
  "client_id" text not null,
  "session_id" text not null,
  "user_id" text not null,
  "reference_id" text,
  "expires_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  "revoked" timestamptz,
  "auth_time" timestamptz,
  "scopes" jsonb not null,
  "authorization_code_id" text,
  "resources" jsonb,
  "requested_user_info_claims" jsonb,
  "rotated_at" timestamptz,
  "rotation_replay_response" text,
  "rotation_replay_expires_at" timestamptz,
  "confirmation" jsonb,
  primary key ("id")
);

create table host_oauth_access_tokens (
  "id" text not null,
  "token" text not null,
  "client_id" text not null,
  "session_id" text not null,
  "user_id" text,
  "reference_id" text,
  "refresh_id" text,
  "expires_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  "scopes" jsonb not null,
  "authorization_code_id" text,
  "resources" jsonb,
  "requested_user_info_claims" jsonb,
  "revoked" timestamptz,
  "confirmation" jsonb,
  primary key ("id")
);

create table host_oauth_consents (
  "id" text not null,
  "client_id" text not null,
  "user_id" text,
  "reference_id" text,
  "scopes" jsonb not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "resources" jsonb,
  "requested_user_info_claims" jsonb,
  primary key ("id")
);

create table account_directory_provider (
  "singleton_key" text not null check (singleton_key in ('opensteer-account')),
  "provider_id" text not null,
  "issuer" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("singleton_key")
);

create table account_directory_projections (
  "provider_id" text not null,
  "account_id" text not null,
  "user_id" text not null,
  "present" boolean not null,
  "generation" bigint not null,
  "published_generation" bigint not null,
  "attempts" integer not null default 0,
  "next_attempt_at" timestamp with time zone not null default now(),
  "last_error" text,
  "lease_token" text,
  "lease_expires_at" timestamp with time zone,
  "updated_at" timestamp with time zone not null default now(),
  primary key ("provider_id", "account_id")
);

create function opensteer_set_account_directory_projection(
  target_provider_id text, target_account_id text, target_user_id text, target_present boolean
) returns void language plpgsql as $$
begin
  if not exists (select 1 from account_directory_provider where provider_id=target_provider_id) then
    return;
  end if;
  insert into account_directory_projections(provider_id,account_id,user_id,present,generation,published_generation)
  values(target_provider_id,target_account_id,target_user_id,target_present,1,0)
  on conflict(provider_id,account_id) do update
  set user_id=excluded.user_id,present=excluded.present,
      generation=account_directory_projections.generation+1,attempts=0,next_attempt_at=now(),
      last_error=null,lease_token=null,lease_expires_at=null,updated_at=now()
  where account_directory_projections.present is distinct from excluded.present
     or account_directory_projections.user_id is distinct from excluded.user_id;
end;
$$;

create function opensteer_refresh_account_directory_user(target_user_id text)
returns void language plpgsql as $$
declare
  target_present boolean;
  account record;
begin
  select exists (
    select 1 from users u cross join deployments d
    where u.id=target_user_id and u.disabled_at is null and d.singleton_key='primary'
      and ((d.deployment_shape->>'kind'='personal' and u.id=(
        select id from users order by created_at limit 1
      )) or (d.deployment_shape->>'kind'='team' and exists (
        select 1 from team_members m where m.user_id=u.id and m.state='active'
      )))
  ) into target_present;
  for account in
    select a.provider_id,a.account_id from auth_accounts a
    join account_directory_provider p on p.provider_id=a.provider_id
    where a.user_id=target_user_id and a.password is null
  loop
    if target_present or exists (
      select 1 from account_directory_projections p
      where p.provider_id=account.provider_id and p.account_id=account.account_id
    ) then
      perform opensteer_set_account_directory_projection(account.provider_id,account.account_id,target_user_id,target_present);
    end if;
  end loop;
end;
$$;

create function opensteer_project_auth_account_change() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if old.password is null then
      perform opensteer_set_account_directory_projection(old.provider_id,old.account_id,old.user_id,false);
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.password is null and (
    row(old.provider_id,old.account_id,old.user_id) is distinct from row(new.provider_id,new.account_id,new.user_id)
    or new.password is not null
  ) then
    perform opensteer_set_account_directory_projection(old.provider_id,old.account_id,old.user_id,false);
  end if;
  perform opensteer_refresh_account_directory_user(new.user_id);
  return new;
end;
$$;

create trigger auth_accounts_account_directory_projection after insert or update or delete on auth_accounts
  for each row execute function opensteer_project_auth_account_change();

create function opensteer_project_user_change() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    update account_directory_projections set present=false,generation=generation+1,attempts=0,
      next_attempt_at=now(),last_error=null,lease_token=null,lease_expires_at=null,updated_at=now()
    where user_id=old.id and present;
    return old;
  end if;
  perform opensteer_refresh_account_directory_user(new.id);
  return new;
end;
$$;

create trigger users_account_directory_projection_update after update of disabled_at on users
  for each row execute function opensteer_project_user_change();
create trigger users_account_directory_projection_delete before delete on users
  for each row execute function opensteer_project_user_change();

create table host_account_adoption_proofs (
  "id" text not null,
  "credential_hash" text not null,
  "deployment_id" text not null,
  "host_instance_id" text not null,
  "host_key_fingerprint" text not null,
  "canonical_origin" text not null,
  "authorized_by_user_id" text not null,
  "authorized_by_session_id" text not null,
  "expected_issuer" text,
  "expected_subject" text,
  "expires_at" timestamp with time zone not null default now(),
  "consumed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table owner_enrollments (
  "id" text not null,
  "token_hash" text not null,
  "kind" text not null check (kind in ('initial', 'recovery')),
  "idempotency_key" text not null,
  "request_fingerprint" text not null,
  "expires_at" timestamp with time zone not null default now(),
  "consumed_at" timestamp with time zone,
  "consumed_by" text,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table runners (
  "device_profile" text check (device_profile in ('iphone')),
  "id" text not null,
  "owner_kind" text not null check (owner_kind in ('deployment', 'user')),
  "owner_user_id" text,
  "name" text not null,
  "update_required" text check (update_required in ('agent-phone-outdated', 'runner-outdated')),
  "kind" text not null check (kind in ('main', 'local', 'managed')),
  "public_key_pem" text not null,
  "public_key_fingerprint" text not null,
  "enrollment_token_hash" text not null,
  "capabilities" jsonb not null,
  "allowed_modules" jsonb not null,
  "module_descriptors" jsonb not null,
  "access_policy" jsonb not null,
  "access_policy_revision" integer not null,
  "device" jsonb,
  "connection_generation" bigint not null,
  "max_concurrent_runs" integer,
  "enrolled_at" timestamp with time zone not null default now(),
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "tab_opened_at" timestamptz,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table runner_enrollments (
  "issuance_modules" jsonb,
  "device_profile" text check (device_profile in ('iphone')),
  "id" text not null,
  "name" text not null,
  "token_hash" text not null,
  "allowed_modules" jsonb not null,
  "created_by" text,
  "owner_kind" text not null check (owner_kind in ('deployment', 'user')),
  "owner_user_id" text,
  "idempotency_key" text not null,
  "request_fingerprint" text not null,
  "runner_kind" text not null check (runner_kind in ('main', 'local', 'managed')),
  "expires_at" timestamp with time zone not null default now(),
  "consumed_at" timestamp with time zone,
  "runner_id" text,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table machine_access_sessions (
  "id" text not null,
  "runner_id" text not null,
  "run_id" text not null,
  "thread_id" text not null,
  "requested_by" text not null,
  "caller_runner_id" text not null,
  "caller_machine_name" text not null,
  "thread_title" text not null,
  "policy_revision" integer not null,
  "state" text not null check (state in ('pending', 'active', 'ended')),
  "started_at" timestamp with time zone not null default now(),
  "ended_at" timestamp with time zone,
  "end_reason" text,
  "bytes_in" bigint not null,
  "bytes_out" bigint not null,
  primary key ("id")
);

create table machine_access_events (
  "id" bigint generated always as identity,
  "session_id" text not null,
  "at" timestamp with time zone not null default now(),
  "event" jsonb not null,
  primary key ("id")
);

create table execution_environments (
  "id" text not null,
  "name" text not null,
  "kind" text not null check (kind in ('main', 'local', 'managed')),
  "runner_id" text,
  "capabilities" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table harness_instances (
  "id" text not null,
  "environment_id" text not null,
  "driver_kind" text not null,
  "name" text not null,
  "config" jsonb not null,
  "runtime_revision" integer not null,
  "state_kind" text not null,
  "enabled" boolean not null,
  "is_default" boolean not null,
  "source_id" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "removed_at" timestamp with time zone,
  primary key ("id")
);

create table harness_catalogs (
  "environment_id" text not null,
  "harness_instance_id" text not null,
  "catalog" jsonb not null,
  "captured_at" timestamp with time zone not null default now(),
  primary key ("environment_id", "harness_instance_id")
);

create table security_audit (
  "id" text not null,
  "actor_user_id" text,
  "actor_session_id" text,
  "action" text not null,
  "target_type" text not null,
  "target_id" text,
  "request_id" text,
  "metadata" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table thread_state_pending (
  "thread_id" text not null,
  "requested_at" timestamptz not null default now(),
  primary key ("thread_id")
);

create table threads (
  "asked_at" timestamptz not null default now(),
  "done_at" timestamptz,
  "done_reason" text,
  "pending_request_count" integer not null default 0,
  "projected_input_queue_paused" boolean not null default false,
  "input_queue_paused" boolean not null default false,
  "input_queue_paused_by" text,
  "access_mode" text not null default 'full-access',
  "specialist_id" text,
  "purpose" text not null,
  "team_id" text,
  "channel_id" text,
  "thread_root_id" bigint,
  "id" text not null,
  "lineage_root_thread_id" text not null,
  "parent_thread_id" text,
  "listed" boolean not null,
  "title" text not null,
  "title_source" text not null default 'provisional',
  "icon" text,
  "icon_source" text not null,
  "color" text not null,
  "environment_id" text not null,
  "harness_instance_id" text not null,
  "model_selection" jsonb not null,
  "status" text not null default 'idle' check (status in ('idle', 'running', 'waiting', 'failed', 'archived')),
  "created_by" text not null,
  "created_by_principal_id" text not null,
  "next_message_sequence" bigint not null default 0,
  "next_run_ordinal" integer not null default 0,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table messages (
  "addressed_to_user_id" text,
  "quote" jsonb,
  "author" jsonb not null,
  "id" text not null,
  "thread_id" text not null,
  "run_id" text,
  "sequence" bigint not null,
  "kind" text not null,
  "actor_principal_id" text not null,
  "content" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table thread_inputs (
  "team_request_id" text,
  "team_source" jsonb,
  "assignment_id" text,
  "actor_principal_id" text not null,
  "authority_source" jsonb not null,
  "cancel_reason" text,
  "causal_chain_id" text not null,
  "delivered_at" timestamp with time zone,
  "idempotency_key" text not null,
  "message_id" text not null,
  "policy" text not null,
  "queue_rank" bigint not null,
  "reply_target" jsonb,
  "request_fingerprint" text not null,
  "requested_by" text not null,
  "run_id" text,
  "state" text not null,
  "steer_command_id" text,
  "thread_id" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("message_id")
);

create table causal_chains (
  "created_at" timestamp with time zone not null default now(),
  "id" text not null,
  "max_delegations" integer not null,
  "max_autonomous_runs" integer not null,
  "root_message_id" text,
  "root_occurrence_id" text,
  "root_watch_activation_id" text,
  "root_watch_observation_id" text,
  "used_delegations" integer not null,
  "used_autonomous_runs" integer not null,
  primary key ("id")
);

create table runs (
  "team_request_id" text,
  "person_waited" boolean not null default false,
  "done_when_finished" boolean not null default false,
  "assignment_id" text,
  "initial_context" jsonb,
  "provider_session_id" text,
  "report_context" jsonb,
  "access_mode" text not null,
  "activation_input_id" text not null,
  "causal_chain_id" text not null,
  "id" text not null,
  "thread_id" text not null,
  "environment_id" text not null,
  "failure" jsonb,
  "harness_instance_id" text not null,
  "model_selection" jsonb not null,
  "reply_target" jsonb,
  "requested_by" text not null,
  "actor_principal_id" text not null,
  "authority_source" jsonb not null,
  "run_ordinal" integer not null,
  "seed_input_id" text not null,
  "voice_session_id" text,
  "next_runner_ordinal" integer not null default 0,
  "binding_generation" integer,
  "phase" text not null default 'turn' check (phase in ('turn', 'background')),
  "background_deadline_at" timestamptz,
  "turn_reply_message_id" text,
  "status" text not null check (status in ('queued', 'starting', 'running', 'waiting', 'completed', 'failed', 'interrupted')),
  "created_at" timestamp with time zone not null default now(),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "input_tokens" bigint,
  "output_tokens" bigint,
  "cached_input_tokens" bigint,
  "cache_write_tokens" bigint,
  "reasoning_tokens" bigint,
  "cost_usd" numeric(18,8),
  constraint runs_usage_tokens_check check (
    ((input_tokens is null) = (output_tokens is null))
    and (input_tokens is not null or (
      cached_input_tokens is null and cache_write_tokens is null
      and reasoning_tokens is null and cost_usd is null
    ))
    and (input_tokens is null or (input_tokens >= 0 and input_tokens <= 9007199254740991))
    and (output_tokens is null or (output_tokens >= 0 and output_tokens <= 9007199254740991))
    and (cached_input_tokens is null
      or (cached_input_tokens >= 0 and cached_input_tokens <= 9007199254740991))
    and (cache_write_tokens is null
      or (cache_write_tokens >= 0 and cache_write_tokens <= 9007199254740991))
    and (reasoning_tokens is null
      or (reasoning_tokens >= 0 and reasoning_tokens <= 9007199254740991))
  ),
  constraint runs_cost_usd_check check (cost_usd is null or cost_usd >= 0),
  primary key ("id")
);

create table run_attempts (
  "id" text not null,
  "run_id" text not null,
  "ordinal" integer not null,
  "reason" text not null check (reason in ('initial', 'steer_restart', 'recovery')),
  "status" text not null check (status in ('current', 'superseded')),
  "started_at" timestamptz not null default now(),
  "superseded_at" timestamptz,
  "superseded_by" text,
  "binding_generation" integer,
  "runner_id" text,
  "runner_boot_id" text,
  "model_selection" jsonb,
  "dispatched_at" timestamptz,
  "engine_start" text check (engine_start in ('cold', 'warm')),
  "first_event_at" timestamptz,
  "ended_at" timestamptz,
  "outcome" text check (outcome in ('completed', 'failed', 'interrupted', 'cancelled')),
  "input_tokens" bigint,
  "output_tokens" bigint,
  "cached_input_tokens" bigint,
  "cache_write_tokens" bigint,
  "reasoning_tokens" bigint,
  "cost_usd" numeric(18,8),
  primary key ("id")
);

create table execution_nodes (
  "stop_supported" boolean not null default false,
  "stopping" boolean not null default false,
  "id" text not null,
  "run_id" text not null,
  "attempt_id" text not null,
  "parent_node_id" text,
  "kind" text not null check (kind in ('subagent', 'task', 'workflow')),
  "effort" text,
  "phase_index" integer,
  "phases" jsonb not null,
  "title" text not null,
  "prompt" text,
  "model" text,
  "native_ref" text not null,
  "session_ref" text,
  "origin_call_id" text,
  "status" text not null check (status in ('running', 'completed', 'failed', 'interrupted')),
  "result" text,
  "started_at" timestamptz not null default now(),
  "ended_at" timestamptz,
  "input_tokens" bigint,
  "output_tokens" bigint,
  "cached_input_tokens" bigint,
  "cache_write_tokens" bigint,
  "reasoning_tokens" bigint,
  "cost_usd" numeric(18,8),
  primary key ("id")
);

create table grants (
  "id" text not null,
  "run_id" text not null,
  "attempt_id" text not null,
  "binding_generation" integer not null,
  "runner_id" text not null,
  "runner_boot_id" text not null,
  "status" text not null check (status in ('active', 'revoked')),
  "revoked_reason" text check (revoked_reason in ('stopped', 'assignment-cancelled', 'binding-replaced', 'superseded')),
  "created_at" timestamptz not null default now(),
  "revoked_at" timestamptz,
  primary key ("id")
);

create table delegations (
  "initial_input_message_id" text not null,
  "objective" text not null,
  "origin" text not null,
  "parent_assignment_id" text,
  "status" text not null,
  "result_text" text,
  "result_waits" jsonb not null default '[]'::jsonb,
  "result_run_id" text,
  "finished_at" timestamptz,
  "revision" integer not null default 1 check (revision >= 1),
  "child_run_id" text not null,
  "child_thread_id" text not null,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "id" text not null,
  "parent_occurrence_id" text,
  "parent_watch_activation_id" text,
  "parent_run_id" text,
  "parent_thread_id" text not null,
  "reply_target" jsonb,
  "result_attempted_at" timestamp with time zone,
  "result_message_id" text,
  "result_reason" text,
  "result_status" text not null,
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table requests (
  "id" text not null,
  "kind" text not null,
  "mode" text not null,
  "status" text not null,
  "originating_thread_id" text not null,
  "originating_run_id" text,
  "originating_occurrence_id" text,
  "originating_node_id" text,
  "call_id" text not null,
  "requested_by" text not null,
  "required_actor" text not null,
  "presentation" jsonb not null,
  "payload" jsonb not null,
  "response" jsonb,
  "response_command_id" text,
  "cancellation_reason" text,
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  "settlement_provenance" jsonb,
  "created_at" timestamp with time zone not null default now(),
  constraint requests_origin_check check (
    num_nonnulls(originating_run_id, originating_occurrence_id) = 1
    and (mode <> 'live' or originating_run_id is not null)
  ),
  primary key ("id")
);

create table task_question_notices (
  "request_id" text not null,
  "message_id" text,
  primary key ("request_id")
);

create table integration_request_details (
  "access" text,
  "request_id" text not null,
  "installation_id" text,
  "requested_connection_id" text,
  "requested_server_id" text,
  "manifest" jsonb,
  primary key ("request_id")
);

create table request_call_joins (
  "originating_run_id" text not null,
  "call_id" text not null,
  "request_id" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("originating_run_id", "call_id")
);

create table request_continuations (
  "request_id" text not null,
  "status" text not null check (status in ('waiting', 'queued', 'undeliverable', 'delivered')),
  "attempted_at" timestamp with time zone,
  "reason" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("request_id")
);

create table triggers (
  "system_role" text check (system_role in ('memory-light', 'memory-nightly')),
  "id" text not null,
  "anchor_thread_id" text not null,
  "created_by" text not null,
  "created_by_thread_id" text,
  "idempotency_key" text not null,
  "request_fingerprint" text not null,
  "name" text not null,
  "kind" text not null check (kind in ('schedule', 'webhook', 'watch')),
  "status" text not null check (status in ('active', 'paused', 'archived')),
  "current_revision_id" text not null,
  "next_fire_at" timestamp with time zone,
  "consecutive_failures" integer not null,
  "pause_reason" text,
  "waiting_reason" text,
  "webhook_route_key" text,
  "webhook_secret_hash" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table trigger_revisions (
  "id" text not null,
  "trigger_id" text not null,
  "ordinal" integer not null,
  "source" jsonb not null,
  "program" jsonb not null,
  "created_by" text not null,
  "created_by_thread_id" text,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create sequence trigger_watch_reconcile_generation;

create table trigger_watch_activations (
  "id" text not null,
  "trigger_id" text not null,
  "revision_id" text not null,
  "environment_id" text not null,
  "anchor_thread_id" text not null,
  "created_by" text not null,
  "desired" text not null check (desired in ('active', 'stopped')),
  "observed" text not null check (observed in ('starting', 'running', 'backoff', 'expired', 'stopped')),
  "execution_generation" bigint not null,
  "runner_id" text,
  "runner_boot_id" text,
  "runner_connection_generation" bigint,
  "restart_count" integer not null,
  "consecutive_failures" integer not null,
  "healthy_since" timestamp with time zone,
  "last_exit_code" integer,
  "last_error" text,
  "stdout_tail" text not null,
  "stderr_tail" text not null,
  "lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table watch_control_requests (
  "activation_id" text not null,
  "action" text not null check (action in ('thread.delegate', 'thread.message')),
  "observation_id" text not null,
  "request_fingerprint" text not null,
  "request_id" text not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("activation_id", "request_id")
);

create table trigger_occurrences (
  "causal_chain_id" text,
  "id" text not null,
  "trigger_id" text not null,
  "revision_id" text not null,
  "command_id" text not null,
  "environment_id" text not null,
  "source_key" text not null,
  "event" jsonb not null,
  "status" text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'canceled')),
  "execution_generation" integer not null default 0,
  "runner_id" text,
  "runner_boot_id" text,
  "result" jsonb,
  "error" jsonb,
  "stdout" text not null,
  "stderr" text not null,
  "exit_code" integer,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table provider_sessions (
  "personal_context" boolean not null default true,
  "active" boolean not null,
  "state_layout" text not null check (state_layout in ('thread', 'session')),
  "id" text not null,
  "thread_id" text not null,
  "harness_instance_id" text not null,
  "continuation_identity" jsonb,
  "provider_session_reference" text,
  "runner_id" text,
  "runner_boot_id" text,
  "binding_generation" integer not null,
  "lease_token_hash" text,
  "lease_expires_at" timestamp with time zone,
  "status" text not null check (status in ('starting', 'ready', 'running', 'stopped', 'broken')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table commands (
  "id" text not null,
  "environment_id" text,
  "thread_id" text,
  "run_id" text,
  "requested_by" text not null,
  "actor_principal_id" text not null,
  "authority_source" jsonb not null,
  "idempotency_key" text not null,
  "type" text not null,
  "payload" jsonb not null,
  "encrypted_request_response" bytea,
  "request_response_key_version" integer,
  "status" text not null,
  "attempts" integer not null default 0,
  "dispatcher_id" text,
  "last_error" jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table agent_control_requests (
  "result_message_id" text,
  "run_id" text not null,
  "request_id" text not null,
  "source_thread_id" text not null,
  "action" text not null check (action in ('assignment.cancel', 'machine.full-disk-access.request', 'browser.access.request', 'browser.profile.create', 'browser.profile.list', 'browser.sign-in', 'browser.session.close', 'browser.session.list', 'browser.session.open', 'browser.tab.read', 'browser.tab.write', 'request.list', 'request.withdraw', 'thread.delegate', 'thread.list', 'thread.message', 'person.message', 'person.show', 'thread.read', 'thread.write', 'trigger.read', 'trigger.write', 'environment.list')),
  "action_class" text not null check (action_class in ('person.show', 'assignment.cancel', 'machine.full-disk-access.request', 'browser.access.request', 'browser.profile.create', 'browser.profile.list', 'browser.sign-in', 'browser.session.close', 'browser.session.list', 'browser.session.open', 'browser.tab.read', 'browser.tab.write', 'request.list', 'request.withdraw', 'thread.delegate', 'thread.list', 'thread.message', 'thread.read', 'thread.write', 'trigger.read', 'trigger.write', 'environment.list')),
  "request_fingerprint" text not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("run_id", "request_id")
);

create table trigger_control_requests (
  "occurrence_id" text not null,
  "request_id" text not null,
  "action" text not null,
  "action_class" text not null,
  "request_fingerprint" text not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("occurrence_id", "request_id")
);

create table deployment_events (
  "deployment_id" text not null,
  "node_detail_id" text,
  "sequence" bigint not null,
  "event_id" text not null,
  "thread_id" text,
  "run_id" text,
  "environment_id" text,
  "runner_ordinal" integer,
  "runner_id" text,
  "runner_boot_id" text,
  "runner_binding_generation" integer,
  "type" text not null,
  "data" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("deployment_id", "sequence")
);

create table automation_failure_notices (
  "id" text not null,
  "trigger_id" text not null,
  "occurrence_id" text unique,
  "activation_id" text,
  "reason" text not null check (reason in ('final-occurrence-failed', 'final-occurrence-interrupted', 'paused')),
  "detail" text not null,
  "attempts" integer not null default 0,
  "next_attempt_at" timestamptz not null default now(),
  "last_error" text,
  "settled_at" timestamptz,
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create table thread_read_markers (
  "thread_id" text not null,
  "user_id" text not null,
  "sequence" bigint not null,
  "updated_at" timestamptz not null default now(),
  primary key ("thread_id", "user_id")
);

create table credentials (
  "id" text not null,
  "owner_id" text not null,
  "name" text not null,
  "provider" text not null,
  "encrypted_payload" bytea not null,
  "encryption_key_version" integer not null,
  "metadata" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table credential_vault_canaries (
  "key_version" integer not null,
  "encrypted_payload" bytea not null,
  "created_at" timestamp with time zone not null default now(),
  primary key ("key_version")
);

create table browser_profiles (
  "home_runner_id" text,
  "id" text not null,
  "owner_id" text not null,
  "name" text not null,
  "storage_state" text not null default 'unbound' check (storage_state in ('unbound', 'local')),
  "storage_binding_version" integer check (storage_binding_version = 1),
  "storage_deployment_id" text,
  "storage_runner_id" text,
  "storage_instance_id" text,
  "storage_binding_id" text,
  "storage_engine" text,
  "initialized" boolean not null default false,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table browser_profile_deletions (
  "deletion_id" text not null,
  "profile_id" text not null,
  "binding_version" integer not null check (binding_version = 1),
  "deployment_id" text not null,
  "runner_id" text not null,
  "storage_instance_id" text not null,
  "binding_id" text not null,
  "engine" text not null,
  "state" text not null check (state in ('pending-computer', 'pending-restart', 'deleted', 'unconfirmed')),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz,
  primary key ("deletion_id"),
  unique ("profile_id")
);

create table browser_history_entries (
  "profile_id" text not null,
  "url" text not null,
  "origin" text not null,
  "title" text not null,
  "typed_count" integer not null,
  "visit_count" integer not null,
  "last_visit_at" timestamptz not null default now(),
  primary key ("profile_id", "url")
);

create table browser_history_icons (
  "profile_id" text not null,
  "origin" text not null,
  "icon_ref" text not null,
  "favicon" text not null,
  primary key ("profile_id", "origin")
);

create table browser_sessions (
  "tab_group_id" text not null,
  "tab_revision" integer not null default 0,
  "opener" jsonb,
  "id" text not null,
  "origin" text not null check (origin in ('agent', 'trigger', 'person')),
  "profile_id" text,
  "placement_key" text not null,
  "runner_id" text not null,
  "runtime_id" text not null,
  "state" text not null check (state in ('starting', 'ready', 'closing', 'closed', 'failed')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "closed_at" timestamp with time zone,
  primary key ("id")
);

create table personal_tabs (
  "id" text not null,
  "created_at" timestamptz not null default now(),
  "group_id" text not null,
  "session_id" text not null,
  "title" text not null,
  "url" text not null,
  "favicon" text,
  "icon_ref" text,
  "order" integer not null,
  "opener_id" text,
  "state" text not null check (state in ('suspended', 'restoring', 'live')),
  "closed_by" text,
  "closed_after_tab_id" text,
  "closed_tab_group_id" text,
  "reopened_at" timestamptz,
  "closed_at" timestamptz,
  primary key ("id")
);

create table browser_tab_layouts (
  "owner_id" text not null,
  "revision" bigint not null default 0,
  "tab_order" jsonb,
  primary key ("owner_id")
);

create table browser_tab_groups (
  "id" text not null,
  "owner_id" text not null,
  "title" text not null,
  "color" text not null,
  "collapsed" boolean not null default false,
  "created_by_thread_id" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table browser_tab_group_members (
  "owner_id" text not null,
  "tab_id" text not null,
  "group_id" text not null,
  primary key ("owner_id", "tab_id")
);

create table browser_tab_opens (
  "owner_id" text not null,
  "idempotency_key" text not null,
  "binding" jsonb not null,
  "identity_key" text,
  "runner_id" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("owner_id", "idempotency_key")
);

create table browser_session_attachments (
  "agent_binding_id" text not null,
  "owner_id" text not null,
  "session_id" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("session_id", "agent_binding_id")
);

create table browser_session_uses (
  "id" text not null,
  "session_id" text not null,
  "thread_id" text not null,
  "run_id" text,
  "tab_id" text,
  "page_title" text,
  "page_site" text,
  "first_used_at" timestamptz not null default now(),
  "last_used_at" timestamptz not null default now(),
  primary key ("id")
);

alter table browser_session_uses add constraint browser_session_uses_identity
  unique nulls not distinct (session_id, thread_id, run_id, tab_id);

create table browser_sources (
  "id" text not null,
  "owner_id" text not null,
  "name" text not null,
  "token_hash" text not null,
  "generation" bigint not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "revoked_at" timestamptz,
  "last_seen_at" timestamptz,
  primary key ("id")
);

create table browser_source_pairings (
  "code_hash" text not null,
  "owner_id" text not null,
  "created_at" timestamptz not null default now(),
  "expires_at" timestamptz not null default now(),
  "consumed_at" timestamptz,
  "canonical_origin" text not null,
  "remote_origin" text,
  "remote_generation" integer,
  primary key ("code_hash")
);

create table browser_site_grants (
  "deployment_id" text not null,
  "id" text not null,
  "owner_id" text not null,
  "site" text not null,
  "preferred_source_id" text,
  "created_at" timestamptz not null default now(),
  "last_signed_in_at" timestamptz,
  "revoked_at" timestamptz,
  primary key ("id")
);

create table browser_sign_ins (
  "owner_id" text not null,
  "id" text not null,
  "site" text not null,
  "source_id" text not null,
  "source_name" text not null,
  "session_id" text not null,
  "profile_name" text,
  "request_id" text,
  "actor" text not null check (actor in ('agent', 'owner', 'request')),
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create table credential_access_audit (
  "actor_id" text not null,
  "id" text not null,
  "credential_id" text not null,
  "connection_id" text not null,
  "runner_id" text,
  "purpose" text not null check (purpose in ('channel-delivery', 'channel-transport', 'channel-webhook')),
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table principals (
  "id" text not null,
  "kind" text not null check (kind in ('user', 'channel-identity', 'system')),
  "user_id" text,
  "display_name" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_provider_applications (
  "id" text not null,
  "provider" text not null,
  "display_name" text not null,
  "client_id" text not null,
  "encrypted_secrets" bytea not null,
  "encryption_key_version" integer not null,
  "installation_url" text,
  "owner_user_id" text,
  "revision" integer not null,
  "status" text not null check (status in ('active', 'disabled')),
  "created_by" text not null,
  "updated_by" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_auth_attempts (
  "id" text not null,
  "flow" text not null,
  "owner_user_id" text not null,
  "state_hash" text not null,
  "launch_ticket_hash" text not null,
  "browser_binding_hash" text,
  "encrypted_payload" bytea not null,
  "encryption_key_version" integer not null,
  "status" text not null check (status in ('pending', 'launched', 'claimed', 'completed', 'failed')),
  "surface" text not null check (surface in ('desktop', 'native', 'web')),
  "failure_reason" text,
  "result_connection_id" text,
  "expires_at" timestamp with time zone not null default now(),
  "launched_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_authority_generations (
  "owner_user_id" text not null,
  "generation" integer not null,
  "updated_at" timestamp with time zone not null default now(),
  primary key ("owner_user_id")
);

create table integration_authority_pending (
  "transaction_id" xid8 not null,
  "owner_user_id" text not null,
  primary key ("transaction_id", "owner_user_id")
);

create table integration_connections (
  "account_identifier" text,
  "application_source" jsonb,
  "auth_method_id" text,
  "authorization_digest" text,
  "id" text not null,
  "owner_user_id" text not null,
  "credential_id" text,
  "credential_generation" integer not null default 1 check (credential_generation > 0),
  "connection_kind" text not null check (connection_kind in ('provider-account', 'channel', 'computer', 'mcp-oauth')),
  "computer_access" text,
  "computer_app" jsonb,
  "computer_app_key" text,
  "computer_blocked_at" timestamptz,
  "computer_policy_revision" integer,
  "provider" text not null,
  "integration_server_id" text,
  "provider_application_id" text,
  "connection_method" text not null,
  "status" text not null check (status in ('pending', 'connected', 'needs-attention', 'paused', 'revoked')),
  "display_name" text not null,
  "external_identity_id" text,
  "external_tenant_id" text,
  "capabilities" jsonb not null,
  "granted_scopes" jsonb not null,
  "integration_definition_id" text,
  "runner_id" text,
  "source_connection_id" text,
  "status_detail" text,
  "status_reason" text,
  "transport_kind" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_application_source_defaults (
  "provider" text not null,
  "source_kind" text not null check (source_kind in ('deployment-oauth', 'hosted-oauth')),
  "updated_at" timestamp with time zone not null default now(),
  "updated_by" text not null,
  primary key ("provider")
);

create table integration_installations (
  "adapter_snapshot" jsonb,
  "id" text not null,
  "name" text not null,
  "title" text not null,
  "description" text not null,
  "version" text,
  "plugin_id" text,
  "source_kind" text not null check (source_kind in ('plugin', 'built-in', 'proposed', 'remote-mcp')),
  "trust" text not null check (trust in ('built-in', 'verified-publisher', 'administrator-approved')),
  "manifest" jsonb not null,
  "provenance" jsonb not null,
  "status" text not null check (status in ('active', 'disabled', 'needs-attention')),
  "revision" integer not null,
  "created_by" text,
  "updated_by" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_servers (
  "connection_requirement" jsonb not null,
  "id" text not null,
  "installation_id" text not null,
  "name" text not null,
  "transport" jsonb not null,
  "status" text not null check (status in ('active', 'disabled', 'needs-attention')),
  "status_detail" text,
  "tool_generation" integer not null,
  "approved_launch_digest" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_server_secrets (
  "server_id" text not null,
  "runner_id" text not null,
  "encrypted_payload" bytea not null,
  "updated_at" timestamptz not null default now(),
  primary key ("server_id")
);

create table integration_tools (
  "id" text not null,
  "server_id" text not null,
  "connection_id" text,
  "name" text not null,
  "title" text not null,
  "description" text not null,
  "input_schema" jsonb not null,
  "output_schema" jsonb,
  "annotations" jsonb not null,
  "schema_digest" text not null,
  "definition_names" text[] not null default '{}'::text[],
  "target" jsonb,
  "status" text not null check (status in ('active', 'disabled')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table integration_tool_definitions (
  "server_id" text not null,
  "connection_id" text,
  "definitions" jsonb not null,
  "updated_at" timestamp with time zone not null default now(),
  unique nulls not distinct ("server_id", "connection_id")
);

create table plugin_owner_settings (
  "owner_user_id" text not null,
  "target_key" text not null,
  "target" jsonb not null,
  "enabled" boolean not null,
  "revision" integer not null,
  primary key ("owner_user_id", "target_key")
);

create table plugins (
  "id" text not null,
  "name" text not null,
  "scope" text not null check (scope in ('deployment')),
  "source" jsonb not null,
  "installed_by" text,
  "current_version_id" text,
  "setup_thread_id" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

create table runner_plugin_data_removals (
  "runner_id" text not null,
  "plugin_id" text not null,
  "created_at" timestamptz not null default now(),
  primary key ("runner_id", "plugin_id")
);

create table specialists (
  "removed_at" timestamptz,
  "id" text not null,
  "plugin_id" text not null,
  "plugin_version_id" text not null,
  "owner_user_id" text not null,
  "created_by" text not null,
  "status" text not null check (status in ('pending', 'ready', 'removing', 'removal-failed')),
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("id")
);

alter table specialists add constraint specialists_plugin_owner unique (plugin_id, owner_user_id);

create table plugin_versions (
  "id" text not null,
  "plugin_id" text not null,
  "digest" text not null,
  "manifest" jsonb not null,
  "specialist_manifest" jsonb,
  "created_at" timestamptz not null default now(),
  primary key ("id")
);

create table integration_grants (
  "access" text not null,
  "id" text not null,
  "owner_user_id" text not null,
  "installation_id" text not null,
  "connection_id" text,
  "alias" text not null,
  "is_default" boolean not null,
  "created_by" text not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "revoked_at" timestamp with time zone,
  "status" text not null check (status in ('active', 'revoked')),
  primary key ("id")
);

create table mcp_oauth_credentials (
  "connection_id" text not null,
  "encrypted_state" bytea not null,
  "encryption_key_version" integer not null,
  "revision" integer not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  primary key ("connection_id")
);

create table channel_accounts (
  "id" text not null,
  "connection_id" text not null,
  "provider" text not null,
  "external_account_id" text not null,
  "display_name" text not null,
  "handle" text,
  "routing_mode" text not null check (routing_mode in ('dedicated', 'shared')),
  "status" text not null check (status in ('connected', 'needs-attention', 'paused', 'revoked')),
  "metadata" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table channel_access_grants (
  "account_id" text not null,
  "binding_id" text not null,
  "external_user_id" text not null,
  "display_name" text not null,
  "status" text not null check (status in ('pending', 'approved', 'declined', 'revoked')),
  "revision" integer not null,
  "requested_at" timestamp with time zone not null default now(),
  "request_ingress_id" text,
  "decided_at" timestamp with time zone,
  "decided_by" text,
  "updated_at" timestamp with time zone not null default now(),
  primary key ("account_id", "binding_id", "external_user_id")
);

create table channel_bindings (
  "id" text not null,
  "account_id" text not null,
  "created_by" text not null,
  "selector" jsonb not null,
  "execution_policy" jsonb not null,
  "access_policy" jsonb not null,
  "revision" integer not null,
  "status" text not null check (status in ('active', 'paused', 'revoked')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table channel_identities (
  "id" text not null,
  "account_id" text not null,
  "principal_id" text not null,
  "external_user_id" text not null,
  "display_name" text not null,
  "linked_user_id" text,
  "status" text not null check (status in ('unlinked', 'linked')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table channel_conversations (
  "personal_context" boolean not null default false,
  "id" text not null,
  "account_id" text not null,
  "provider" text not null,
  "external_account_id" text not null,
  "binding_id" text not null,
  "binding_revision" integer not null,
  "external_scope_id" text,
  "external_conversation_id" text not null,
  "external_thread_id" text,
  "conversation_type" text not null check (conversation_type in ('dm', 'group', 'channel')),
  "display_name" text,
  "active_thread_id" text,
  "provider_state" jsonb not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);



create table channel_ingress_events (
  "id" text not null,
  "account_id" text not null,
  "provider_event_id" text not null,
  "lane_key" text not null,
  "event" jsonb not null,
  "status" text not null check (status in ('pending', 'leased', 'adopted', 'ignored', 'dead')),
  "attempts" integer not null default 0,
  "claim_token_hash" text,
  "claim_owner" text,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone not null default now(),
  "last_error" text,
  "conversation_id" text,
  "message_id" text,
  "run_id" text,
  "received_at" timestamp with time zone not null default now(),
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table channel_deliveries (
  "id" text not null,
  "account_id" text not null,
  "conversation_id" text,
  "ingress_id" text,
  "message_id" text,
  "audience" text not null check (audience in ('conversation', 'actor')),
  "kind" text not null check (kind in ('reply', 'status')),
  "part" integer not null default 0,
  "part_count" integer not null default 0,
  "content" jsonb not null,
  "status" text not null check (status in ('pending', 'leased', 'attempt-started', 'sent', 'retryable-failed', 'unknown', 'dead')),
  "attempts" integer not null default 0,
  "claim_token_hash" text,
  "claim_owner" text,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone not null default now(),
  "last_error" text,
  "receipt" jsonb,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  primary key ("id")
);

create table channel_link_codes (
  "id" text not null,
  "account_id" text not null,
  "user_id" text,
  "code_hash" text not null,
  "expires_at" timestamp with time zone not null default now(),
  "consumed_at" timestamp with time zone,
  "identity_id" text not null,
  "request_ingress_id" text,
  "created_at" timestamp with time zone not null default now(),
  primary key ("id")
);

alter table apps add foreign key(thread_id) references threads(id) on delete cascade;
alter table apps add foreign key(run_id) references runs(id) on delete cascade;
alter table app_versions add foreign key(app_id) references apps(id) on delete cascade;
alter table app_versions add foreign key(created_by_run) references runs(id) on delete set null;
alter table app_versions add unique(created_by_run, publish_key);
alter table account_directory_provider add constraint account_directory_provider_provider_id_key UNIQUE (provider_id);
alter table auth_accounts add constraint auth_accounts_provider_account_unique UNIQUE (provider_id, account_id);
alter table auth_rate_limits add constraint auth_rate_limits_key_key UNIQUE (key);
alter table auth_sessions add constraint auth_sessions_token_key UNIQUE (token);
alter table auth_sso_providers add constraint auth_sso_providers_provider_id_key UNIQUE (provider_id);
alter table channel_accounts add constraint channel_accounts_connection_id_external_account_id_key UNIQUE (connection_id, external_account_id);
alter table channel_bindings add constraint channel_bindings_id_account_id_key UNIQUE (id, account_id);
alter table channel_identities add constraint channel_identities_account_id_external_user_id_key UNIQUE (account_id, external_user_id);
alter table channel_identities add constraint channel_identities_principal_id_key UNIQUE (principal_id);
alter table channel_ingress_events add constraint channel_ingress_events_account_id_provider_event_id_key UNIQUE (account_id, provider_event_id);
alter table channel_link_codes add constraint channel_link_codes_code_hash_key UNIQUE (code_hash);
alter table commands add constraint commands_request_idempotency_unique UNIQUE (requested_by, idempotency_key);
alter table delegations add constraint delegations_child_run_id_key UNIQUE (child_run_id);
create index delegations_result_message on delegations(result_message_id) where result_message_id is not null;
alter table deployments add constraint deployments_singleton_key_key UNIQUE (singleton_key);
alter table harness_instances add constraint harness_instances_id_environment_key UNIQUE (id, environment_id);
alter table host_account_adoption_proofs add constraint host_account_adoption_proofs_credential_hash_key UNIQUE (credential_hash);
alter table integration_auth_attempts add constraint integration_auth_attempts_state_hash_key UNIQUE (state_hash);
alter table integration_installations add constraint integration_installations_name_key UNIQUE (name);
alter table integration_servers add constraint integration_servers_installation_id_name_key UNIQUE (installation_id, name);
alter table integration_tool_definitions add constraint integration_tool_definitions_scope UNIQUE NULLS NOT DISTINCT (server_id, connection_id);
alter table messages add constraint messages_id_thread_unique UNIQUE (id, thread_id);
alter table owner_enrollments add constraint owner_enrollments_kind_idempotency_unique UNIQUE (kind, idempotency_key);
alter table owner_enrollments add constraint owner_enrollments_token_hash_key UNIQUE (token_hash);
alter table personal_remote_account_link add constraint personal_remote_account_link_grant_id_key UNIQUE (grant_id);
alter table personal_remote_pairing_codes add constraint personal_remote_pairing_codes_credential_hash_key UNIQUE (credential_hash);
alter table runner_enrollments add constraint runner_enrollments_owner_idempotency_unique UNIQUE (created_by, idempotency_key);
alter table runner_enrollments add constraint runner_enrollments_token_hash_key UNIQUE (token_hash);
alter table runners add constraint runners_enrollment_token_hash_key UNIQUE (enrollment_token_hash);
alter table runners add constraint runners_public_key_fingerprint_key UNIQUE (public_key_fingerprint);
alter table runs add constraint runs_id_thread_unique UNIQUE (id, thread_id);
alter table runs add constraint runs_thread_run_ordinal_unique UNIQUE (thread_id, run_ordinal);
alter table thread_inputs add constraint thread_inputs_request_idempotency_unique UNIQUE (requested_by, idempotency_key);
alter table threads add constraint threads_id_lineage_unique UNIQUE (id, lineage_root_thread_id);
alter table trigger_occurrences add constraint trigger_occurrences_command_id_key UNIQUE (command_id);
alter table trigger_occurrences add constraint trigger_occurrences_source_unique UNIQUE (trigger_id, source_key);
alter table triggers add foreign key(created_by_thread_id) references threads(id) on delete set null;
alter table trigger_revisions add foreign key(created_by_thread_id) references threads(id) on delete set null;
alter table trigger_revisions add constraint trigger_revisions_trigger_id_unique UNIQUE (trigger_id, id);
alter table trigger_revisions add constraint trigger_revisions_trigger_ordinal_unique UNIQUE (trigger_id, ordinal);
alter table triggers add constraint triggers_creator_idempotency_unique UNIQUE (created_by, idempotency_key);
alter table triggers add constraint triggers_webhook_route_key_key UNIQUE (webhook_route_key);
alter table users add constraint users_email_key UNIQUE (email);
alter table deployment_events add constraint deployment_events_event_id_key UNIQUE (event_id);
alter table agent_control_requests add constraint agent_control_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
alter table agent_control_requests add constraint agent_control_requests_source_thread_id_fkey FOREIGN KEY (source_thread_id) REFERENCES threads(id) ON DELETE CASCADE;
alter table auth_accounts add constraint auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table auth_admissions add constraint auth_admissions_consumed_by_fkey FOREIGN KEY (consumed_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table auth_sessions add constraint auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table notification_preview_keys add constraint notification_preview_keys_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;
alter table auth_sso_providers add constraint auth_sso_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table browser_profiles add constraint browser_profiles_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
alter table browser_session_attachments add constraint browser_session_attachments_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
alter table browser_session_attachments add constraint browser_session_attachments_session_id_fkey FOREIGN KEY (session_id) REFERENCES browser_sessions(id) ON DELETE CASCADE;
alter table browser_sessions add constraint browser_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table browser_sessions add constraint browser_sessions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES browser_profiles(id) ON DELETE RESTRICT;
alter table causal_chains add constraint causal_chains_root_message_fk FOREIGN KEY (root_message_id) REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED;
alter table causal_chains add constraint causal_chains_root_occurrence_fk FOREIGN KEY (root_occurrence_id) REFERENCES trigger_occurrences(id) DEFERRABLE INITIALLY DEFERRED;
alter table causal_chains add constraint causal_chains_root_watch_activation_id_fkey FOREIGN KEY (root_watch_activation_id) REFERENCES trigger_watch_activations(id) ON DELETE RESTRICT;
alter table channel_access_grants add constraint channel_access_grants_binding_account_fkey FOREIGN KEY (binding_id, account_id) REFERENCES channel_bindings(id, account_id) ON DELETE RESTRICT;
alter table channel_access_grants add constraint channel_access_grants_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table channel_access_grants add constraint channel_access_grants_request_ingress_id_fkey FOREIGN KEY (request_ingress_id) REFERENCES channel_ingress_events(id) ON DELETE SET NULL;
alter table channel_accounts add constraint channel_accounts_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT;
alter table channel_bindings add constraint channel_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT;
alter table channel_bindings add constraint channel_bindings_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table channel_conversations add constraint channel_conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT;
alter table channel_conversations add constraint channel_conversations_active_thread_id_fkey FOREIGN KEY (active_thread_id) REFERENCES threads(id) ON DELETE RESTRICT;
alter table channel_conversations add constraint channel_conversations_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES channel_bindings(id) ON DELETE RESTRICT;
alter table channel_deliveries add constraint channel_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT;
alter table channel_deliveries add constraint channel_deliveries_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES channel_conversations(id) ON DELETE RESTRICT;
alter table channel_deliveries add constraint channel_deliveries_ingress_id_fkey FOREIGN KEY (ingress_id) REFERENCES channel_ingress_events(id) ON DELETE RESTRICT;
alter table channel_deliveries add constraint channel_deliveries_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT;
alter table channel_identities add constraint channel_identities_account_id_fkey FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT;
alter table channel_identities add constraint channel_identities_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table channel_identities add constraint channel_identities_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
alter table channel_ingress_events add constraint channel_ingress_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT;
alter table channel_ingress_events add constraint channel_ingress_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES channel_conversations(id) ON DELETE RESTRICT;
alter table channel_ingress_events add constraint channel_ingress_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT;
alter table channel_ingress_events add constraint channel_ingress_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT;
alter table channel_link_codes add constraint channel_link_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT;
alter table channel_link_codes add constraint channel_link_codes_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES channel_identities(id) ON DELETE RESTRICT;
alter table channel_link_codes add constraint channel_link_codes_request_ingress_id_fkey FOREIGN KEY (request_ingress_id) REFERENCES channel_ingress_events(id) ON DELETE SET NULL;
alter table channel_link_codes add constraint channel_link_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table commands add constraint commands_actor_principal_fk FOREIGN KEY (actor_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
alter table commands add constraint commands_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table commands add constraint commands_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table commands add constraint commands_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
alter table commands add constraint commands_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
alter table credential_access_audit add constraint credential_access_audit_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table credential_access_audit add constraint credential_access_audit_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT;
alter table credential_access_audit add constraint credential_access_audit_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE RESTRICT;
alter table credentials add constraint credentials_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
alter table delegations add constraint delegations_child_run_thread_fk FOREIGN KEY (child_run_id, child_thread_id) REFERENCES runs(id, thread_id) ON DELETE RESTRICT;
alter table delegations add constraint delegations_parent_occurrence_id_fkey FOREIGN KEY (parent_occurrence_id) REFERENCES trigger_occurrences(id) ON DELETE RESTRICT;
alter table delegations add constraint delegations_parent_watch_activation_id_fkey FOREIGN KEY (parent_watch_activation_id) REFERENCES trigger_watch_activations(id) ON DELETE RESTRICT;
alter table delegations add constraint delegations_parent_run_thread_fk FOREIGN KEY (parent_run_id, parent_thread_id) REFERENCES runs(id, thread_id) ON DELETE RESTRICT;
alter table delegations add constraint delegations_parent_thread_id_fkey FOREIGN KEY (parent_thread_id) REFERENCES threads(id) ON DELETE RESTRICT;
alter table delegations add constraint delegations_result_message_thread_fk FOREIGN KEY (result_message_id, parent_thread_id) REFERENCES messages(id, thread_id) ON DELETE RESTRICT;
alter table execution_environments add constraint execution_environments_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE SET NULL;
alter table harness_catalogs add constraint harness_catalogs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE CASCADE;
alter table harness_catalogs add constraint harness_catalogs_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES harness_instances(id, environment_id) ON DELETE CASCADE;
alter table harness_instances add constraint harness_instances_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table host_account_adoption_proofs add constraint host_account_adoption_proofs_authorized_by_session_id_fkey FOREIGN KEY (authorized_by_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;
alter table host_account_adoption_proofs add constraint host_account_adoption_proofs_authorized_by_user_id_fkey FOREIGN KEY (authorized_by_user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table host_account_adoption_proofs add constraint host_account_adoption_proofs_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE;
alter table integration_application_source_defaults add constraint integration_application_source_defaults_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_auth_attempts add constraint integration_auth_attempts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_auth_attempts add constraint integration_auth_attempts_result_connection_id_fkey FOREIGN KEY (result_connection_id) REFERENCES integration_connections(id) ON DELETE SET NULL;
alter table integration_authority_generations add constraint integration_authority_generations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table integration_connections add constraint integration_connections_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table integration_connections add constraint integration_connections_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE RESTRICT;
alter table integration_connections add constraint integration_connections_integration_server_id_fkey FOREIGN KEY (integration_server_id) REFERENCES integration_servers(id) ON DELETE RESTRICT;
alter table integration_connections add constraint integration_connections_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_connections add constraint integration_connections_provider_application_id_fkey FOREIGN KEY (provider_application_id) REFERENCES integration_provider_applications(id) ON DELETE RESTRICT;
alter table integration_grants add constraint integration_grants_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT;
alter table integration_grants add constraint integration_grants_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_grants add constraint integration_grants_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES integration_installations(id) ON DELETE RESTRICT;
alter table integration_grants add constraint integration_grants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_installations add constraint integration_installations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_installations add constraint integration_installations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_provider_applications add constraint integration_provider_applications_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_provider_applications add constraint integration_provider_applications_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table integration_provider_applications add constraint integration_provider_applications_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table integration_servers add constraint integration_servers_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES integration_installations(id) ON DELETE RESTRICT;
alter table integration_tool_definitions add constraint integration_tool_definitions_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT;
alter table integration_tool_definitions add constraint integration_tool_definitions_server_id_fkey FOREIGN KEY (server_id) REFERENCES integration_servers(id) ON DELETE RESTRICT;
alter table integration_tools add constraint integration_tools_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT;
alter table integration_tools add constraint integration_tools_server_id_fkey FOREIGN KEY (server_id) REFERENCES integration_servers(id) ON DELETE RESTRICT;
alter table machine_access_events add constraint machine_access_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES machine_access_sessions(id) ON DELETE CASCADE;
alter table machine_access_sessions add constraint machine_access_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table messages add constraint messages_actor_principal_fk FOREIGN KEY (actor_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
alter table messages add constraint messages_run_thread_fk FOREIGN KEY (run_id, thread_id) REFERENCES runs(id, thread_id);
alter table messages add constraint messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
alter table owner_enrollments add constraint owner_enrollments_consumed_by_fkey FOREIGN KEY (consumed_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table personal_remote_pairing_codes add constraint personal_remote_pairing_codes_issued_by_session_id_fkey FOREIGN KEY (issued_by_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;
alter table personal_remote_sessions add constraint personal_remote_sessions_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;
alter table principals add constraint principals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table provider_sessions add constraint provider_sessions_harness_instance_id_fkey FOREIGN KEY (harness_instance_id) REFERENCES harness_instances(id) ON DELETE RESTRICT;
alter table provider_sessions add constraint provider_sessions_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table provider_sessions add constraint provider_sessions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
alter table runner_enrollments add constraint runner_enrollments_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table runner_enrollments add constraint runner_enrollments_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table runner_enrollments add constraint runner_enrollments_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table runners add constraint runners_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
alter table runs add constraint runs_activation_input_id_fkey FOREIGN KEY (activation_input_id) REFERENCES messages(id) ON DELETE RESTRICT;
alter table runs add constraint runs_activation_input_thread_fk FOREIGN KEY (activation_input_id, thread_id) REFERENCES messages(id, thread_id) ON DELETE RESTRICT;
alter table runs add constraint runs_actor_principal_fk FOREIGN KEY (actor_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
alter table runs add constraint runs_causal_chain_id_fkey FOREIGN KEY (causal_chain_id) REFERENCES causal_chains(id) ON DELETE RESTRICT;
alter table runs add constraint runs_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table runs add constraint runs_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES harness_instances(id, environment_id) ON DELETE RESTRICT;
alter table runs add constraint runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table runs add constraint runs_seed_input_id_fkey FOREIGN KEY (seed_input_id) REFERENCES messages(id) ON DELETE RESTRICT;
alter table runs add constraint runs_seed_input_thread_fk FOREIGN KEY (seed_input_id, thread_id) REFERENCES messages(id, thread_id) ON DELETE RESTRICT;
alter table runs add constraint runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
alter table thread_inputs add constraint thread_inputs_actor_principal_id_fkey FOREIGN KEY (actor_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
alter table thread_inputs add constraint thread_inputs_causal_chain_id_fkey FOREIGN KEY (causal_chain_id) REFERENCES causal_chains(id) ON DELETE RESTRICT;
alter table thread_inputs add constraint thread_inputs_message_thread_fk FOREIGN KEY (message_id, thread_id) REFERENCES messages(id, thread_id) ON DELETE CASCADE;
alter table thread_inputs add constraint thread_inputs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table thread_inputs add constraint thread_inputs_run_thread_fk FOREIGN KEY (run_id, thread_id) REFERENCES runs(id, thread_id) ON DELETE RESTRICT;
alter table thread_inputs add constraint thread_inputs_steer_command_id_fkey FOREIGN KEY (steer_command_id) REFERENCES commands(id) ON DELETE SET NULL;
alter table threads add constraint threads_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table threads add constraint threads_created_by_principal_fk FOREIGN KEY (created_by_principal_id) REFERENCES principals(id) ON DELETE RESTRICT;
alter table threads add constraint threads_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table threads add constraint threads_harness_instance_environment_fkey FOREIGN KEY (harness_instance_id, environment_id) REFERENCES harness_instances(id, environment_id) ON DELETE RESTRICT;
alter table threads add constraint threads_lineage_root_fk FOREIGN KEY (lineage_root_thread_id) REFERENCES threads(id);
alter table threads add constraint threads_parent_lineage_fk FOREIGN KEY (parent_thread_id, lineage_root_thread_id) REFERENCES threads(id, lineage_root_thread_id);
alter table trigger_control_requests add constraint trigger_control_requests_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES trigger_occurrences(id) ON DELETE CASCADE;
alter table trigger_occurrences add constraint trigger_occurrences_causal_chain_id_fkey FOREIGN KEY (causal_chain_id) REFERENCES causal_chains(id) ON DELETE RESTRICT;
alter table trigger_occurrences add constraint trigger_occurrences_command_id_fkey FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE RESTRICT;
alter table trigger_occurrences add constraint trigger_occurrences_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table trigger_occurrences add constraint trigger_occurrences_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES trigger_revisions(id) ON DELETE RESTRICT;
alter table trigger_occurrences add constraint trigger_occurrences_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table trigger_occurrences add constraint trigger_occurrences_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE CASCADE;
alter table trigger_revisions add constraint trigger_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table trigger_revisions add constraint trigger_revisions_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE CASCADE;
alter table triggers add constraint triggers_anchor_thread_id_fkey FOREIGN KEY (anchor_thread_id) REFERENCES threads(id) ON DELETE RESTRICT;
alter table triggers add constraint triggers_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table triggers add constraint triggers_current_revision_fk FOREIGN KEY (id, current_revision_id) REFERENCES trigger_revisions(trigger_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
alter table trigger_watch_activations add constraint trigger_watch_activations_anchor_thread_id_fkey FOREIGN KEY (anchor_thread_id) REFERENCES threads(id) ON DELETE RESTRICT;
alter table trigger_watch_activations add constraint trigger_watch_activations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table trigger_watch_activations add constraint trigger_watch_activations_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table trigger_watch_activations add constraint trigger_watch_activations_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES trigger_revisions(id) ON DELETE RESTRICT;
alter table trigger_watch_activations add constraint trigger_watch_activations_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table trigger_watch_activations add constraint trigger_watch_activations_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE CASCADE;
alter table trigger_watch_activations add constraint trigger_watch_activations_trigger_revision_fk FOREIGN KEY (trigger_id, revision_id) REFERENCES trigger_revisions(trigger_id, id) ON DELETE RESTRICT;
alter table watch_control_requests add constraint watch_control_requests_activation_id_fkey FOREIGN KEY (activation_id) REFERENCES trigger_watch_activations(id) ON DELETE CASCADE;
alter table deployment_events add constraint deployment_events_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES execution_environments(id) ON DELETE RESTRICT;
alter table deployment_events add constraint deployment_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE;
alter table deployment_events add constraint deployment_events_runner_id_fkey FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE RESTRICT;
alter table deployment_events add constraint deployment_events_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
alter table requests add constraint requests_originating_thread_id_fkey FOREIGN KEY (originating_thread_id) REFERENCES threads(id) ON DELETE RESTRICT;
alter table requests add constraint requests_originating_run_id_fkey FOREIGN KEY (originating_run_id) REFERENCES runs(id) ON DELETE RESTRICT;
alter table requests add constraint requests_originating_occurrence_id_fkey FOREIGN KEY (originating_occurrence_id) REFERENCES trigger_occurrences(id) ON DELETE RESTRICT;
alter table requests add constraint requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table requests add constraint requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE RESTRICT;
alter table requests add constraint requests_response_command_id_fkey FOREIGN KEY (response_command_id) REFERENCES commands(id) ON DELETE RESTRICT;
alter table integration_request_details add constraint integration_request_details_request_id_fkey FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE;
alter table integration_request_details add constraint integration_request_details_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES integration_installations(id) ON DELETE RESTRICT;
alter table integration_request_details add constraint integration_request_details_requested_server_id_fkey FOREIGN KEY (requested_server_id) REFERENCES integration_servers(id) ON DELETE RESTRICT;
alter table request_continuations add constraint request_continuations_request_id_fkey FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE RESTRICT;
create index account_directory_projections_pending on account_directory_projections USING btree (provider_id, next_attempt_at, updated_at) WHERE (published_generation < generation);
create index agent_control_requests_run_class on agent_control_requests USING btree (run_id, action_class);
create index auth_accounts_user on auth_accounts USING btree (user_id);
create index auth_admissions_expiry on auth_admissions USING btree (expires_at);
create index auth_sessions_user_expiry on auth_sessions USING btree (user_id, expires_at DESC);
create index auth_verifications_identifier on auth_verifications USING btree (identifier);
create index browser_session_attachments_session on browser_session_attachments USING btree (session_id);
create index browser_sessions_active_profile_placement on browser_sessions USING btree (profile_id, placement_key) WHERE (state = ANY (ARRAY['starting'::text, 'ready'::text, 'closing'::text]));
create index browser_sessions_runner on browser_sessions USING btree (runner_id, state);
create index browser_sessions_tab_group on browser_sessions(tab_group_id, created_at desc);
create index personal_tabs_group on personal_tabs(group_id, "order");
create index personal_tabs_session on personal_tabs(session_id);
create index personal_tabs_reopen on personal_tabs(closed_by, closed_at desc, id desc) where closed_by is not null and reopened_at is null;
create index browser_tab_groups_owner on browser_tab_groups(owner_id);
create index browser_tab_group_members_group on browser_tab_group_members(group_id);
create index browser_tab_opens_preference on browser_tab_opens(owner_id, identity_key, created_at desc) where identity_key is not null;
create index browser_tab_opens_retention on browser_tab_opens(owner_id, created_at);
create index channel_access_grants_account_status on channel_access_grants USING btree (account_id, status, requested_at DESC);
create index channel_accounts_connection on channel_accounts USING btree (connection_id, updated_at DESC);
create index channel_bindings_account_status on channel_bindings USING btree (account_id, status, updated_at DESC);
create UNIQUE index channel_conversations_external_unique on channel_conversations USING btree (provider, external_account_id, external_scope_id, external_conversation_id, external_thread_id) NULLS NOT DISTINCT;
create index channel_deliveries_attention on channel_deliveries USING btree (account_id, status) WHERE (status = ANY (ARRAY['unknown'::text, 'dead'::text]));
create index channel_deliveries_retention on channel_deliveries USING btree (updated_at) WHERE (status = ANY (ARRAY['sent'::text, 'dead'::text]));
create index channel_deliveries_claimable on channel_deliveries USING btree (COALESCE(conversation_id, ingress_id), created_at, part) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text, 'attempt-started'::text, 'retryable-failed'::text, 'unknown'::text]));
create UNIQUE index channel_deliveries_message_reply_unique on channel_deliveries USING btree (message_id, part) WHERE ((kind = 'reply'::text) AND (message_id IS NOT NULL));
create index channel_identities_linked_user on channel_identities USING btree (linked_user_id) WHERE (linked_user_id IS NOT NULL);
create index channel_ingress_claimable on channel_ingress_events USING btree (next_attempt_at, received_at) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text]));
create index channel_ingress_lane on channel_ingress_events USING btree (lane_key, status);
create index channel_ingress_retention on channel_ingress_events USING btree (processed_at) WHERE (status = ANY (ARRAY['adopted'::text, 'ignored'::text, 'dead'::text]));
create index channel_link_codes_account_expiry on channel_link_codes USING btree (account_id, expires_at);
create index channel_link_codes_identity_live on channel_link_codes USING btree (identity_id, expires_at) WHERE (consumed_at IS NULL);
create index commands_environment_active on commands USING btree (environment_id) WHERE (status = ANY (ARRAY['pending'::text, 'dispatched'::text]));
create index credential_access_audit_credential_created on credential_access_audit USING btree (credential_id, created_at DESC);
create index host_account_adoption_proofs_pending on host_account_adoption_proofs USING btree (authorized_by_user_id, expires_at) WHERE (consumed_at IS NULL);
create index integration_auth_attempts_expiry on integration_auth_attempts USING btree (expires_at);
create UNIQUE index integration_auth_attempts_launch_ticket on integration_auth_attempts USING btree (launch_ticket_hash);
create index integration_auth_attempts_owner_flow_status on integration_auth_attempts USING btree (owner_user_id, flow, status, created_at DESC);
create UNIQUE index integration_connections_definition_identity_unique on integration_connections USING btree (integration_definition_id, external_tenant_id, external_identity_id) NULLS NOT DISTINCT WHERE ((connection_kind = 'provider-account'::text) AND (external_identity_id IS NOT NULL) AND (status <> 'revoked'::text));
create UNIQUE index integration_connections_computer_live_unique on integration_connections USING btree (integration_definition_id, runner_id, coalesce(computer_app_key, '')) WHERE ((connection_kind = 'computer'::text) AND (status <> 'revoked'::text));
create index integration_connections_kind_owner_updated on integration_connections USING btree (connection_kind, owner_user_id, updated_at DESC);
create index integration_connections_owner_updated on integration_connections USING btree (owner_user_id, updated_at DESC);
create index integration_connections_runtime_status on integration_connections USING btree (runner_id, status, updated_at);
create index integration_servers_active on integration_servers USING btree (installation_id, status);
create index integration_tools_active on integration_tools USING btree (server_id, status, name);
create UNIQUE index integration_tools_server_connection_name on integration_tools USING btree (server_id, connection_id, name) NULLS NOT DISTINCT WHERE (status = 'active'::text);
create UNIQUE index harness_instances_one_ambient_per_driver on harness_instances USING btree (environment_id, driver_kind) WHERE ((state_kind = 'ambient'::text) AND (removed_at IS NULL));
create UNIQUE index harness_instances_one_default_per_driver on harness_instances USING btree (environment_id, driver_kind) WHERE ((removed_at IS NULL) AND is_default);
create index harness_instances_environment on harness_instances USING btree (environment_id, created_at) WHERE (removed_at IS NULL);
create index machine_access_events_session on machine_access_events USING btree (session_id, id);
create index machine_access_sessions_history on machine_access_sessions USING btree (runner_id, started_at DESC, id DESC);
create index machine_access_sessions_open on machine_access_sessions USING btree (runner_id) WHERE (ended_at IS NULL);
create index machine_access_sessions_run on machine_access_sessions USING btree (run_id);
create index messages_thread_recent on messages USING btree (thread_id, created_at DESC, id DESC);
create UNIQUE index messages_thread_sequence_unique on messages USING btree (thread_id, sequence);
create index personal_remote_pairing_codes_pending on personal_remote_pairing_codes USING btree (generation, expires_at) WHERE (consumed_at IS NULL);
create index personal_remote_sessions_generation on personal_remote_sessions USING btree (route_kind, route_generation);
create UNIQUE index principals_user_unique on principals USING btree (user_id) WHERE (user_id IS NOT NULL);
create UNIQUE index provider_sessions_one_active_per_thread on provider_sessions USING btree (thread_id) WHERE active;
create UNIQUE index runners_single_main on runners USING btree (kind) WHERE ((kind = 'main'::text) AND (revoked_at IS NULL));
create index runs_environment_active on runs USING btree (environment_id) WHERE (status = ANY (ARRAY['queued'::text, 'starting'::text, 'running'::text, 'waiting'::text]));
create UNIQUE index runs_one_executing_per_thread on runs USING btree (thread_id) WHERE (status = ANY (ARRAY['starting'::text, 'running'::text, 'waiting'::text]));
create UNIQUE index runs_one_queued_per_thread on runs USING btree (thread_id) WHERE (status = 'queued'::text);
create index security_audit_actor_created on security_audit USING btree (actor_user_id, created_at DESC, id DESC);
create UNIQUE index causal_chains_watch_observation_unique on causal_chains USING btree (root_watch_activation_id, root_watch_observation_id) WHERE (root_watch_activation_id IS NOT NULL);
create index thread_inputs_pending on thread_inputs USING btree (thread_id, created_at, message_id) WHERE (state = 'pending'::text);
create index thread_inputs_run on thread_inputs USING btree (run_id, created_at, message_id) WHERE (run_id IS NOT NULL);
create index threads_lineage_page on threads USING btree (lineage_root_thread_id, updated_at DESC, id DESC);
create index threads_parent_thread on threads USING btree (parent_thread_id) WHERE (parent_thread_id IS NOT NULL);
create index threads_creator_created on threads(created_by,created_at desc,id desc) include(color);
create index trigger_control_requests_class_count on trigger_control_requests USING btree (occurrence_id, action_class);
create index trigger_occurrences_recent on trigger_occurrences USING btree (trigger_id, created_at DESC, id DESC);
create index trigger_occurrences_running_binding on trigger_occurrences USING btree (runner_id, runner_boot_id) WHERE (status = 'running'::text);
create index trigger_watch_activations_environment_desired on trigger_watch_activations USING btree (environment_id, desired, updated_at, id);
create UNIQUE index trigger_watch_activations_one_active on trigger_watch_activations USING btree (trigger_id) WHERE (desired = 'active'::text);
create index triggers_due_schedule on triggers USING btree (next_fire_at, id) WHERE ((status = 'active'::text) AND (kind = 'schedule'::text) AND (next_fire_at IS NOT NULL));
create index watch_control_requests_window on watch_control_requests USING btree (activation_id, created_at);
create UNIQUE index deployment_events_runner_dedup on deployment_events USING btree (run_id, runner_ordinal) WHERE ((run_id IS NOT NULL) AND (runner_ordinal IS NOT NULL));
create UNIQUE index requests_run_call_identity_unique on requests USING btree (originating_run_id, call_id) WHERE (originating_run_id IS NOT NULL);
create UNIQUE index requests_occurrence_call_identity_unique on requests USING btree (originating_occurrence_id, call_id) WHERE (originating_occurrence_id IS NOT NULL);
create index requests_originating_thread_pending on requests USING btree (originating_thread_id, created_at, id) WHERE (status = 'pending'::text);
create index requests_originating_thread_history on requests USING btree (originating_thread_id, created_at, id);
create index request_continuations_waiting on request_continuations USING btree (attempted_at NULLS FIRST, created_at, request_id) WHERE (status = 'waiting'::text);

alter table deployments add constraint deployments_singleton unique (singleton_key);
alter table deployments add constraint deployments_shape check (deployment_shape in ('{"kind":"personal"}'::jsonb, '{"kind":"team"}'::jsonb));
alter table personal_settings add foreign key (owner_id) references users(id);
alter table personal_settings add foreign key (agent_home_computer_id) references runners(id);
alter table personal_settings add foreign key (voice_thread_id) references threads(id);
alter table personal_settings add check (singleton_key = 'personal' and agent_home_path <> '');
alter table deployment_event_state add foreign key (deployment_id) references deployments(id);
alter table deployment_event_state add check (sequence >= 0);
alter table deployment_events add foreign key (deployment_id) references deployments(id);
alter table threads add check (purpose in ('task','voice','background-job'));
alter table threads add check ((team_id is null and channel_id is null and thread_root_id is null) or (team_id is not null and channel_id is not null and thread_root_id is not null and purpose = 'task'));
create unique index threads_team_origin on threads(team_id,channel_id,thread_root_id) where team_id is not null;
create function opensteer_prevent_harness_instance_identity_change() returns trigger language plpgsql as $$
begin
  if new.environment_id is distinct from old.environment_id
    or new.driver_kind is distinct from old.driver_kind
    or new.state_kind is distinct from old.state_kind then
    raise exception 'harness instance environment, driver, and state kind are immutable';
  end if;
  if new.runtime_revision < old.runtime_revision then
    raise exception 'harness runtime revision cannot decrease';
  end if;
  if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
    raise exception 'a removed harness instance cannot be restored';
  end if;
  return new;
end $$;
create trigger harness_instances_keep_identity before update on harness_instances
for each row execute function opensteer_prevent_harness_instance_identity_change();

create function opensteer_enforce_command_execution_authority() returns trigger language plpgsql as $$
begin
  if new.type in ('run.execute', 'trigger.execute', 'run.steer', 'run.interrupt', 'request.respond')
    and not exists (
      select 1 from threads thread
      join execution_environments environment on environment.id = thread.environment_id
      join personal_settings settings on settings.owner_id = new.requested_by
      join users person on person.id = settings.owner_id and person.disabled_at is null
      where thread.id = new.thread_id and thread.environment_id = new.environment_id
        and environment.runner_id = settings.agent_home_computer_id
    ) then
    raise exception 'command requester cannot execute the thread environment';
  end if;
  return new;
end $$;
create trigger commands_execution_authority before insert or update of environment_id, thread_id, requested_by, type on commands
for each row execute function opensteer_enforce_command_execution_authority();

create function opensteer_keep_task_team_origin() returns trigger language plpgsql as $$
begin
  if row(old.team_id, old.channel_id, old.thread_root_id)
    is distinct from row(new.team_id, new.channel_id, new.thread_root_id) then
    raise exception 'A task''s team origin never changes' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger threads_keep_team_origin before update of team_id, channel_id, thread_root_id
  on threads for each row execute function opensteer_keep_task_team_origin();

create index deployment_events_thread_history on deployment_events(thread_id,sequence) where node_detail_id is null;
create index deployment_events_node_detail on deployment_events(node_detail_id,sequence desc) where node_detail_id is not null;
create index deployment_events_run on deployment_events(run_id,sequence) where run_id is not null;
create index requests_needs_you on requests(created_at,id) where status='pending';
create unique index inputs_team_request on thread_inputs(thread_id,team_request_id) where team_request_id is not null;
create unique index runs_team_request on runs(thread_id,team_request_id) where team_request_id is not null;
alter table thread_inputs add check (team_request_id is null or (policy='queue' and team_source is not null));
create view thread_work_inputs as select * from thread_inputs where policy in ('queue','steer');
alter table team_members add foreign key(user_id) references users(id);
alter table team_members add foreign key(changed_by) references users(id);
alter table team_members add unique(handle);
alter table team_members add check (generation >= 1 and length(handle) <= 48 and handle ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and handle !~ '-agent$');
alter table team_access_state add check (singleton_key='team' and revision>=0 and directory_revision>=0);
alter table team_groups add foreign key(created_by) references team_members(user_id);
create unique index team_groups_name on team_groups(normalized_name) where deleted_at is null;
alter table team_group_people add foreign key(group_id) references team_groups(id);
alter table team_group_people add foreign key(user_id) references team_members(user_id);
alter table team_group_people add foreign key(added_by) references team_members(user_id);
create index team_group_people_person on team_group_people(user_id,group_id);
alter table team_group_edges add foreign key(parent_group_id) references team_groups(id);
alter table team_group_edges add foreign key(child_group_id) references team_groups(id);
alter table team_group_edges add foreign key(added_by) references team_members(user_id);
alter table team_group_edges add check (parent_group_id<>child_group_id);
create index team_group_edges_child on team_group_edges(child_group_id,parent_group_id);
create index team_members_active on team_members(state,user_id);
create index team_members_roles on team_members(role,state);
alter table team_invites add foreign key(created_by) references team_members(user_id);
alter table team_invites add unique(selector);
alter table team_invites add unique(verifier_hash);
alter table team_invites add check (max_uses between 1 and 1000 and used_count between 0 and max_uses);
create index team_invites_expiring on team_invites(expires_at) where revoked_at is null;
alter table team_invite_uses add foreign key(invite_id) references team_invites(id);
alter table team_invite_uses add foreign key(user_id) references team_members(user_id);
alter table team_channels add foreign key(created_by) references team_members(user_id);
alter table team_channels add check (change_seq>=0 and instructions_revision>=0 and octet_length(instructions_markdown)<=16384);
alter table team_channels add check ((kind in ('public','private') and name is not null and normalized_name is not null and dm_key is null) or (kind in ('dm','group_dm') and dm_key is not null));
create unique index team_channels_name on team_channels(normalized_name) where normalized_name is not null and archived_at is null;
create unique index team_channels_dm on team_channels(dm_key) where dm_key is not null;
create index team_channels_directory on team_channels(kind,normalized_name,id);
alter table team_channel_members add foreign key(channel_id) references team_channels(id);
alter table team_channel_members add foreign key(added_by) references team_members(user_id);
create index team_channel_members_subject on team_channel_members(subject_kind,subject_id,channel_id);
alter table team_channel_member_state add foreign key(channel_id) references team_channels(id);
alter table team_channel_member_state add foreign key(user_id) references team_members(user_id);
create index team_channel_member_state_user on team_channel_member_state(user_id,channel_id);
alter table team_messages add unique(channel_id,id);
alter table team_messages add foreign key(channel_id) references team_channels(id);
alter table team_messages add foreign key(channel_id,thread_root_id) references team_messages(channel_id,id);
alter table team_messages add foreign key(author_user_id) references team_members(user_id);
alter table team_messages add check (id>0 and change_seq>0 and thread_root_id is distinct from id and octet_length(body_markdown)<=16384);
alter table team_messages add check ((author_kind='human' and agent_request_id is null) or (author_kind='agent' and agent_request_id is not null and thread_root_id is not null));
create unique index team_messages_client_id on team_messages(channel_id,author_user_id,author_kind,client_message_id);
create unique index team_messages_agent_reply on team_messages(agent_request_id) where agent_request_id is not null;
create index team_messages_history on team_messages(channel_id,id desc);
create index team_messages_roots on team_messages(channel_id,id desc) where thread_root_id is null;
create index team_messages_replies on team_messages(channel_id,thread_root_id,id) where thread_root_id is not null;
create index team_messages_resume on team_messages(channel_id,change_seq);
create index team_messages_search on team_messages using gin(search_document);
create index team_messages_author on team_messages(author_user_id,id desc);
alter table team_channels add foreign key(id,latest_message_id) references team_messages(channel_id,id) deferrable initially deferred;
alter table team_channel_member_state add foreign key(channel_id,last_read_message_id) references team_messages(channel_id,id);
alter table team_mentions add foreign key(channel_id,message_id) references team_messages(channel_id,id);
alter table team_mentions add foreign key(target_user_id) references team_members(user_id);
create index team_mentions_person on team_mentions(target_user_id,channel_id,message_id);
create index team_mentions_channel on team_mentions(channel_id,message_id);
alter table team_message_pins add foreign key(channel_id,message_id) references team_messages(channel_id,id);
alter table team_message_pins add foreign key(pinned_by) references team_members(user_id);
create index team_pins_page on team_message_pins(channel_id,pinned_at desc,message_id);
alter table team_blobs add unique(channel_id,id);
alter table team_blobs add foreign key(channel_id) references team_channels(id);
alter table team_blobs add foreign key(uploader_user_id) references team_members(user_id);
alter table team_blobs add unique(channel_id,uploader_user_id,client_upload_id);
alter table team_blobs add unique(storage_key);
alter table team_blobs add check (size_bytes between 1 and 104857600 and received_bytes between 0 and size_bytes);
alter table team_blobs add check ((preview_storage_key is null and preview_media_type is null and preview_size_bytes is null) or (preview_storage_key is not null and preview_media_type in ('image/jpeg','image/png','image/webp') and preview_size_bytes between 1 and 65536));
create index team_blobs_cleanup on team_blobs(state,expires_at,id);
alter table team_message_attachments add unique(blob_id);
alter table team_message_attachments add foreign key(channel_id,message_id) references team_messages(channel_id,id);
alter table team_message_attachments add foreign key(channel_id,blob_id) references team_blobs(channel_id,id);
alter table team_message_attachments add check(position between 0 and 9);
create index team_files_page on team_message_attachments(channel_id,message_id desc,position);
alter table team_topic_grants add foreign key(added_by) references team_members(user_id);
create index team_topic_grants_subject on team_topic_grants(subject_kind,subject_id,topic_id);
alter table team_channel_topics add foreign key(channel_id) references team_channels(id);
alter table team_channel_topics add foreign key(attached_by) references team_members(user_id);
create index team_channel_topics_topic on team_channel_topics(topic_id,channel_id);
alter table team_links add foreign key(owner_user_id) references team_members(user_id);
alter table team_links add unique(id,owner_user_id);
alter table team_links add unique(code_hash);
alter table team_links add check (state<>'active' or (personal_deployment_id is not null and credential_hash is not null));
create unique index team_links_active on team_links(owner_user_id) where state='active';
create unique index team_links_pending on team_links(owner_user_id) where state='pending';
create unique index team_links_credential on team_links(credential_hash) where credential_hash is not null;
alter table team_agent_requests add foreign key(owner_user_id) references team_members(user_id);
alter table team_agent_requests add foreign key(link_id,owner_user_id) references team_links(id,owner_user_id);
alter table team_agent_requests add foreign key(channel_id,thread_root_id) references team_messages(channel_id,id);
alter table team_agent_requests add foreign key(channel_id,trigger_message_id) references team_messages(channel_id,id);
alter table team_agent_requests add foreign key(channel_id,reply_message_id) references team_messages(channel_id,id) deferrable initially deferred;
alter table team_agent_requests add unique(trigger_message_id,owner_user_id);
alter table team_agent_requests add check (state in ('queued','working','needs_you','done','failed','cancelled','stopped') and change_seq>0);
alter table team_agent_requests add check ((accepted_at is null and expires_at is null) or (accepted_at is not null and expires_at=accepted_at+interval '7 days'));
alter table team_agent_requests add check ((state in ('done','failed','cancelled','stopped'))=(finished_at is not null));
alter table team_agent_requests add check (jsonb_typeof(steps)='array' and jsonb_array_length(steps)<=8);
alter table team_messages add foreign key(agent_request_id) references team_agent_requests(id) deferrable initially deferred;
alter table team_blobs add foreign key(agent_request_id) references team_agent_requests(id);
create index team_requests_queued on team_agent_requests(owner_user_id,created_at,id) where state='queued';
create index team_requests_thread on team_agent_requests(channel_id,thread_root_id,created_at,id);
create index team_requests_link on team_agent_requests(link_id,state);
create index team_requests_resume on team_agent_requests(channel_id,change_seq);
create index team_requests_expiring on team_agent_requests(expires_at) where state in ('working','needs_you');
alter table team_audit add foreign key(actor_user_id) references team_members(user_id);
alter table team_audit add foreign key(link_id) references team_links(id);
alter table team_audit add foreign key(agent_request_id) references team_agent_requests(id);
create index team_audit_page on team_audit(occurred_at desc,id desc);
create index team_audit_actor on team_audit(actor_user_id,id desc);
create index team_audit_channel on team_audit(channel_id,id desc);
create index team_audit_action on team_audit(action,id desc);
alter table team_notices add foreign key(recipient_user_id) references team_members(user_id);
alter table team_notices add foreign key(audit_id) references team_audit(id);
alter table team_notices add unique(recipient_user_id,dedupe_key);
create index team_notices_page on team_notices(recipient_user_id,created_at desc,id desc);
alter table team_outbox add foreign key(channel_id) references team_channels(id);
alter table team_outbox add foreign key(message_id) references team_messages(id);
alter table team_outbox add foreign key(notice_id) references team_notices(id);
create index team_outbox_pending on team_outbox(created_at,id);
alter table personal_team_links add unique(team_deployment_id);
alter table personal_team_requests add foreign key(team_deployment_id) references personal_team_links(team_deployment_id);
alter table personal_team_requests add foreign key(local_task_id) references threads(id);
alter table personal_team_requests add foreign key(local_input_id) references thread_inputs(message_id);
alter table personal_team_requests add foreign key(run_id) references runs(id);
alter table personal_team_requests add unique(local_input_id);
create index personal_team_requests_unpublished on personal_team_requests(team_deployment_id,created_at,request_id) where publication_state='pending';
create index personal_team_requests_reply on personal_team_requests(team_deployment_id,accepted_message_id) where publication_state='accepted' and accepted_message_id is not null;

create unique index triggers_system_role on triggers(system_role) where system_role is not null;
create table agent_home_skill_inventory (
  computer_id text not null primary key references runners(id) on delete cascade,
  environment_id text not null references execution_environments(id) on delete cascade,
  boot_id text not null,
  connection_generation bigint not null,
  connection_id text not null,
  connection_lease_id text not null,
  binding_generation integer not null,
  scan_sequence bigint not null,
  scanned_at timestamptz not null,
  scan_status text not null check(scan_status in ('complete','failed')),
  metadata jsonb not null
);

alter table host_oauth_refresh_tokens add foreign key(session_id) references auth_sessions(id) on delete cascade;
create index host_oauth_refresh_tokens_session on host_oauth_refresh_tokens(session_id);
alter table host_oauth_access_tokens add foreign key(session_id) references auth_sessions(id) on delete cascade;
create index host_oauth_access_tokens_session on host_oauth_access_tokens(session_id);

create function opensteer_flush_integration_authority() returns trigger language plpgsql as $$
declare authority_owner_id text;
begin
  for authority_owner_id in
    select owner_user_id from integration_authority_pending
    where transaction_id = pg_current_xact_id() order by owner_user_id loop
    insert into integration_authority_generations(owner_user_id, generation, updated_at)
      select authority_owner_id, 1, now() where exists(select 1 from users where id = authority_owner_id)
      on conflict(owner_user_id) do update
      set generation = integration_authority_generations.generation + 1, updated_at = excluded.updated_at;
  end loop;
  delete from integration_authority_pending where transaction_id = pg_current_xact_id();
  return null;
end $$;
create constraint trigger integration_authority_pending_flush
  after insert on integration_authority_pending deferrable initially deferred
  for each row execute function opensteer_flush_integration_authority();

create function opensteer_bump_all_integration_authority() returns trigger language plpgsql as $$
begin
  insert into integration_authority_pending(transaction_id, owner_user_id)
    select pg_current_xact_id(), id from users on conflict do nothing;
  return null;
end $$;
create function opensteer_bump_integration_owner_authority() returns trigger language plpgsql as $$
begin
  insert into integration_authority_pending(transaction_id, owner_user_id)
    values(pg_current_xact_id(), case when tg_op='DELETE' then old.owner_user_id else new.owner_user_id end)
    on conflict do nothing;
  return null;
end $$;
create trigger integration_installations_authority_generation after insert or update or delete on integration_installations
  for each statement execute function opensteer_bump_all_integration_authority();
create trigger integration_servers_authority_generation after insert or update or delete on integration_servers
  for each statement execute function opensteer_bump_all_integration_authority();
create trigger integration_tools_authority_generation after insert or update or delete on integration_tools
  for each statement execute function opensteer_bump_all_integration_authority();
create trigger integration_provider_applications_authority_generation after insert or update or delete on integration_provider_applications
  for each statement execute function opensteer_bump_all_integration_authority();
create trigger integration_connections_authority_generation after insert or update or delete on integration_connections
  for each row execute function opensteer_bump_integration_owner_authority();
create trigger integration_grants_authority_generation after insert or update or delete on integration_grants
  for each row execute function opensteer_bump_integration_owner_authority();
create trigger plugin_owner_settings_authority_generation after insert or update or delete on plugin_owner_settings
  for each row execute function opensteer_bump_integration_owner_authority();

`;
