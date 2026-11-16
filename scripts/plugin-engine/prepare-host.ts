import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { writeWorkerdHostBundle } from "@opensteer/plugin-engine-sdk/node/build";
const file = resolve(process.argv[2] ?? "apps/host/node_modules/.cache/plugin-engine-bridge.json");
await mkdir(dirname(file), { recursive: true });
await Effect.runPromise(writeWorkerdHostBundle(file).pipe(Effect.provide(NodeServices.layer)));
