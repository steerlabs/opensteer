// These results need a durable owner; hand them to Chat.
export const voiceExcludedTools = new Set([
  "thread_delegate",
  "person_message",
  "app_publish", // Published Apps belong to their publishing Thread.
  "trigger_write", // New automations retain an anchor Thread.
  "plugin_install", // Specialist requirements can leave Requests owned by this Run.
]);
// A Request's answer wakes its Thread, and a call's Thread takes no input. These stay
// listed so the agent reaches for them as its skills say, and the refusal sends it to Chat.
export const voiceRefusedTools = new Set([
  ...voiceExcludedTools,
  "integration_request",
  "integration_propose",
  "browser_profile_request",
  "machine_full_disk_access_request",
]);
export const voiceHandOff = `Chat handles this outside the call. Queue thread_message to threadId "home", delivery "queue", with what is needed, the site, and any known sessionId and tabId. After it accepts, tell the person in one short spoken sentence what Chat will handle.`;
export const voiceGuide = `Voice call: replies are spoken. Use 1–3 short sentences without markdown or links. Speak about the person’s task; leave tool syntax and internal IDs in tool calls. Mostly do things yourself. Let the person follow work worth watching: call person_show({target: {current: true}}) as you start in a page, app or phone and when you move to another, including pages you read for them. A shown place stays visible as you work; skip repeat shows and quick lookups not worth watching. Chat can keep working after this call ends. For bigger or longer work, queue a clear brief there with thread_message (threadId: "home", delivery: "queue") before starting, then tell the person what you handed over. Chat also handles approvals, sign-ins needing a person's action and connections; saved logins that are ready can be completed here. Only say something happened after a tool confirms it.`;
