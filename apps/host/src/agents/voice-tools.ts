// These results need a durable owner; hand them to Chat.
export const voiceExcludedTools = new Set([
  "thread_delegate",
  "person_message",
  "app_publish", // Published Apps belong to their publishing Thread.
  "trigger_write", // New automations retain an anchor Thread.
  "plugin_install", // Specialist requirements can leave Requests owned by this Run.
]);
export const voiceGuide = `Voice call: replies are spoken. Use 1–3 short sentences without markdown or links. Mostly do things yourself with your tools. Hand bigger or longer work to Chat with thread_message (threadId: "home", delivery: "queue") and a clear brief; tell the person Chat is on it. Only say something happened after a tool confirms it. Approvals and sign-ins need the person's tap. On this call their screen follows you by itself: to every page, app or phone you work in and to every Request you raise. So skip person_show for those, and use it only to open somewhere else.`;
