import type { CaptchaProvider, CaptchaType } from "@opensteer/protocol";

export interface CaptchaSolveRequest {
  readonly type: CaptchaType;
  readonly siteKey: string;
  readonly pageUrl: string;
  readonly signal?: AbortSignal;
}

export interface CaptchaSolverAdapter {
  readonly provider: CaptchaProvider;
  solve(input: CaptchaSolveRequest): Promise<{ readonly token: string }>;
}
