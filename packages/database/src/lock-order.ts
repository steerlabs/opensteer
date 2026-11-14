/**
 * Declared acquisition order, including UPDATE, DELETE and conflict UPDATE.
 * Reusing a held row does not acquire a new lock; new rows in a transaction are private.
 * Acquire multiple existing rows in one ORDER BY primary-key query or ascending IDs.
 * Use NO KEY UPDATE for exclusive state fences, SHARE for live-parent checks.
 * FOR UPDATE needs an adjacent deletion/referenced-key reason (source guard enforced).
 * The integration pg-client checker observes actual row identities and this rank list.
 * It checks explicit transactions only; a lone statement outside one still must lock
 * multiple rows in key order. Only a top-level ORDER BY on a locking read counts as
 * ordered, and it refuses MERGE and data-modifying WITH, whose locks it cannot see.
 */
export const databaseLockOrder = [
  "deployment_event_state",
  "personal_settings",
  // BEGIN team authority and content lock order.
  "team_access_state",
  "team_channels",
  "team_members",
  "team_principals",
  "team_groups",
  "team_invites",
  "team_invite_uses",
  "team_group_people",
  "team_group_edges",
  "team_channel_members",
  "team_channel_member_state",
  "team_topics",
  "team_topic_grants",
  "team_notes",
  "team_note_versions",
  "team_sharing_settings",
  "team_partner_invites",
  "team_partner_links",
  "team_shares",
  "team_share_participants",
  "team_share_relays",
  "team_links",
  "team_messages",
  "team_agent_recipients",
  // Serializes team file reservations against the storage limit.
  "advisory:team-storage",
  "team_blobs",
  "team_message_attachments",
  "team_mentions",
  "team_message_pins",
  "team_agent_requests",
  "team_share_asks",
  "team_audit",
  "team_notices",
  "team_outbox",
  // END team authority and content lock order.

  // Disjoint creation identities are reserved before any materialized authority.
  "advisory:identity",
  "advisory:adoption-proof",
  "advisory:connect",
  "advisory:runner-token",
  "advisory:runner-main",
  "advisory:runner-enrollment",
  "advisory:trigger-create",
  "advisory:attachment-upload",
  "advisory:channel-identity",
  "advisory:notification-devices",
  "advisory:notification",
  // Cloud session ownership precedes Account capacity, Deployment identity and origin.
  "advisory:cloud",
  "advisory:account-capacity",
  "advisory:deployment",
  "advisory:origin",
  "advisory:browser-source-pairing",
  "advisory:browser-profile-session",
  "advisory:integration-provider",
  "advisory:channel-link-code",
  "advisory:account-host-session",
  "advisory:hosted-oauth-refresh-id",
  "advisory:hosted-oauth-refresh-account",
  "advisory:account-adoption-proof",
  "advisory:managed-owner-bootstrap",
  "advisory:native-oauth-client",
  "advisory:initial-owner-enrollment",
  "advisory:account-adoption-proof-issuance",
  "advisory:account-adoption-completion",
  "advisory:initial-owner-setup",
  "advisory:auth-admission-capacity",
  "advisory:opensteer:official-native-client",
  "advisory:opensteer:official-portal-client",
  "advisory:opensteer:account-directory-provider",
  "advisory:opensteer-deployment-identity",
  // Ingress claims its event and lane before reserving command idempotency.
  "channel_ingress_events",
  "advisory:lane",
  "advisory:command-idempotency",
  // Run admission and control precede Occurrences and browser execution state.
  "agent_connections",
  "runs",
  "agent_control_requests",
  "trigger_control_requests",
  "trigger_occurrences",
  "advisory:personal-tab-reopen",
  "browser_sessions",
  "personal_tabs",
  "browser_tab_layouts",
  "browser_tab_groups",
  "browser_tab_group_members",
  // Personal reservations serialize browser and installation creation.
  "advisory:browser-sign-in",
  "advisory:browser-site-grants",
  "advisory:integration-catalog-definition",
  // Plugin updates reconcile their MCP installation while holding the package row.
  "plugins",
  "plugin_versions",
  "advisory:integration-installation",
  // Enrollment and Runner ownership precede integration and execution authority.
  "runner_enrollments",
  "runners",
  "computer_use_approval_keys",
  // Installation and sorted Servers establish the parents of Connections and Tools.
  "advisory:installation",
  "integration_installations",
  "integration_servers",
  // Environment and profile fences prevent rebinding or catalog adoption across Thread work.
  "execution_environments",
  "agent_home_skill_inventory",
  "harness_instances",
  // Independent lifecycle rows retain their position when no observed edge constrains them.
  "request_continuations",
  "advisory:grant",
  "deployment_events",
  "auth_admissions",
  "auth_jwks",
  "auth_rate_limits",
  "auth_sso_providers",
  "auth_verifications",
  // Browser identities and sources precede downstream grants.
  "browser_profiles",
  "browser_history_entries",
  "browser_history_icons",
  "browser_session_attachments",
  "browser_sign_ins",
  "browser_source_imports",
  "browser_source_pairings",
  "advisory:browser-sources-owner",
  "browser_sources",
  "computer_use_stops",
  "credential_access_audit",
  "credential_vault_canaries",
  // Host deployment identity precedes identity-provider and User reconciliation.
  "deployments",
  "host_oauth_access_tokens",
  "host_oauth_clients",
  "host_oauth_refresh_tokens",
  "host_oauth_consents",
  // Provider identity and Connection authority precede channel routing.
  "integration_application_source_defaults",
  "integration_auth_attempts",
  "advisory:provider-account",
  "integration_connections",
  "integration_provider_applications",
  // Complete channel parents precede Binding, Identity, Grant and conversation state.
  "channel_accounts",
  "channel_bindings",
  "channel_identities",
  // A sender's new display name reaches its Principal before adoption locks the conversation.
  "principals",
  "channel_access_grants",
  "channel_conversations",
  // Threads precede Trigger/watch selection and provider-session projection.
  "threads",
  "triggers",
  "trigger_watch_activations",
  // Provider history and causal budgets precede Request and Assignment settlement.
  "provider_sessions",
  "harness_catalogs",
  "causal_chains",
  "attachments",
  "apps",
  "app_versions",
  "channel_deliveries",
  "channel_link_codes",
  // Computer approvals and integration Grants precede Request settlement.
  "computer_app_setup_requests",
  // A server's secrets change under its locked server, inside or after its approval.
  "integration_server_secrets",
  "advisory:integration-grant",
  "computer_use_policies",
  "integration_grants",
  // Request authority settles before Assignments, Commands and input receipts.
  "requests",
  "advisory:browser-profile",
  "advisory:browser-grants",
  // Specialist binding guards follow parent/Request fences before creating Assignments.
  "specialists",
  // Assignment projections precede Commands, Inputs, Messages and their derived state.
  "delegations",
  "commands",
  "thread_inputs",
  "messages",
  "personal_team_requests",
  "integration_request_details",
  // Tool/skill projections follow complete authority and Request settlement.
  "integration_tools",
  "integration_tool_definitions",
  "integration_skills",
  "thread_state_pending",
  // Erasure acknowledgements follow profile archival, history cleanup and grant revocation.
  "browser_profile_deletions",
  "browser_site_grants",
  // Independent credential and access lifecycles have no earlier observed dependencies.
  "credentials",
  "personal_team_links",
  "personal_team_posts",
  "machine_access_events",
  "machine_access_sessions",
  "advisory:personal-remote-access",
  "mcp_oauth_credentials",
  "automation_failure_notices",
  "task_question_notices",
  "owner_enrollments",
  "personal_remote_access",
  "personal_account_link_keys",
  "personal_remote_account_link",
  "personal_remote_sessions",
  "security_audit",
  "thread_visits",
  "trigger_revisions",
  // Host User fences precede auth sessions, adoption proofs and account reconciliation.
  "users",
  "auth_sessions",
  "personal_remote_administration",
  "personal_desktop_update",
  "notification_preview_keys",
  "host_account_adoption_proofs",
  "account_directory_provider",
  "auth_accounts",
  // Triggers write a projection after the users, auth_accounts or team_members row it mirrors.
  "account_directory_projections",
  "personal_remote_pairing_codes",
  "personal_remote_session_grant_uses",
  "watch_control_requests",
  // Only paths already holding the Run write its nodes, attempts and grants, last.
  "execution_nodes",
  "run_attempts",
  "grants",
  // A message's included pages are credited after everything that kept the message.
  "advisory:browser-session-use",
  "browser_session_uses",
  // Personal plugin policy changes follow their resource mutations.
  "plugin_settings_revision_pending",
  "plugin_owner_settings",
  // Deferred invalidations and sorted generation updates follow all source mutations.
  "integration_authority_pending",
  "integration_authority_generations",
  // Account-service tables are separate physical resources from identically named Host tables.
  "control-plane:auth_accounts",
  "control-plane:auth_jwks",
  "control-plane:auth_rate_limits",
  "control-plane:auth_verifications",
  "control-plane:deployment_adoption_operations",
  "control-plane:deployment_directory_visibility",
  "control-plane:hosted_oauth_broker_attempts",
  "control-plane:hosted_oauth_broker_refreshes",
  "control-plane:portal_sessions",
  // Account authority precedes session, notification and Personal-link mutations.
  "control-plane:users",
  "control-plane:auth_sessions",
  "control-plane:notification_devices",
  "control-plane:notification_deliveries",
  "control-plane:notification_publications",
  "control-plane:oauth_access_tokens",
  // Personal-link reservations precede Deployment unlink and Connect teardown.
  "control-plane:personal_host_account_link_challenges",
  // Deployment authority precedes Connect resources, credentials and directory projections.
  "control-plane:deployments",
  "control-plane:deployment_connect_resources",
  "control-plane:deployment_connect_operations",
  "control-plane:deployment_credentials",
  "control-plane:deployment_connect",
  "control-plane:deployment_directory_entries",
  // OAuth client identity precedes cloud operation projection and token cleanup.
  "control-plane:oauth_clients",
  // Deleting a hosted team removes the Deployment adopted at its address first, and an
  // adoption, retried ones included, fences its team's claim after its own locks.
  "control-plane:hosted_teams",
  "control-plane:cloud_deployment_operations",
  "control-plane:oauth_refresh_token",
  "control-plane:oauth_consents",
] as const;

