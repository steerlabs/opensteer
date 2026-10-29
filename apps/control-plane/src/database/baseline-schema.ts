/** Final PostgreSQL schema for a fresh Opensteer account service. */
export const CONTROL_PLANE_BASELINE_SCHEMA_SQL = String.raw`


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;


CREATE TABLE public.auth_accounts (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.auth_jwks (
    id text NOT NULL,
    public_key text NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone
);



CREATE TABLE public.auth_rate_limits (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL,
    CONSTRAINT control_plane_auth_rate_limit_count_check CHECK ((count >= 0))
);



CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.auth_verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.deployment_adoption_operations (
    proof_id text NOT NULL,
    owner_account_id text NOT NULL,
    request_fingerprint text NOT NULL,
    state text NOT NULL,
    receipt jsonb NOT NULL,
    sealed_provisioning_bundle text,
    result_expires_at timestamp with time zone NOT NULL,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_plane_adoption_operation_fingerprint_check CHECK ((request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT control_plane_adoption_operation_proof_id_check CHECK ((proof_id ~ '^hap_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT control_plane_adoption_operation_result_check CHECK ((((state = 'completed'::text) AND (sealed_provisioning_bundle IS NOT NULL) AND (acknowledged_at IS NULL)) OR ((state = 'acknowledged'::text) AND (sealed_provisioning_bundle IS NULL) AND (acknowledged_at IS NOT NULL)) OR ((state = 'expired'::text) AND (sealed_provisioning_bundle IS NULL) AND (acknowledged_at IS NULL)))),
    CONSTRAINT control_plane_adoption_operation_state_check CHECK ((state = ANY (ARRAY['completed'::text, 'acknowledged'::text, 'expired'::text])))
);



CREATE TABLE public.deployment_connect (
    deployment_id text NOT NULL,
    state text DEFAULT 'disabled'::text NOT NULL,
    origin text,
    generation bigint DEFAULT 0 NOT NULL,
    observed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    access_route jsonb,
    CONSTRAINT control_plane_connect_access_route_check CHECK (((access_route IS NULL) OR (jsonb_typeof(access_route) = 'object'::text))),
    CONSTRAINT control_plane_connect_generation_check CHECK (((generation >= 0) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT control_plane_connect_origin_check CHECK (((state = ANY (ARRAY['ready'::text, 'offline'::text])) = (origin IS NOT NULL))),
    CONSTRAINT control_plane_connect_state_check CHECK ((state = ANY (ARRAY['disabled'::text, 'provisioning'::text, 'ready'::text, 'offline'::text, 'revoked'::text])))
);



CREATE TABLE public.deployment_connect_operations (
    deployment_id text NOT NULL,
    operation_id text NOT NULL,
    operation_kind text NOT NULL,
    request_fingerprint text NOT NULL,
    state text NOT NULL,
    result_generation bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_plane_connect_operation_fingerprint_check CHECK ((request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT control_plane_connect_operation_id_check CHECK ((operation_id ~ '^cop_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT control_plane_connect_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['provision'::text, 'rotate'::text, 'revoke'::text]))),
    CONSTRAINT control_plane_connect_operation_result_check CHECK ((((state = 'completed'::text) AND ((result_generation >= 0) AND (result_generation <= '9007199254740991'::bigint))) OR ((state <> 'completed'::text) AND (result_generation IS NULL)))),
    CONSTRAINT control_plane_connect_operation_state_check CHECK ((state = ANY (ARRAY['running'::text, 'failed'::text, 'completed'::text])))
);



CREATE TABLE public.deployment_connect_resources (
    deployment_id text NOT NULL,
    provider text NOT NULL,
    state text NOT NULL,
    hostname text NOT NULL,
    tunnel_name text NOT NULL,
    tunnel_id text,
    dns_record_id text,
    local_origin text NOT NULL,
    credential_generation bigint DEFAULT 0 NOT NULL,
    operation_id text,
    operation_kind text,
    operation_expires_at timestamp with time zone,
    last_completed_operation_id text,
    last_completed_operation_kind text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_plane_connect_resource_completed_operation_check CHECK ((((last_completed_operation_id IS NULL) = (last_completed_operation_kind IS NULL)) AND ((last_completed_operation_kind IS NULL) OR (last_completed_operation_kind = ANY (ARRAY['provision'::text, 'rotate'::text, 'revoke'::text]))))),
    CONSTRAINT control_plane_connect_resource_generation_check CHECK (((credential_generation >= 0) AND (credential_generation <= '9007199254740991'::bigint))),
    CONSTRAINT control_plane_connect_resource_ids_check CHECK (((tunnel_id IS NULL) = (dns_record_id IS NULL))),
    CONSTRAINT control_plane_connect_resource_operation_check CHECK ((((operation_id IS NULL) AND (operation_kind IS NULL) AND (operation_expires_at IS NULL)) OR ((operation_id IS NOT NULL) AND (operation_kind = ANY (ARRAY['provision'::text, 'rotate'::text, 'revoke'::text])) AND (operation_expires_at IS NOT NULL)))),
    CONSTRAINT control_plane_connect_resource_provider_check CHECK ((provider = 'cloudflare'::text)),
    CONSTRAINT control_plane_connect_resource_ready_check CHECK (((state <> 'ready'::text) OR ((tunnel_id IS NOT NULL) AND (credential_generation >= 1) AND (operation_id IS NULL)))),
    CONSTRAINT control_plane_connect_resource_revoked_check CHECK (((state <> 'revoked'::text) OR ((tunnel_id IS NULL) AND (operation_id IS NULL)))),
    CONSTRAINT control_plane_connect_resource_state_check CHECK ((state = ANY (ARRAY['provisioning'::text, 'ready'::text, 'rotating'::text, 'deleting'::text, 'error'::text, 'revoked'::text])))
);



CREATE TABLE public.deployment_credentials (
    deployment_id text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.deployment_directory_entries (
    deployment_id text NOT NULL,
    account_id text NOT NULL,
    generation bigint NOT NULL,
    present boolean NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_plane_directory_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint)))
);



CREATE TABLE public.deployments (
    id text NOT NULL,
    owner_account_id text NOT NULL,
    name text NOT NULL,
    reachability text NOT NULL,
    active_host_instance_id text NOT NULL,
    authority_epoch bigint NOT NULL,
    canonical_origin text NOT NULL,
    lifecycle text DEFAULT 'active'::text NOT NULL,
    oidc_client_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    host_key_fingerprint text NOT NULL,
    authority_envelope jsonb,
    directory_generation bigint DEFAULT 1 NOT NULL,
    account_link jsonb,
    CONSTRAINT control_plane_deployments_epoch_check CHECK (((authority_epoch >= 1) AND (authority_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT control_plane_deployments_host_key_check CHECK ((host_key_fingerprint ~ '^sha256:[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT control_plane_deployments_account_link_check CHECK ((((reachability = 'canonical'::text) AND (account_link IS NULL)) OR ((reachability = 'routed'::text) AND (account_link IS NOT NULL)))),
    CONSTRAINT control_plane_deployments_reachability_check CHECK ((reachability = ANY (ARRAY['routed'::text, 'canonical'::text]))),
    CONSTRAINT control_plane_deployments_lifecycle_check CHECK ((lifecycle = 'active'::text)),
    CONSTRAINT control_plane_deployments_name_check CHECK (((octet_length(name) >= 1) AND (octet_length(name) <= 480))),
    CONSTRAINT control_plane_directory_generation_check CHECK (((directory_generation >= 1) AND (directory_generation <= '9007199254740991'::bigint)))
);



CREATE TABLE public.hosted_oauth_broker_attempts (
    attempt_id text NOT NULL,
    account_subject text NOT NULL,
    deployment_id text NOT NULL,
    provider text NOT NULL,
    requested_scope_digest text NOT NULL,
    state_hash text,
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    retry_generation integer DEFAULT 0 NOT NULL,
    failure_code text,
    provider_application_revision integer NOT NULL,
    host_public_key text NOT NULL,
    sealed_ciphertext jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    launch_ticket_hash text,
    encrypted_context bytea,
    context_key_version integer,
    CONSTRAINT hosted_oauth_broker_attempt_failure_check CHECK (((failure_code IS NULL) OR (failure_code = ANY (ARRAY['account-link-mismatch'::text, 'authorization-denied'::text, 'catalog-version-skew'::text, 'invalid-provider-response'::text, 'provider-exchange-failed'::text, 'scope-escalation'::text, 'stale-provider-application'::text])))),
    CONSTRAINT hosted_oauth_broker_attempt_id_check CHECK ((attempt_id ~ '^hoa_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT hosted_oauth_broker_attempt_key_check CHECK (((host_public_key ~ '^[A-Za-z0-9_-]{43}$'::text) AND (provider ~ '^[a-z][a-z0-9.-]{0,127}$'::text) AND (provider_application_revision > 0) AND (expires_at > created_at))),
    CONSTRAINT hosted_oauth_broker_attempt_result_check CHECK ((((status = 'sealed'::text) AND (sealed_ciphertext IS NOT NULL)) OR ((status <> 'sealed'::text) AND (sealed_ciphertext IS NULL)))),
    CONSTRAINT hosted_oauth_broker_attempt_session_context_check CHECK ((((status = 'pending'::text) AND (state_hash IS NOT NULL) AND (launch_ticket_hash IS NOT NULL) AND (encrypted_context IS NOT NULL) AND ((octet_length(encrypted_context) >= 1) AND (octet_length(encrypted_context) <= 524288)) AND (context_key_version >= 0)) OR ((status = ANY (ARRAY['launched'::text, 'exchanging'::text])) AND (state_hash IS NOT NULL) AND (launch_ticket_hash IS NULL) AND (encrypted_context IS NOT NULL) AND ((octet_length(encrypted_context) >= 1) AND (octet_length(encrypted_context) <= 524288)) AND (context_key_version >= 0)) OR ((status = ANY (ARRAY['sealed'::text, 'acknowledged'::text, 'denied'::text, 'failed'::text, 'expired'::text])) AND (launch_ticket_hash IS NULL) AND (encrypted_context IS NULL) AND (context_key_version IS NULL)))),
    CONSTRAINT hosted_oauth_broker_attempt_session_digest_check CHECK (((requested_scope_digest ~ '^[A-Za-z0-9_-]{43}$'::text) AND ((state_hash IS NULL) OR (state_hash ~ '^[A-Za-z0-9_-]{43}$'::text)) AND ((launch_ticket_hash IS NULL) OR (launch_ticket_hash ~ '^[A-Za-z0-9_-]{43}$'::text)))),
    CONSTRAINT hosted_oauth_broker_attempt_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'launched'::text, 'exchanging'::text, 'sealed'::text, 'acknowledged'::text, 'denied'::text, 'failed'::text, 'expired'::text])))
);



CREATE TABLE public.hosted_oauth_broker_refreshes (
    transaction_id text NOT NULL,
    account_subject text NOT NULL,
    deployment_id text NOT NULL,
    provider text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text NOT NULL,
    failure_code text,
    provider_error text,
    provider_application_revision integer NOT NULL,
    host_public_key text NOT NULL,
    sealed_ciphertext jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hosted_oauth_broker_refresh_failure_check CHECK (((failure_code IS NULL) OR (failure_code = ANY (ARRAY['account-link-mismatch'::text, 'authorization-denied'::text, 'catalog-version-skew'::text, 'client-rejected'::text, 'grant-rejected'::text, 'invalid-provider-response'::text, 'provider-exchange-failed'::text, 'scope-escalation'::text, 'stale-provider-application'::text])))),
    CONSTRAINT hosted_oauth_broker_refresh_id_check CHECK ((transaction_id ~ '^hor_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT hosted_oauth_broker_refresh_key_check CHECK (((host_public_key ~ '^[A-Za-z0-9_-]{43}$'::text) AND (provider ~ '^[a-z][a-z0-9.-]{0,127}$'::text) AND (provider_application_revision > 0) AND (expires_at > created_at))),
    CONSTRAINT hosted_oauth_broker_refresh_provider_error_check CHECK (((provider_error IS NULL) OR (provider_error ~ '^[a-z0-9_]{1,64}$'::text))),
    CONSTRAINT hosted_oauth_broker_refresh_result_check CHECK ((((status = 'sealed'::text) AND (sealed_ciphertext IS NOT NULL)) OR ((status <> 'sealed'::text) AND (sealed_ciphertext IS NULL)))),
    CONSTRAINT hosted_oauth_broker_refresh_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sealed'::text, 'acknowledged'::text, 'failed'::text, 'expired'::text])))
);



CREATE TABLE public.oauth_access_tokens (
    id text NOT NULL,
    token text NOT NULL,
    client_id text NOT NULL,
    session_id text,
    user_id text,
    reference_id text,
    refresh_id text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    scopes jsonb NOT NULL
);



CREATE TABLE public.oauth_clients (
    id text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    disabled boolean DEFAULT false NOT NULL,
    skip_consent boolean,
    enable_end_session boolean,
    subject_type text,
    scopes jsonb,
    user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    software_id text,
    software_version text,
    software_statement text,
    redirect_uris jsonb NOT NULL,
    post_logout_redirect_uris jsonb,
    token_endpoint_auth_method text,
    grant_types jsonb,
    response_types jsonb,
    public boolean,
    type text,
    require_pkce boolean,
    reference_id text,
    metadata jsonb,
    CONSTRAINT control_plane_oauth_clients_public_pkce_check CHECK (((NOT COALESCE(public, false)) OR ((token_endpoint_auth_method = 'none'::text) AND COALESCE(require_pkce, false) AND (type = ANY (ARRAY['native'::text, 'user-agent-based'::text, 'web'::text])))))
);



CREATE TABLE public.oauth_consents (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text,
    reference_id text,
    scopes jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);



CREATE TABLE public.oauth_refresh_token (
    id text NOT NULL,
    token text NOT NULL,
    client_id text NOT NULL,
    session_id text,
    user_id text NOT NULL,
    reference_id text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    auth_time timestamp with time zone,
    scopes jsonb NOT NULL
);



CREATE TABLE public.personal_host_account_link_challenges (
    challenge_id text NOT NULL,
    owner_account_id text NOT NULL,
    credential_hash text NOT NULL,
    name text NOT NULL,
    authority jsonb NOT NULL,
    reserved_deployment_id text NOT NULL,
    reserved_host_instance_id text NOT NULL,
    reserved_host_key_fingerprint text NOT NULL,
    proof_fingerprint text,
    state text NOT NULL,
    sealed_result text,
    challenge_expires_at timestamp with time zone NOT NULL,
    result_expires_at timestamp with time zone,
    activated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    host_credential_hash text,
    link_generation text,
    operation_id text NOT NULL,
    sealed_issue text,
    CONSTRAINT control_plane_personal_link_authority_check CHECK ((jsonb_typeof(authority) = 'object'::text)),
    CONSTRAINT control_plane_personal_link_challenge_id_check CHECK ((challenge_id ~ '^phc_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT control_plane_personal_link_credential_hash_check CHECK ((credential_hash ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT control_plane_personal_link_deployment_id_check CHECK ((reserved_deployment_id ~ '^dep_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT control_plane_personal_link_generation_check CHECK (((link_generation IS NULL) OR (link_generation ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT control_plane_personal_link_host_credential_hash_check CHECK (((host_credential_hash IS NULL) OR (host_credential_hash ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT control_plane_personal_link_host_instance_id_check CHECK ((reserved_host_instance_id ~ '^hst_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT control_plane_personal_link_host_key_check CHECK ((reserved_host_key_fingerprint ~ '^sha256:[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT control_plane_personal_link_name_check CHECK ((((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120)) AND (name = btrim(name)))),
    CONSTRAINT control_plane_personal_link_operation_id_check CHECK ((operation_id ~ '^plo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT control_plane_personal_link_proof_fingerprint_check CHECK (((proof_fingerprint IS NULL) OR (proof_fingerprint ~ '^[A-Za-z0-9_-]{43}$'::text))),
    CONSTRAINT control_plane_personal_link_result_check CHECK ((((state = 'pending'::text) AND (proof_fingerprint IS NULL) AND (sealed_result IS NULL) AND (sealed_issue IS NOT NULL) AND (host_credential_hash IS NULL) AND (link_generation IS NULL) AND (result_expires_at IS NULL) AND (activated_at IS NULL)) OR ((state = 'reserved'::text) AND (proof_fingerprint IS NOT NULL) AND (sealed_result IS NOT NULL) AND (sealed_issue IS NULL) AND (host_credential_hash IS NOT NULL) AND (link_generation IS NOT NULL) AND (result_expires_at IS NOT NULL) AND (activated_at IS NULL)) OR ((state = 'activated'::text) AND (proof_fingerprint IS NOT NULL) AND (sealed_result IS NULL) AND (sealed_issue IS NULL) AND (host_credential_hash IS NOT NULL) AND (link_generation IS NOT NULL) AND (result_expires_at IS NOT NULL) AND (activated_at IS NOT NULL)) OR ((state = ANY (ARRAY['cancelled'::text, 'expired'::text, 'unlinked'::text])) AND (sealed_result IS NULL) AND (sealed_issue IS NULL)))),
    CONSTRAINT control_plane_personal_link_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'reserved'::text, 'activated'::text, 'cancelled'::text, 'expired'::text, 'unlinked'::text])))
);



CREATE TABLE public.portal_sessions (
    id text NOT NULL,
    token_hash text NOT NULL,
    account_id text NOT NULL,
    account_session_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);



CREATE TABLE public.users (
    id text NOT NULL,
    display_name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT control_plane_users_email_check CHECK (((email = lower(email)) AND ((octet_length(email) >= 3) AND (octet_length(email) <= 320)))),
    CONSTRAINT control_plane_users_name_check CHECK (((octet_length(display_name) >= 1) AND (octet_length(display_name) <= 480)))
);



ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.auth_jwks
    ADD CONSTRAINT auth_jwks_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_key_key UNIQUE (key);



ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_token_key UNIQUE (token);



ALTER TABLE ONLY public.auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT control_plane_auth_account_provider_unique UNIQUE (provider_id, account_id);



ALTER TABLE ONLY public.deployment_connect_operations
    ADD CONSTRAINT control_plane_connect_operations_pk PRIMARY KEY (deployment_id, operation_id);



ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT control_plane_deployments_id_reachability_unique UNIQUE (id, reachability);



ALTER TABLE ONLY public.deployment_directory_entries
    ADD CONSTRAINT control_plane_directory_entries_pk PRIMARY KEY (deployment_id, account_id);



ALTER TABLE ONLY public.deployment_adoption_operations
    ADD CONSTRAINT deployment_adoption_operations_pkey PRIMARY KEY (proof_id);



ALTER TABLE ONLY public.deployment_connect
    ADD CONSTRAINT deployment_connect_pkey PRIMARY KEY (deployment_id);



ALTER TABLE ONLY public.deployment_connect_resources
    ADD CONSTRAINT deployment_connect_resources_hostname_key UNIQUE (hostname);



ALTER TABLE ONLY public.deployment_connect_resources
    ADD CONSTRAINT deployment_connect_resources_pkey PRIMARY KEY (deployment_id);



ALTER TABLE ONLY public.deployment_connect_resources
    ADD CONSTRAINT deployment_connect_resources_tunnel_name_key UNIQUE (tunnel_name);



ALTER TABLE ONLY public.deployment_credentials
    ADD CONSTRAINT deployment_credentials_pkey PRIMARY KEY (deployment_id);



ALTER TABLE ONLY public.deployment_credentials
    ADD CONSTRAINT deployment_credentials_token_hash_key UNIQUE (token_hash);



ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_oidc_client_id_key UNIQUE (oidc_client_id);



ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.hosted_oauth_broker_attempts
    ADD CONSTRAINT hosted_oauth_broker_attempts_pkey PRIMARY KEY (attempt_id);



ALTER TABLE ONLY public.hosted_oauth_broker_attempts
    ADD CONSTRAINT hosted_oauth_broker_attempts_state_hash_key UNIQUE (state_hash);



ALTER TABLE ONLY public.hosted_oauth_broker_refreshes
    ADD CONSTRAINT hosted_oauth_broker_refreshes_pkey PRIMARY KEY (transaction_id);



ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_token_key UNIQUE (token);



ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_client_id_key UNIQUE (client_id);



ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.oauth_consents
    ADD CONSTRAINT oauth_consents_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_token_key UNIQUE (token);



ALTER TABLE ONLY public.personal_host_account_link_challenges
    ADD CONSTRAINT personal_host_account_link_challenges_credential_hash_key UNIQUE (credential_hash);



ALTER TABLE ONLY public.personal_host_account_link_challenges
    ADD CONSTRAINT personal_host_account_link_challenges_pkey PRIMARY KEY (challenge_id);



ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_pkey PRIMARY KEY (id);



ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_token_hash_key UNIQUE (token_hash);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);



ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);



CREATE INDEX control_plane_access_tokens_client ON public.oauth_access_tokens USING btree (client_id);



CREATE INDEX control_plane_access_tokens_refresh ON public.oauth_access_tokens USING btree (refresh_id);



CREATE INDEX control_plane_access_tokens_session ON public.oauth_access_tokens USING btree (session_id);



CREATE INDEX control_plane_access_tokens_user ON public.oauth_access_tokens USING btree (user_id);



CREATE INDEX control_plane_adoption_operations_expiry ON public.deployment_adoption_operations USING btree (result_expires_at) WHERE (state = 'completed'::text);



CREATE INDEX control_plane_auth_accounts_user ON public.auth_accounts USING btree (user_id);



CREATE INDEX control_plane_auth_sessions_user ON public.auth_sessions USING btree (user_id);



CREATE INDEX control_plane_auth_verifications_identifier ON public.auth_verifications USING btree (identifier);



CREATE UNIQUE INDEX control_plane_connect_resource_dns_unique ON public.deployment_connect_resources USING btree (dns_record_id) WHERE (dns_record_id IS NOT NULL);



CREATE UNIQUE INDEX control_plane_connect_resource_tunnel_unique ON public.deployment_connect_resources USING btree (tunnel_id) WHERE (tunnel_id IS NOT NULL);



CREATE INDEX control_plane_deployments_canonical_origin_lookup ON public.deployments USING btree (canonical_origin);



CREATE UNIQUE INDEX control_plane_deployments_host_instance_unique ON public.deployments USING btree (active_host_instance_id);



CREATE UNIQUE INDEX control_plane_deployments_host_key_unique ON public.deployments USING btree (host_key_fingerprint);



CREATE INDEX control_plane_deployments_owner_updated ON public.deployments USING btree (owner_account_id, updated_at DESC);



CREATE INDEX control_plane_directory_account_present ON public.deployment_directory_entries USING btree (account_id, deployment_id) WHERE present;



CREATE UNIQUE INDEX control_plane_non_personal_canonical_origin_unique ON public.deployments USING btree (canonical_origin) WHERE (reachability <> 'routed'::text);



CREATE UNIQUE INDEX control_plane_oauth_clients_reference_unique ON public.oauth_clients USING btree (reference_id) WHERE (reference_id IS NOT NULL);



CREATE INDEX control_plane_oauth_clients_user ON public.oauth_clients USING btree (user_id);



CREATE INDEX control_plane_oauth_consents_client ON public.oauth_consents USING btree (client_id);



CREATE INDEX control_plane_oauth_consents_user ON public.oauth_consents USING btree (user_id);



CREATE UNIQUE INDEX control_plane_personal_link_owner_operation_unique ON public.personal_host_account_link_challenges USING btree (owner_account_id, operation_id);



CREATE INDEX control_plane_personal_link_owner_pending ON public.personal_host_account_link_challenges USING btree (owner_account_id, challenge_expires_at) WHERE (state = 'pending'::text);



CREATE INDEX control_plane_personal_link_reservation_expiry ON public.personal_host_account_link_challenges USING btree (result_expires_at) WHERE (state = 'reserved'::text);



CREATE UNIQUE INDEX control_plane_personal_link_reserved_deployment_unique ON public.personal_host_account_link_challenges USING btree (reserved_deployment_id) WHERE (state = ANY (ARRAY['pending'::text, 'reserved'::text]));



CREATE UNIQUE INDEX control_plane_personal_link_reserved_host_instance_unique ON public.personal_host_account_link_challenges USING btree (reserved_host_instance_id) WHERE (state = ANY (ARRAY['pending'::text, 'reserved'::text]));



CREATE UNIQUE INDEX control_plane_personal_link_reserved_host_key_unique ON public.personal_host_account_link_challenges USING btree (reserved_host_key_fingerprint) WHERE (state = ANY (ARRAY['pending'::text, 'reserved'::text]));



CREATE INDEX control_plane_portal_sessions_account ON public.portal_sessions USING btree (account_id);



CREATE INDEX control_plane_portal_sessions_expiry ON public.portal_sessions USING btree (expires_at);



CREATE INDEX control_plane_refresh_tokens_client ON public.oauth_refresh_token USING btree (client_id);



CREATE INDEX control_plane_refresh_tokens_session ON public.oauth_refresh_token USING btree (session_id);



CREATE INDEX control_plane_refresh_tokens_user ON public.oauth_refresh_token USING btree (user_id);



CREATE INDEX hosted_oauth_broker_attempts_deployment_rate ON public.hosted_oauth_broker_attempts USING btree (deployment_id, created_at);



CREATE INDEX hosted_oauth_broker_refreshes_deployment_rate ON public.hosted_oauth_broker_refreshes USING btree (deployment_id, created_at);



ALTER TABLE ONLY public.auth_accounts
    ADD CONSTRAINT auth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_adoption_operations
    ADD CONSTRAINT deployment_adoption_operations_owner_account_id_fkey FOREIGN KEY (owner_account_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_connect
    ADD CONSTRAINT deployment_connect_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_connect_operations
    ADD CONSTRAINT deployment_connect_operations_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_connect_resources
    ADD CONSTRAINT deployment_connect_resources_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_credentials
    ADD CONSTRAINT deployment_credentials_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_directory_entries
    ADD CONSTRAINT deployment_directory_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployment_directory_entries
    ADD CONSTRAINT deployment_directory_entries_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_oidc_client_id_fkey FOREIGN KEY (oidc_client_id) REFERENCES public.oauth_clients(client_id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_owner_account_id_fkey FOREIGN KEY (owner_account_id) REFERENCES public.users(id) ON DELETE RESTRICT;



ALTER TABLE ONLY public.hosted_oauth_broker_attempts
    ADD CONSTRAINT hosted_oauth_broker_attempts_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.hosted_oauth_broker_attempts
    ADD CONSTRAINT hosted_oauth_broker_attempts_account_subject_fkey FOREIGN KEY (account_subject) REFERENCES public.users(id) ON DELETE CASCADE;


ALTER TABLE ONLY public.hosted_oauth_broker_refreshes
    ADD CONSTRAINT hosted_oauth_broker_refreshes_account_subject_fkey FOREIGN KEY (account_subject) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.hosted_oauth_broker_refreshes
    ADD CONSTRAINT hosted_oauth_broker_refreshes_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_refresh_id_fkey FOREIGN KEY (refresh_id) REFERENCES public.oauth_refresh_token(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_access_tokens
    ADD CONSTRAINT oauth_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_consents
    ADD CONSTRAINT oauth_consents_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_consents
    ADD CONSTRAINT oauth_consents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(client_id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.oauth_refresh_token
    ADD CONSTRAINT oauth_refresh_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.personal_host_account_link_challenges
    ADD CONSTRAINT personal_host_account_link_challenges_owner_account_id_fkey FOREIGN KEY (owner_account_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.users(id) ON DELETE CASCADE;



ALTER TABLE ONLY public.portal_sessions
    ADD CONSTRAINT portal_sessions_account_session_id_fkey FOREIGN KEY (account_session_id) REFERENCES public.auth_sessions(id) ON DELETE CASCADE;



`;
