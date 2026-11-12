import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { loadavg } from "node:os";
import { expect, it } from "vitest";
import { z } from "zod";
import { teamApiVersion } from "../packages/deployment-authority/src/index.js";
import { startTeamSystem, teamCondition } from "./team-system.test-support.js";
import { perfChannels, perfHistory } from "./team-performance.test-support.js";
import {
  startShapingProxy,
  linkProfiles,
  type ProfileName,
} from "./mobile-network/proxy.test-support.js";

export const teamNetworkScenarios = [
  "team-cold-attach",
  "team-open-channel",
  "team-open-thread",
  "team-reconnect",
  "team-network-change",
] as const;
const options = process.env.OPENSTEER_MOBILE_BENCH_OPTIONS
  ? z
      .object({
        profile: z.string(),
        seed: z.string(),
        scenario: z.string(),
        runs: z.coerce.number().int().positive(),
        out: z.string(),
      })
      .parse(JSON.parse(process.env.OPENSTEER_MOBILE_BENCH_OPTIONS))
  : null;
const run =
  options &&
  ["all", "team", "team-media"].includes(options.seed) &&
  (options.scenario === "all" || options.scenario.startsWith("team-"))
    ? it
    : // The mobile benchmark CLI supplies this opt-in measurement matrix.
      it.skip;
