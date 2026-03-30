import type { CaptchaType } from "@opensteer/protocol";

import type { CaptchaSolveRequest, CaptchaSolverAdapter } from "./types.js";

const CAPSOLVER_CREATE_TASK_URL = "https://api.capsolver.com/createTask";
const CAPSOLVER_GET_TASK_RESULT_URL = "https://api.capsolver.com/getTaskResult";

export function createCapSolver(apiKey: string): CaptchaSolverAdapter {
  return {
    provider: "capsolver",
    solve: async (input) => {
      const taskId = await createTask(apiKey, input);
      const solution = await pollTask(apiKey, taskId, input.signal);
      return {
        token: extractCaptchaToken(solution),
      };
    },
  };
}

async function createTask(apiKey: string, input: CaptchaSolveRequest): Promise<number | string> {
  const response = await fetch(CAPSOLVER_CREATE_TASK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: toCapSolverTaskType(input.type),
        websiteURL: input.pageUrl,
        websiteKey: input.siteKey,
      },
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const payload = (await response.json()) as {
    readonly errorId?: number;
    readonly errorCode?: string;
    readonly errorDescription?: string;
    readonly taskId?: number | string;
  };
  if (!response.ok || payload.errorId !== 0 || payload.taskId === undefined) {
    throw new Error(
      `CapSolver createTask failed${payload.errorCode === undefined ? "" : `: ${payload.errorCode}`}${payload.errorDescription === undefined ? "" : ` (${payload.errorDescription})`}`,
    );
  }
  return payload.taskId;
}

async function pollTask(
  apiKey: string,
  taskId: number | string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted?.();
    await sleep(3_000, signal);
    const response = await fetch(CAPSOLVER_GET_TASK_RESULT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const payload = (await response.json()) as {
      readonly errorId?: number;
      readonly errorCode?: string;
      readonly errorDescription?: string;
      readonly status?: string;
      readonly solution?: Record<string, unknown>;
    };
    if (!response.ok || payload.errorId !== 0) {
      throw new Error(
        `CapSolver getTaskResult failed${payload.errorCode === undefined ? "" : `: ${payload.errorCode}`}${payload.errorDescription === undefined ? "" : ` (${payload.errorDescription})`}`,
      );
    }
    if (payload.status === "ready" && payload.solution !== undefined) {
      return payload.solution;
    }
  }
  throw new Error("CapSolver solve timed out");
}

function toCapSolverTaskType(type: CaptchaType): string {
  switch (type) {
    case "recaptcha-v2":
      return "ReCaptchaV2TaskProxyLess";
    case "hcaptcha":
      return "HCaptchaTaskProxyLess";
    case "turnstile":
      return "AntiTurnstileTaskProxyLess";
  }
}

function extractCaptchaToken(solution: Record<string, unknown>): string {
  const token =
    readString(solution.token) ??
    readString(solution.gRecaptchaResponse) ??
    readString(solution.captchaKey);
  if (token === undefined) {
    throw new Error("CapSolver returned a solution without a token");
  }
  return token;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("captcha solve aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
