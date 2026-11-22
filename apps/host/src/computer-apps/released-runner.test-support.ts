/**
 * What the Runner of `v0.1.716-insider` advertises: its `runnerCapabilities`
 * (`apps/runner/src/host/host-connection.ts:2361` at that tag) plus `run-events-v2`.
 */
export const releasedRunnerCapabilities = [
  "agent-home-settings-v1",
  "settings-plugin-policy-v1",
  "assignments-v1",
  "attempts-v1",
  "browser-page-input-v1",
  "browser-profile-create-v1",
  "environment-list-v1",
  "trigger-program-v5",
  "native-place-input-v1",
  "execution-plane-v2",
  "filesystem",
  "model-server-discovery-v1",
  "network-egress",
  "native-session-continuation-v1",
  "requester-time-zone-v1",
  "message-origin-v1",
  "agent-tools-plan-v1",
  "steer-answer-v1",
  "thread-state-v1",
  "background-text-v1",
  "task-done-v1",
  "person-show-v1",
  "full-disk-access-probe-v1",
  "run-events-v2",
] as const;
