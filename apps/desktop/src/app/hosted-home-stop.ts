import { ThreadIdSchema } from "@opensteer/core";
import type { DesktopPersonalDeploymentState, HostApiClient } from "@opensteer/protocol";
import { hostApiData } from "../connections/desktop-host-api.js";
import { homeReadTimeoutMs } from "./desktop-activity.js";
import type { LocalStopPart } from "./local-stop.js";

export type HostedHomeStopHost = Pick<
  HostApiClient,
  "commands.dispatch" | "personal.shell.get" | "thread.snapshot.get"
>;

export interface HostedHomeStopOptions {
  /** The Home this Mac hosts, if any, and whether its processes are running. */
  readonly hostedHome: () => Promise<{
    readonly deploymentId: string;
    readonly state: DesktopPersonalDeploymentState;
  } | null>;
  /** That Home's typed API under its own owner session, whichever Home the window shows. */
  readonly host: (deploymentId: string) => HostedHomeStopHost;
}

/** A Home whose processes are not running has no agent work to end. */
const notRunning: ReadonlySet<DesktopPersonalDeploymentState> = new Set(["stopped"]);

/**
 * Stop everything's part for the Home this Mac hosts. Its running work is
 * ended through the Home's own Stop, the `run.interrupt` the app's Stop sends,
 * so every task shows as stopped rather than failed. No new work starts while
 * stopped because the Home's Runner reads this Mac's saved Stop at each
 * admission and refuses, and the Home keeps that work queued until Resume.
 * The Home itself, the app and the person's own tabs keep running.
 */
export class HostedHomeStop implements LocalStopPart {
  readonly #options: HostedHomeStopOptions;

  constructor(options: HostedHomeStopOptions) {
    this.#options = options;
  }

  /** Settles once the Home confirmed every interrupt; throws when it did not or could not be asked. */
  async pause(): Promise<void> {
    const home = await this.#options.hostedHome();
    if (!home || notRunning.has(home.state)) return;
    const host = this.#options.host(home.deploymentId);
    const shell = hostApiData(
      await host["personal.shell.get"]({}, { signal: AbortSignal.timeout(homeReadTimeoutMs) }),
    );
    const active = shell.tasks.filter(
      (task) => task.status === "running" || task.status === "waiting",
    );
    const results = await Promise.allSettled(active.map((task) => this.#interrupt(host, task.id)));
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed)
      throw new Error(`${failed} task(s) on this Mac’s Home did not confirm they stopped.`);
  }

  /** Resume needs nothing here: the Runner admits again once the saved Stop is cleared. */
  resume(): void {}

  /** One task from Right now, stopped the way the app's Stop stops it. */
  async stopTask(deploymentId: string, threadId: string): Promise<void> {
    await this.#interrupt(this.#options.host(deploymentId), threadId);
  }

  async #interrupt(host: HostedHomeStopHost, threadId: string): Promise<void> {
    const signal = () => AbortSignal.timeout(homeReadTimeoutMs);
    const snapshot = hostApiData(
      await host["thread.snapshot.get"](
        { threadId: ThreadIdSchema.parse(threadId) },
        { signal: signal() },
      ),
    );
    const runs = (snapshot.queue?.runs ?? []).filter((run) => run.status !== "queued");
    for (const run of runs) {
      const result = hostApiData(
        await host["commands.dispatch"](
          {
            type: "run.interrupt",
            runId: run.id,
            threadId: snapshot.thread.id,
            idempotencyKey: crypto.randomUUID(),
          },
          { signal: signal() },
        ),
      );
      if (result.type !== "run.interrupt") throw new Error("The Home answered another command.");
    }
  }
}
