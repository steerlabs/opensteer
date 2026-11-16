/**
 * The device domain: computer apps and phones, their setup requests and access
 * levels, and the MCP servers a computer runs. Nothing here reaches a service
 * integration module, and like the root barrel it is safe for every client.
 */
export * from "./access.js";
export * from "./computer-app.js";
export * from "./computer-app-setup.js";
export * from "./local-mcp.js";
