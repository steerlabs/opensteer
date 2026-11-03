import { useEffect, useState } from "react";
import { z } from "zod";
import type { HostClient } from "@opensteer/client/host";
import { WorkspaceIdSchema } from "@opensteer/core";

const PluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string(),
  workspaceId: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  versions: z.array(z.object({ id: z.string(), digest: z.string() })),
  activations: z.array(z.object({ workspaceId: z.string() })),
});
type Plugin = z.infer<typeof PluginSchema>;

export function PluginManager({
  client,
  workspaces,
  revision,
}: {
  client: HostClient;
  workspaces: readonly { id: string; name: string }[];
  revision: boolean;
}) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [directory, setDirectory] = useState("");
  useEffect(() => {
    let alive = true;
    void client.rpc["plugin.list"]({})
      .then((result) => {
        if (!result.ok) throw new Error(result.error.message);
        if (alive) setPlugins(z.array(PluginSchema).parse(result.data.plugins));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [client, revision, generation]);
  async function mutate(command: Parameters<HostClient["dispatch"]>[0]) {
    try {
      await client.dispatch(command);
      setError(null);
      setGeneration((n) => n + 1);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="section">
      <h2 className="section__title">Plugins</h2>
      {error ? <p role="alert">{error}</p> : null}
      <input
        aria-label="Plugin update folder on Host"
        placeholder="Folder on Host for update"
        value={directory}
        onChange={(e) => setDirectory(e.target.value)}
      />
      {plugins.map((plugin) => (
        <div className="card" key={plugin.id}>
          <strong>{plugin.name}</strong>
          <span>
            {" "}
            {plugin.scope} ·{" "}
            {plugin.versions.find((v) => v.id === plugin.currentVersionId)?.digest.slice(0, 12)}
          </span>
          {workspaces
            .filter((w) => plugin.scope === "deployment" || plugin.workspaceId === w.id)
            .map((w) => (
              <label key={w.id} style={{ display: "block" }}>
                <input
                  type="checkbox"
                  checked={plugin.activations.some((a) => a.workspaceId === w.id)}
                  onChange={(e) =>
                    void mutate({
                      type: "plugin.activation.set",
                      pluginId: plugin.id,
                      workspaceId: WorkspaceIdSchema.parse(w.id),
                      active: e.target.checked,
                      idempotencyKey: crypto.randomUUID(),
                    })
                  }
                />{" "}
                {w.name}
              </label>
            ))}
          <button
            disabled={!directory}
            onClick={() =>
              void mutate({
                type: "plugin.update",
                pluginId: plugin.id,
                input: { directory },
                idempotencyKey: crypto.randomUUID(),
              })
            }
          >
            Update from folder
          </button>
          <button
            onClick={() =>
              void mutate({
                type: "plugin.remove",
                pluginId: plugin.id,
                idempotencyKey: crypto.randomUUID(),
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}
