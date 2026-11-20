/**
 * The official MCP client, unmodified, for root tests that reach a Home the way a connected
 * agent's own product does. The SDK resolves from this package only.
 */
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
export type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
export type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
