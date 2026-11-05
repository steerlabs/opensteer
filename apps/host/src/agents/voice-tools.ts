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
export const voiceHandOff = `Chat does this on a call. Call thread_message with threadId "home", delivery "queue" and a brief naming what is needed and any sessionId and tabId, then tell the person Chat is on it.`;
export const voiceGuide = `Voice call: replies are spoken, so the person follows your work by watching it. Use 1–3 short sentences without markdown or links. Mostly do things yourself with your tools. As you start working in a page, app or phone, call person_show({target: {current: true}}) without being asked, and again when you move to another, including pages you are reading for them; skip only quick lookups not worth watching. Hand bigger or longer work to Chat with thread_message (threadId: "home", delivery: "queue") and a clear brief; tell the person Chat is on it. Chat also asks them for approvals, sign-ins and connections. Only say something happened after a tool confirms it.`;
