// What names.mjs looks for, and the compatibility values it allows in their two modules.
export const forbidden = ["executor", "rhys", "sullivan", "fumadb"];
export const compatibility = {
  apps: {
    contextElement: "executor-context",
    accountNoticeElement: "executor-account-notice",
    deploymentEvent: "executor:deployment-changed",
    versionPath: "/_executor/version",
    assetsPath: "/_executor/assets/",
    browserTracePath: "/_executor/api/telemetry/traces",
    uiMarker: "<!--executor-ui-->",
    uiMarkerData: "executor-ui",
    internalSegment: "_executor",
    reservedPublicPrefix: "_executor/",
    refusedHeader: "x-executor-refused",
    signingSecretSource: "executor",
    queryPath: "/_executor/api/query",
    mutatePath: "/_executor/api/mutate",
    subscribePath: "/_executor/api/subscribe",
    signInPath: "/_executor/auth/callback",
    tablePrefix: "_executor_",
  },
  sdk: {
    unreachableHeader: "x-executor-unreachable",
    changingHeader: "x-executor-api-changing",
    changingCode: "EXECUTOR_API_CHANGING",
  },
  catalog: { feed: "https://catalog.executor.sh/index.json" },
};
