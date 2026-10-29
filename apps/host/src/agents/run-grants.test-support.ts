const agentToolsUrl = /http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/agent-tools/gu;

/**
 * The agent-tools token and URL of the one engine process that started the
 * marked Run's turn. The capture also holds the Run's token-less naming
 * app-server, which starts after the engine, and other Runs' engines.
 */
export function heldRunCapture(
  captured: string,
  marker: string,
): { readonly token: string; readonly url: string } | undefined {
  const processes = new Map<number, { marked: boolean; token?: string; urls: Set<string> }>();
  for (const line of captured.split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as {
      captureProcessId?: number;
      fakeOpensteerTokens?: { agentTools?: string };
      method?: string;
      params?: unknown;
    };
    if (row.captureProcessId === undefined) continue;
    const entry = processes.get(row.captureProcessId) ?? { marked: false, urls: new Set() };
    processes.set(row.captureProcessId, entry);
    if (row.method === "turn/start" && JSON.stringify(row.params).includes(marker))
      entry.marked = true;
    if (row.fakeOpensteerTokens?.agentTools) entry.token = row.fakeOpensteerTokens.agentTools;
    for (const url of line.match(agentToolsUrl) ?? []) entry.urls.add(url);
  }
  const engines = [...processes.values()].filter((entry) => entry.marked && entry.token);
  const [engine] = engines;
  if (engines.length !== 1 || engine?.token === undefined || engine.urls.size !== 1)
    return undefined;
  return { token: engine.token, url: [...engine.urls][0]! };
}
