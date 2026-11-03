export const hostInternalRoutePaths = {
  appTunnel: "/internal/v1/apps/tunnel",
  agentControl: "/internal/v1/agent-control",
  /** Runners that predate session addressing: follows the Run's latest session. */
  browserCdp: "/internal/v1/browser-cdp",
  browserSessionCdp: "/internal/v1/browser-cdp/:sessionId",
  browserSourcePair: "/internal/v1/browser-sources/pair",
  browserSourcePairChallenge: "/internal/v1/browser-sources/pair/challenge",
  browserSourceConnect: "/internal/v1/browser-sources/connect",
  computerUseDisplay: "/internal/v1/computer-use/display",
  egress: "/internal/v1/egress",
  integrationMcp: "/internal/v1/integration-mcp",
  plugins: "/internal/v1/plugin-cache/:digest",
  computerPluginPackages: "/internal/v1/computer-plugin-packages/:digest",
  mcp: "/internal/v1/mcp",
  phoneUpdate: "/internal/v1/runners/agent-phone-update",
  runners: "/internal/v1/runners",
  runnerAuxiliary: "/internal/v1/runners/auxiliary/:module",
  shellConnect: "/internal/v1/shell/connect",
  shellData: "/internal/v1/shell/data",
  triggerCdp: "/internal/v1/trigger-cdp",
  triggerRevisionProgram: "/internal/v1/triggers/revisions/:revisionId/program",
  watchCdp: "/internal/v1/watch-cdp",
} as const;

export const hostInternalRoutePatterns = Object.freeze(
  Object.values(hostInternalRoutePaths).map((path) => path.replace(/:[^/]+/gu, "*")),
);
