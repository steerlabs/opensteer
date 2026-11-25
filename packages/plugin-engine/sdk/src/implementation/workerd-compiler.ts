/** Trusted compiler, loaded by the runtime only for a build. It receives no app credentials. */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import apps from "apps/package.json" with { type: "json" };
import framework from "plugin-engine-framework";
import { CompilerFailure, type CompileWorkerApp } from "../contracts/workerd-host.ts";
import { describeBuildCause, RuntimeBuildFailed } from "../contracts/runtime.ts";
import { compileWorkerApp } from "./worker-build.ts";

interface CompilerEnvironment {
  readonly NPM_REGISTRY: string;
  readonly PUBLIC_FETCH: { fetch(request: Request): Promise<Response> };
}

export default class Compiler extends WorkerEntrypoint<CompilerEnvironment> {
  async compile(request: typeof CompileWorkerApp.Type) {
    return Effect.runPromise(
      compileWorkerApp(
        request.files,
        {
          ...(this.env.NPM_REGISTRY === "" ? {} : { registry: this.env.NPM_REGISTRY }),
          publicFetch: (input, init) => this.env.PUBLIC_FETCH.fetch(new Request(input, init)),
          apps: {
            files: {
              "package.json": JSON.stringify({
                name: "apps",
                version: apps.version,
                type: "module",
              }),
              "runtime.json": framework,
            },
          },
        },
        request.public ?? [],
      ).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({
            ok: false as const,
            error: Schema.encodeSync(CompilerFailure)(
              Schema.is(CompilerFailure)(error)
                ? error
                : new RuntimeBuildFailed({ stage: "compile", message: describeBuildCause(error) }),
            ),
          }),
        }),
      ),
    );
  }
}
