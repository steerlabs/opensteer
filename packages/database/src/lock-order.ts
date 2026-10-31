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
  // Disjoint creation identities are reserved before any materialized authority.
  "advisory:identity",
  "advisory:adoption-proof",
  "advisory:connect",
  "advisory:runner-token",
  "advisory:runner-main",
  "advisory:runner-enrollment",
  "advisory:trigger-create",
  "advisory:attachment-upload",
  "advisory:workspace-invitation",
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
  "runs",
  "agent_control_requests",
  "trigger_control_requests",
  "trigger_occurrences",
  "advisory:workspace-tab-reopen",
  "browser_sessions",
  // Reserve the complete Workspace set by ascending ID before membership or placement.
  "workspaces",
  "workspace_tabs",
  "browser_tab_layouts",
  "browser_tab_groups",
  "browser_tab_group_members",
  // Workspace-scoped reservations serialize browser and installation creation.
  "advisory:browser-sign-in",
  "advisory:browser-site-grants",
  "advisory:integration-catalog-definition",
  "advisory:integration-installation",
  // Enrollment and Runner ownership precede integration and execution authority.
  "runner_enrollments",
  "runners",
  "computer_use_approval_keys",
  // Installation and sorted Servers establish the parents of Connections and Tools.
  "advisory:installation",
  "integration_installations",
  "integration_servers",
  // Membership authority precedes placement and Thread mutation.
  "workspace_memberships",
  // Environment and profile fences prevent rebinding or catalog adoption across Thread work.
  "execution_environments",
  "harness_instances",
  // Independent lifecycle rows retain their position when no observed edge constrains them.
  "request_continuations",
  "advisory:grant",
  "workspace_events",
  "agent_notification_mutes",
  "auth_admissions",
  "auth_jwks",
  "auth_rate_limits",
  "auth_sso_providers",
  "auth_verifications",
  // Browser profile mutations reserve their revisions and sources before downstream grants.
  "browser_profiles",
  "browser_history_entries",
  "browser_history_icons",
  "browser_profile_revisions",
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
  "channel_access_grants",
  "channel_conversations",
  "channel_conversation_contexts",
  // Threads precede Trigger/watch selection and provider-session projection.
  "threads",
  "triggers",
  "trigger_watch_activations",
  // Provider history and causal budgets precede Request and Assignment settlement.
  "provider_sessions",
  "harness_catalogs",
  "causal_chains",
  "attachments",
  "channel_deliveries",
  "channel_link_codes",
  // Computer approvals and integration Grants precede Request settlement.
  "computer_app_setup_requests",
  "advisory:integration-grant",
  "computer_use_policies",
  "integration_grants",
  // Request authority settles before Assignments, Commands and input receipts.
  "requests",
  "advisory:browser-profile",
  "advisory:browser-grants",
  // Assignment projections precede Commands, Inputs, Messages and their derived state.
  "delegations",
  "commands",
  "thread_inputs",
  "messages",
  "integration_request_details",
  // Tool/skill projections follow complete authority and Request settlement.
  "integration_tools",
  "integration_tool_definitions",
  "integration_skills",
  "thread_state_pending",
  "browser_profile_grants",
  "browser_site_grants",
  // Independent credential and access lifecycles have no earlier observed dependencies.
  "credentials",
  "machine_access_events",
  "machine_access_sessions",
  "machine_local_sessions",
  "advisory:personal-remote-access",
  "mcp_oauth_credentials",
  "automation_failure_notices",
  "owner_enrollments",
  "personal_remote_access",
  "personal_remote_account_link",
  "personal_remote_sessions",
  "principals",
  "security_audit",
  "security_effects",
  "thread_read_markers",
  "trigger_revisions",
  "user_execution_preferences",
  // Host User fences precede auth sessions, adoption proofs and account reconciliation.
  "users",
  "account_directory_projections",
  "auth_sessions",
  "notification_preview_keys",
  "host_account_adoption_proofs",
  "account_directory_provider",
  "auth_accounts",
  "personal_remote_pairing_codes",
  "personal_remote_session_grant_uses",
  "watch_control_requests",
  "workspace_invitations",
  "workspace_mounts",
  // Only paths already holding the Run write its nodes, attempts and grants, last.
  "execution_nodes",
  "run_attempts",
  "grants",
  // A message's included pages are credited after everything that kept the message.
  "advisory:browser-session-use",
  "browser_session_uses",
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
    "workspace-tab-reopen",
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
  if (value[1] === "workspace-invitation") return "advisory:workspace-invitation";
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
