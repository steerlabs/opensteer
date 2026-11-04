import { expect, it, vi } from "vitest";
import type { DesktopSupervisorOutput } from "@opensteer/protocol/desktop-supervisor";
import type { DesktopUpdateOperation } from "@opensteer/protocol/maintenance";
import type { DesktopUpdater } from "../app/desktop-updater.js";
import type { DesktopSupervisor } from "./desktop-supervisor.js";
import { DesktopUpdateExecutor } from "./desktop-update-executor.js";

it.each(["staged", "installing"] as const)(
  "reconciles a %s operation only after a new incarnation, without downloading or restarting",
  async (phase) => {
    for (const currentVersion of ["1.0.0", "1.0.1"]) {
      let receive!: (message: DesktopSupervisorOutput) => void;
      const acknowledge = vi.fn(async () => {});
      const remoteAction = vi.fn();
      const install = vi.fn();
      const executor = new DesktopUpdateExecutor({
        supervisor: {
          incarnationId: crypto.randomUUID(),
          subscribe: (listener: typeof receive) => {
            receive = listener;
            return () => {};
          },
          acknowledge,
          state: () => {},
        } as unknown as DesktopSupervisor,
        updater: {
          state: () => ({ currentVersion }),
          subscribe: () => () => {},
          remoteAction,
        } as unknown as DesktopUpdater,
        install,
      });
      try {
        const operation: DesktopUpdateOperation = {
          id: crypto.randomUUID(),
          state: phase,
          targetVersion: "1.0.1",
          fromVersion: "1.0.0",
          incarnationId: crypto.randomUUID(),
          intent: { action: "update" },
          detail: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        receive({ type: "desktop-update.operation", operation });
        await vi.waitFor(() => expect(acknowledge).toHaveBeenCalledOnce(), { timeout: 1000 });
        expect(acknowledge).toHaveBeenCalledWith(
          expect.objectContaining({
            state: currentVersion === "1.0.1" ? "succeeded" : "failed",
            detail: currentVersion === "1.0.1" ? null : "not-applied",
            targetVersion: "1.0.1",
          }),
        );
        expect(remoteAction).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
      } finally {
        executor.stop();
      }
    }
  },
);
