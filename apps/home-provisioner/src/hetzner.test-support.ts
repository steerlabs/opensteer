import { HetznerCloud } from "./hetzner.js";

export function fakeHetzner() {
  type Server = {
    id: number;
    name: string;
    labels: Record<string, string>;
    status: "running" | "off";
    public_net: {
      ipv4: { ip: string; blocked: false };
      ipv6: null;
      firewalls: { id: number; status: "applied" }[];
    };
  };
  const servers = new Map<number, Server>();
  let firewall: unknown;
  let nextId = 1;
  const meta = { pagination: { next_page: null } };
  const action = { id: 100, status: "success" };
  const reply = (body: unknown, status = 200) => Response.json(body, { status });
  return new HetznerCloud({
    token: "hetzner-fake-token",
    timeoutMs: 2000,
    actionTimeoutMs: 5000,
    baseUrl: new URL("https://hetzner.test/v1/"),
    fetch: async (input, options) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      if (url.hostname !== "hetzner.test") throw new Error("Unexpected test endpoint");
      const method = options?.method ?? "GET";
      const [, , resource, idText, , verb] = url.pathname.split("/");
      if (resource === "firewalls") {
        if (method === "GET") return reply({ firewalls: firewall ? [firewall] : [], meta });
        const body: unknown = JSON.parse(String(options?.body));
        firewall = { ...(body as object), id: 9 };
        return reply({ firewall, actions: [action] });
      }
      if (resource !== "servers")
        throw new Error(`Unexpected fake Hetzner request ${method} ${url.pathname}`);
      if (method === "GET" && !idText) {
        const name = url.searchParams.get("name");
        const selector = url.searchParams.get("label_selector")?.split(",") ?? [];
        return reply({
          servers: [...servers.values()].filter(
            (server) =>
              (!name || server.name === name) &&
              selector.every((attribute) => {
                const [label, value] = attribute.split("=");
                return Boolean(label && server.labels[label] === value);
              }),
          ),
          meta,
        });
      }
      if (method === "POST" && !idText) {
        const input = JSON.parse(String(options?.body)) as Pick<Server, "name" | "labels">;
        const id = nextId++;
        const server: Server = {
          name: input.name,
          labels: input.labels,
          id,
          status: "off",
          public_net: {
            ipv4: { ip: `192.0.2.${id}`, blocked: false },
            ipv6: null,
            firewalls: [{ id: 9, status: "applied" }],
          },
        };
        servers.set(id, server);
        return reply({ server, action, next_actions: [] });
      }
      const server = servers.get(Number(idText));
      if (!server) return reply({}, 404);
      if (method === "GET") return reply({ server });
      if (method === "DELETE") servers.delete(server.id);
      else if (verb === "poweron") server.status = "running";
      else if (verb === "shutdown") server.status = "off";
      else throw new Error(`Unexpected fake Hetzner action ${method} ${url.pathname}`);
      return reply({ action });
    },
  });
}