run(
  "measures the team page through the real shared client and shaped mobile link",
  async () => {
    if (!options) throw new Error("Missing benchmark options");
    const samples: Record<string, unknown>[] = [];
    const reportPath = options.seed === "all" ? `${options.out}.team.json` : options.out;
    const report = async (status: string) => {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            version: 1,
            status,
            node: process.version,
            teamApiVersion,
            sharedMachine: true,
            loadAverage: loadavg(),
            methodology:
              "Production team Host and TeamSessionClient; stored authenticated fixture session. HTTP/WS proxy models shared bandwidth and propagation. Timings exclude TLS, radio and React. Wire bytes are actual uncompressed transport; gzip-equivalent payload bytes are reported separately. Media originals are padded PNG fixtures; only previews load on the page. Two joined team sessions, one selected connection, as on mobile.",
            samples,
          },
          null,
          2,
        ) + "\n",
      );
    };
    try {
      for (const seed of options.seed === "all" ? ["team", "team-media"] : [options.seed])
        for (const profile of (options.profile === "all"
          ? Object.keys(linkProfiles)
          : [options.profile]) as ProfileName[])
          for (let repeat = 0; repeat < options.runs; repeat++) {
            const teams = [await startTeamSystem("Acme"), await startTeamSystem("Other")];
            const proxies: Awaited<ReturnType<typeof startShapingProxy>>[] = [];
            try {
              const team = teams[0]!,
                owner = await team.setup();
              const otherOwner = await teams[1]!.setup();
              const inactive = await teams[1]!.session(otherOwner, "Inactive joined team");
              const channels = await perfChannels(team, owner, 2);
              await perfHistory(team, owner, channels, 100);
              const root = (
                await team.database
                  .selectFrom("teamMessages")
                  .select("id")
                  .where("channelId", "=", channels[0]!)
                  .orderBy("id")
                  .executeTakeFirstOrThrow()
              ).id;
              for (let n = 0; n < 20; n++)
                await team.host.team.chat.send(
                  { kind: "human", userId: owner },
                  {
                    channelId: channels[0]!,
                    threadRootId: root,
                    bodyMarkdown: `Reply ${n}`,
                    clientMessageId: crypto.randomUUID(),
                    mentions: [],
                    attachmentIds: [],
                  },
                );
              if (seed === "team-media") {
                const pixel = Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=",
                  "base64",
                );
                const preview = Buffer.concat([pixel, Buffer.alloc(48 * 1024 - pixel.length)]);
                const original = Buffer.concat([
                  preview,
                  Buffer.alloc(8 * 1024 * 1024 - preview.length),
                ]);
                for (let n = 0; n < 4; n++) {
                  const file = await team.host.team.files.upload(
                    { kind: "human", userId: owner },
                    channels[0]!,
                    {
                      clientUploadId: crypto.randomUUID(),
                      filename: `large-${n}.png`,
                      mediaType: "image/png",
                      sizeBytes: original.length,
                      sha256: createHash("sha256").update(original).digest("hex"),
                      previewSizeBytes: preview.length,
                    },
                    { original: Readable.from([original]), preview: Readable.from([preview]) },
                  );
                  await team.host.team.chat.send(
                    { kind: "human", userId: owner },
                    {
                      channelId: channels[0]!,
                      threadRootId: null,
                      clientMessageId: crypto.randomUUID(),
                      bodyMarkdown: `Image ${n}`,
                      mentions: [],
                      attachmentIds: [file.id],
                    },
                  );
                }
              }
              const proxy = await startShapingProxy(team.origin, linkProfiles[profile]);
              proxies.push(proxy);
              const payloads: { path: string; bytes: number; gzip: number }[] = [];
              const selected = await team.session(
                owner,
                "Mobile team benchmark",
                new URL(proxy.origin),
                (path, body) =>
                  payloads.push({
                    path,
                    bytes: body.byteLength,
                    gzip: path.startsWith("/v1/team/files")
                      ? body.byteLength
                      : gzipSync(body).byteLength,
                  }),
              );
              const client = selected.client;
              const waitChannel = () =>
                teamCondition(
                  client,
                  () => client.getSnapshot().channel?.throughSeq ?? undefined,
                  "Team channel never synchronized",
                  15000,
                );
              const waitThread = () =>
                teamCondition(
                  client,
                  () => client.getSnapshot().thread?.throughSeq ?? undefined,
                  "Team thread never synchronized",
                  15000,
                );
              const measure = async (name: string, work: () => Promise<void>) => {
                const downBefore = proxy.connections.reduce((n, c) => n + c.bytesDown, 0),
                  upBefore = proxy.connections.reduce((n, c) => n + c.bytesUp, 0),
                  requestBefore = proxy.requests.length,
                  payloadBefore = payloads.length,
                  started = performance.now();
                await work();
                const observed = payloads.slice(payloadBefore);
                const row = {
                  seed,
                  profile,
                  scenario: name,
                  run: repeat + 1,
                  elapsedMs: performance.now() - started,
                  bytesDown: proxy.connections.reduce((n, c) => n + c.bytesDown, 0) - downBefore,
                  bytesUp: proxy.connections.reduce((n, c) => n + c.bytesUp, 0) - upBefore,
                  payloadBytes: observed.reduce((n, p) => n + p.bytes, 0),
                  gzipEquivalentPayloadBytes: observed.reduce((n, p) => n + p.gzip, 0),
                  requests: proxy.requests.slice(requestBefore).map((r) => r.path),
                  joinedTeams: 2,
                  activeTeamSockets: selected.sockets.size,
                  inactiveTeamSockets: inactive.sockets.size,
                  loadAverage: loadavg(),
                };
                samples.push(row);
                console.info(`TEAM_NETWORK ${JSON.stringify(row)}`);
                await report("running");
                expect(inactive.sockets.size).toBe(0);
                expect(row.requests.some((path) => /members|knowledge|original/u.test(path))).toBe(
                  false,
                );
              };
              const selectedScenarios =
                options.scenario === "all"
                  ? teamNetworkScenarios
                  : teamNetworkScenarios.filter((name) => name === options.scenario);
              const attach = async () => {
                await client.load();
                client.selectChannel(channels[0]!);
                await waitChannel();
              };
              if (selectedScenarios.includes("team-cold-attach"))
                await measure("team-cold-attach", attach);
              else await attach();
              if (seed === "team-media")
                await measure("team-media-previews", async () => {
                  for (const file of client
                    .getSnapshot()
                    .channel!.messages.flatMap((row) => row.attachments))
                    await client.file(file);
                });
              if (selectedScenarios.includes("team-open-channel"))
                await measure("team-open-channel", async () => {
                  client.selectChannel(channels[1]!);
                  await waitChannel();
                });
              if (selectedScenarios.includes("team-open-thread"))
                await measure("team-open-thread", async () => {
                  client.selectChannel(channels[0]!);
                  await waitChannel();
                  client.selectThread(channels[0]!, root);
                  await waitThread();
                });
              if (selectedScenarios.includes("team-reconnect") && !client.getSnapshot().thread) {
                client.selectChannel(channels[0]!);
                await waitChannel();
                client.selectThread(channels[0]!, root);
                await waitThread();
              }
              if (selectedScenarios.includes("team-reconnect"))
                await measure("team-reconnect", async () => {
                  client.disconnect();
                  proxy.dropConnections();
                  const message = await team.host.team.chat.send(
                    { kind: "human", userId: owner },
                    {
                      channelId: channels[0]!,
                      threadRootId: root,
                      clientMessageId: crypto.randomUUID(),
                      bodyMarkdown: "While offline",
                      mentions: [],
                      attachmentIds: [],
                    },
                  );
                  client.connect();
                  await teamCondition(
                    client,
                    () =>
                      client
                        .getSnapshot()
                        .thread?.messages.find((row) => row.id === message.message.id),
                    "Team reconnect lost its offline reply",
                    15000,
                  );
                });
              if (selectedScenarios.includes("team-network-change"))
                await measure("team-network-change", async () => {
                  client.disconnect();
                  proxy.dropConnections();
                  const seen = payloads.length;
                  client.connect();
                  await teamCondition(
                    client,
                    () =>
                      client.getSnapshot().connection === "connected" && payloads.length > seen
                        ? true
                        : undefined,
                    "Team network change never synchronized",
                    15000,
                  );
                });
            } finally {
              for (const proxy of proxies) await proxy.close();
              for (const team of teams.reverse()) await team.close();
            }
          }
      await report("complete");
      console.info(`Team JSON report: ${reportPath}`);
    } catch (error) {
      await report("failed");
      throw error;
    }
  },
  3600000,
);
