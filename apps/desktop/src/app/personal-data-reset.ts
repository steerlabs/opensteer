import type { PersonalDeploymentSupervisor } from "../supervisor/personal-deployment-supervisor.js";

export function desktopPersonalDataReset(options: {
  readonly personal: Pick<PersonalDeploymentSupervisor, "oldData" | "startFresh">;
  readonly quiesce: () => Promise<void>;
  readonly clearSession: (deploymentId: string) => Promise<void>;
  readonly restart: () => void;
}) {
  let pending: Promise<void> | null = null;
  return {
    oldData: () =>
      options.personal.oldData
        ? { ...options.personal.oldData, entries: [...options.personal.oldData.entries] }
        : null,
    startFresh(): Promise<void> {
      if (pending) return pending;
      const plan = options.personal.oldData;
      if (!plan) return Promise.reject(new Error("No old Personal database is awaiting reset."));
      const operation = (async () => {
        await options.quiesce();
        await options.personal.startFresh({ restart: false });
        await options.clearSession(plan.deploymentId);
        options.restart();
      })();
      pending = operation;
      void operation.catch(() => {
        if (pending === operation) pending = null;
      });
      return operation;
    },
  };
}
