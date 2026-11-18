/** Recognize the PluginEngine app's own skill documents in telemetry without naming anyone else's. */
import { Effect } from "effect";
import { Hex } from "effect/encoding";
import { pluginEngineSkillDigests } from "./pluginEngine-skill-digests.gen.ts";

/**
 * Record a skill document an agent read on the current span. A document whose content is a file
 * the PluginEngine app publishes is named by skill and file. Every other skill belongs to a customer's
 * app, so only its source is recorded, never the app, skill or file name. Matching on content also
 * tells a renamed PluginEngine app and a customer skill that reuses an PluginEngine skill name apart.
 */
export const annotateSkillRead = (document: {
  readonly name: string;
  readonly file: string;
  readonly content: string;
}): Effect.Effect<void> =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(document.content)),
  ).pipe(
    Effect.flatMap((digest) => {
      const path = `${document.name}/${document.file}`;
      return Effect.annotateCurrentSpan(
        Object.hasOwn(pluginEngineSkillDigests, path) &&
          pluginEngineSkillDigests[path] === Hex.encode(new Uint8Array(digest))
          ? {
              "pluginEngine.skill.operation": "read",
              "pluginEngine.skill.source": "pluginEngine",
              "pluginEngine.skill.name": document.name,
              "pluginEngine.skill.file": document.file,
            }
          : { "pluginEngine.skill.operation": "read", "pluginEngine.skill.source": "customer" },
      );
    }),
  );
