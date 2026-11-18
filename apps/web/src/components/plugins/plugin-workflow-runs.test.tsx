// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { controlledClientSession } from "@opensteer/client/test-support";
import { usePluginWorkflowRuns } from "@opensteer/client/react";
import type { HostClient } from "@opensteer/client/host";
import { rpcSuccess, type PluginChange, type PluginWorkflowRunView } from "@opensteer/protocol";

it("reads the live runs after StrictMode repeats the effect and unsubscribes on unmount", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const initial = Promise.withResolvers<ReturnType<typeof readResult>>();
  const changed = new Set<(change: PluginChange) => void>();
  const run: PluginWorkflowRunView = {
    id: "run",
    workflow: "Import",
    status: "running",
    createdAt: "2026-11-15T10:00:00.000Z",
    failure: null,
  };
  const readResult = (runs: PluginWorkflowRunView[]) => rpcSuccess({ runs, cursor: null });
  const subscribePluginsChanged = vi.fn((listener: (change: PluginChange) => void) => {
    changed.add(listener);
    return () => changed.delete(listener);
  });
  const read = vi
    .fn()
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValueOnce(readResult([run]))
    .mockResolvedValueOnce(readResult([{ ...run, status: "terminated" }]));
  const session = controlledClientSession();
  const host = {
    connection: session.connection,
    rpc: { "plugins.workflow.runs": read },
    subscribePluginsChanged,
    subscribe: () => () => {},
    getSnapshot: () => ({ connection: "connected", session: "authenticated" }),
  } as unknown as HostClient;
  const mount = document.createElement("div");
  const root = createRoot(mount);
  function Runs() {
    const { visible } = usePluginWorkflowRuns(host, "fixture");
    return <>{visible[0]?.status}</>;
  }
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Runs />
        </StrictMode>,
      ),
    );
    expect(subscribePluginsChanged).toHaveBeenCalledTimes(2);
    expect(changed.size).toBe(1);
    await act(async () => initial.resolve(readResult([])));
    expect(mount.textContent).toBe("running");
    await act(async () => {
      for (const listener of changed) listener({ pluginId: "fixture", categories: ["schedules"] });
    });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const listener of changed)
        listener({ pluginId: "fixture", categories: ["workflowRuns"] });
    });
    expect(mount.textContent).toBe("terminated");
  } finally {
    await act(async () => root.unmount());
  }
  expect(changed.size).toBe(0);
});
