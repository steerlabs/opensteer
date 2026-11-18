/**
 * Product-owned MCP authority. No organization, browser session, or token is a grant.
 *
 * Dashboards import this module, so it holds only what they need too: identities, addresses,
 * targets and sign-in settings. Enforcement and refusal text are in `grant-enforcement.ts`.
 */
import { AppPermission } from "@opensteer/plugin-engine-authorization";
export { AppPermission } from "@opensteer/plugin-engine-authorization";
import { Schema } from "effect";

/** Stable authorization identity shared by access tokens, refresh tokens, and continuations. */
export const GrantId = Schema.NonEmptyString.pipe(Schema.brand("McpGrantId"));
export type GrantId = typeof GrantId.Type;
/** Scope selects ordinary apps. All apps includes any PluginEngine app the caller may use. */
export const GrantPolicy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tools"),
    apps: Schema.Array(AppPermission),
    approval: Schema.Literals(["browser", "client"]),
  }),
  Schema.Struct({ kind: Schema.Literal("all") }),
]);
export type GrantPolicy = typeof GrantPolicy.Type;
/**
 * Where a grant's approvals are answered. `automatic` accepts policy approvals at once and leaves
 * the decision to the agent's own permission prompt; questions a running tool asks still reach the
 * model, as in `model` mode. Revoked grants are absent from authentication, not converted to empty
 * or unrestricted policies.
 */
export const ApprovalMode = Schema.Literals(["model", "native", "browser", "automatic"]);
export type ApprovalMode = typeof ApprovalMode.Type;
/** A user's named MCP access boundary. URL-safe because it appears in the MCP URL and OAuth resource. */
export const ConnectionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)).pipe(
  Schema.brand("McpConnectionId"),
);
export type ConnectionId = typeof ConnectionId.Type;
/**
 * What an MCP URL names: an approval mode and, optionally, a scoped connection. For a grant this
 * only preselects the choice on the sign-in page; the grant record holds what was chosen. A
 * credential without a record, such as a personal access token, takes its mode from the URL.
 */
export const McpAddress = Schema.Struct({
  mode: ApprovalMode,
  connection: Schema.optionalKey(ConnectionId),
});
export type McpAddress = typeof McpAddress.Type;
/**
 * What a grant serves: MCP with the approval mode and connection its record holds, or the API.
 * The consent's resource decides only which of the two, since a token's audience is that resource.
 */
export const GrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), ...McpAddress.fields }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type GrantTarget = typeof GrantTarget.Type;
export const Grant = Schema.Struct({ id: GrantId, policy: GrantPolicy, target: GrantTarget });
export type Grant = typeof Grant.Type;
