import type {
  DesktopLocalExecutionStatus,
  OpensteerDesktopBridge,
} from "@opensteer/protocol/desktop";

export function observeLocalExecutionStatus(
  bridge: Pick<OpensteerDesktopBridge, "getLocalExecutionStatus" | "onLocalExecutionStatusChanged">,
  deploymentId: DesktopLocalExecutionStatus["deploymentId"],
  listener: (status: DesktopLocalExecutionStatus) => void,
  failed: (error: unknown) => void,
): () => void {
  let active = true;
  let receivedPush = false;
  const acceptPush = (status: DesktopLocalExecutionStatus) => {
    if (status.deploymentId !== deploymentId) return;
    receivedPush = true;
    if (active) listener(status);
  };
  const acceptInitial = (status: DesktopLocalExecutionStatus) => {
    if (receivedPush) return;
    if (active && status.deploymentId === deploymentId) listener(status);
  };
  const unsubscribe = bridge.onLocalExecutionStatusChanged(acceptPush);
  void bridge.getLocalExecutionStatus({ deploymentId }).then(acceptInitial, (error: unknown) => {
    if (active) failed(error);
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
