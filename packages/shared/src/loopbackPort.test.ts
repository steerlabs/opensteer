import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { expect, it } from "vitest";
import { freePort } from "./loopbackPort.test-support.js";

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("keeps a later listener safe from a competing ephemeral allocation", async () => {
  const range =
    process.platform === "linux"
      ? readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      : execFileSync(
          "sysctl",
          ["-n", "net.inet.ip.portrange.first", "net.inet.ip.portrange.last"],
          { encoding: "utf8" },
        );
  const [first, last] = range.trim().split(/\s+/u).map(Number);
  const port = await freePort();
  const competitor = createServer();
  const fixture = createServer();
  try {
    // Force the kernel's possible choice during the async fixture-creation gap.
    if (port >= first! && port <= last!) await listen(competitor, port);
    await expect(listen(fixture, port)).resolves.toBeUndefined();
  } finally {
    await close(fixture);
    await close(competitor);
  }
});

it("does not hand concurrent callers the same port during delayed binding", async () => {
  const ports = await Promise.all(Array.from({ length: 64 }, () => freePort()));
  expect(new Set(ports).size).toBe(ports.length);
  const servers = ports.map(() => createServer());
  try {
    await Promise.all(servers.map((server, index) => listen(server, ports[index]!)));
  } finally {
    await Promise.all(servers.map(close));
  }
});

it("holds distinct claims across processes until their delayed TCP listens", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const script = `
    import { freePort } from ${JSON.stringify(new URL("./loopbackPort.test-support.ts", import.meta.url).href)};
    const ports = await Promise.all(Array.from({ length: 16 }, () => freePort()));
    console.log(JSON.stringify(ports));
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `;
  const children = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const servers: Server[] = [];
  try {
    const groups = await Promise.all(
      children.map(async (child) => {
        let output = "";
        for await (const chunk of child.stdout) {
          output += String(chunk);
          if (output.includes("\n")) return JSON.parse(output.trim()) as number[];
        }
        throw new Error("port claimant exited without reporting ports");
      }),
    );
    const ports = groups.flat();
    expect(new Set(ports).size).toBe(ports.length);
    servers.push(...ports.map(() => createServer()));
    await Promise.all(servers.map((server, index) => listen(server, ports[index]!)));
  } finally {
    await Promise.all(servers.map(close));
    await Promise.all(
      children.map(async (child) => {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }),
    );
  }
});
