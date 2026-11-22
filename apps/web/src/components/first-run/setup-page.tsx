import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useShell } from "../app-shell.js";
import { SetupAiStep } from "./setup-ai-step.js";
import {
  forgetSetup,
  pendingSetupStep,
  rememberSetupStep,
  resumeStep,
  setupSteps,
  type SetupStepId,
} from "./setup-memory.js";
import { HomeSetupStep } from "../devices/home-setup-step.js";
import { SetupPhoneStep } from "./setup-phone-step.js";
import { usePersonalRemoteAccess } from "@opensteer/client/react";
import { useWebRemoteAccess } from "../../account/remote-access-port.js";
import { useRemoteAccessOnStart } from "./remote-access-on-start.js";

/**
 * Setup, in up to three short steps: the AI that does the work, Set up this
 * Mac, and a phone. Each step reads live state, so anything
 * done elsewhere — a sign-in in a browser, a permission in System Settings, a
 * mode changed from another device — simply shows. It opens on its own right
 * after this computer is set up, resumes where the person left it, and is in
 * the computer menu any time after.
 */
export function SetupPage() {
  const { desktopBridge, desktopDeployment, hostClient, snapshot } = useShell();
  const navigate = useNavigate();
  const onThisComputer =
    desktopBridge !== null &&
    desktopDeployment?.kind === "personal" &&
    desktopDeployment.onThisComputer;
  const mac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
  const steps = useMemo(() => setupSteps({ mac, onThisComputer }), [mac, onThisComputer]);
  const deploymentId = onThisComputer ? snapshot.deploymentId : null;
  // One Remote access for the whole setup: the phone step shows what turning it on on start
  // is doing, rather than starting a second one beside it.
  const remote = usePersonalRemoteAccess(onThisComputer ? hostClient : null);
  const connect = useWebRemoteAccess(remote);
  useRemoteAccessOnStart(deploymentId, connect);
  const [step, setStep] = useState<SetupStepId>(() =>
    resumeStep(steps, deploymentId ? pendingSetupStep(deploymentId) : null),
  );
  const current = steps.includes(step) ? step : resumeStep(steps, step);
  const index = steps.indexOf(current);
  const progress = { count: steps.length, index };

  useEffect(() => {
    if (deploymentId) rememberSetupStep(deploymentId, current);
  }, [current, deploymentId]);

  const finish = () => {
    if (deploymentId) forgetSetup(deploymentId);
    void navigate("/", { replace: true });
  };
  const next = () => {
    const following = steps[index + 1];
    if (following) setStep(following);
    else finish();
  };
  const back = index > 0 ? () => setStep(steps[index - 1]!) : undefined;

  if (current === "permissions" && desktopBridge) {
    return <HomeSetupStep bridge={desktopBridge} onBack={back} onNext={next} progress={progress} />;
  }
  if (current === "phone" && desktopBridge) {
    return (
      <SetupPhoneStep
        bridge={desktopBridge}
        connect={connect}
        onBack={back}
        onFinish={finish}
        progress={progress}
        remote={remote}
      />
    );
  }
  return (
    <SetupAiStep onBack={back} onNext={steps.length > 1 ? next : finish} progress={progress} />
  );
}