export function databaseLockRank(resource: string): number {
  return (databaseLockOrder as readonly string[]).indexOf(resource);
}

/** Classify the actual hash preimage, never a callsite or a bound parameter alone.
 * Prefixes/JSON discriminants are disjoint. Unknown keys retain one conservative
 * shared identity domain until their production key format is declared here.
 */
export function advisoryLockResource(key: string, seed: number): string {
  if (seed === 2) return "advisory:adoption-proof";
  if (seed === 1) return "advisory:origin";
  if (seed !== 0) throw new Error(`Undeclared advisory hash seed: ${seed}`);
  if (key === "opensteer:access-writer") return "advisory:access-writer";
  if (key === "deployment-main-runner-enrollment") return "advisory:runner-main";
  if (key.startsWith("sha256:") || /^[a-f0-9]{64}$/u.test(key)) return "advisory:runner-token";
  if (key.startsWith("dep_")) return "advisory:deployment";
  const namespaced = {
    "opensteer:account-deployment-quota:": "account-capacity",
    "opensteer-connect:": "connect",
    "opensteer-cloud:": "cloud",
    "opensteer:notification-devices:": "notification-devices",
    "opensteer:notification:": "notification",
  };
  for (const [prefix, domain] of Object.entries(namespaced))
    if (key.startsWith(prefix)) return `advisory:${domain}`;
  const prefixes = [
    "plugin-owner-consent",
    "personal-tab-reopen",
    "browser-source-pairing",
    "browser-sources-owner",
    "browser-profile-session",
    "browser-session-use",
    "browser-profile",
    "browser-sign-in",
    "browser-grants",
    "browser-site-grants",
    "integration-grant",
    "integration-installation",
    "integration-catalog-definition",
    "integration-provider",
    "channel-link-code",
    "account-host-session",
    "hosted-oauth-refresh-id",
    "hosted-oauth-refresh-account",
    "account-adoption-proof",
  ] as const;
  for (const prefix of prefixes) if (key.startsWith(prefix + ":")) return `advisory:${prefix}`;
  const identities = [
    "managed-owner-bootstrap",
    "native-oauth-client",
    "initial-owner-enrollment",
    "account-adoption-proof-issuance",
    "account-adoption-completion",
    "initial-owner-setup",
    "auth-admission-capacity",
    "opensteer:official-native-client",
    "opensteer:official-portal-client",
    "opensteer:account-directory-provider",
    "opensteer-deployment-identity",
    "personal-remote-access",
    "team-storage",
  ] as const;
  if ((identities as readonly string[]).includes(key)) return `advisory:${key}`;
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    return "advisory:identity";
  }
  if (!Array.isArray(value)) return "advisory:identity";
  if (value[1] === "runner-enrollment-idempotency") return "advisory:runner-enrollment";
  for (const name of [
    "command-idempotency",
    "trigger-create",
    "attachment-upload",
    "provider-account",
  ])
    if (value[0] === name) return `advisory:${name}`;
  if (value.length === 5) return "advisory:lane";
  if (value.length === 3) return "advisory:channel-identity";
  return "advisory:identity";
}
