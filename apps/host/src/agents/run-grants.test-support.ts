const agentToolsUrl = /http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/agent-tools/gu;

/**
 * The agent-tools token and URL of the one engine conversation that started
 * the marked Run's turn. One shared engine process carries other Runs' and
 * token-less naming conversations too, so each row counts only for the
 * conversation it names.
 */
export function heldRunCapture(
  captured: string,
  marker: string,
): { readonly token: string; readonly url: string } | undefined {
  const conversations = new Map<string, { marked: boolean; token?: string; urls: Set<string> }>();
  const entry = (threadId: string) => {
    const known = conversations.get(threadId) ?? { marked: false, urls: new Set<string>() };
    conversations.set(threadId, known);
    return known;
  };
  for (const line of captured.split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as {
      fakeOpensteerTokens?: { agentTools?: string; threadId?: string };
      fakeThreadConfig?: { config?: unknown; threadId?: string };
      method?: string;
      params?: { threadId?: unknown };
    };
    if (
      row.method === "turn/start" &&
      typeof row.params?.threadId === "string" &&
      JSON.stringify(row.params).includes(marker)
    )
      entry(row.params.threadId).marked = true;
    const tokens = row.fakeOpensteerTokens;
    if (tokens?.threadId && tokens.agentTools) entry(tokens.threadId).token = tokens.agentTools;
    const config = row.fakeThreadConfig;
    if (config?.threadId)
      for (const url of JSON.stringify(config.config ?? {}).match(agentToolsUrl) ?? [])
        entry(config.threadId).urls.add(url);
  }
  const engines = [...conversations.values()].filter((entry) => entry.marked && entry.token);
  const [engine] = engines;
  if (engines.length !== 1 || engine?.token === undefined || engine.urls.size !== 1)
    return undefined;
  return { token: engine.token, url: [...engine.urls][0]! };
}
