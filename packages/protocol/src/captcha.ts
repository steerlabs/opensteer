import type { JsonSchema } from "./json.js";
import { enumSchema, integerSchema, objectSchema, stringSchema } from "./json.js";
import { pageRefSchema, type PageRef } from "./identity.js";

export type CaptchaType = "recaptcha-v2" | "hcaptcha" | "turnstile";
export type CaptchaProvider = "2captcha" | "capsolver";

export interface CaptchaDetectionResult {
  readonly type: CaptchaType;
  readonly siteKey: string;
  readonly pageUrl: string;
}

export interface OpensteerCaptchaSolveInput {
  readonly provider: CaptchaProvider;
  readonly apiKey: string;
  readonly pageRef?: PageRef;
  readonly timeoutMs?: number;
  readonly type?: CaptchaType;
  readonly siteKey?: string;
  readonly pageUrl?: string;
}

export interface OpensteerCaptchaSolveOutput {
  readonly captcha: CaptchaDetectionResult;
  readonly token: string;
  readonly injected: boolean;
  readonly provider: CaptchaProvider;
}

export const captchaTypeSchema: JsonSchema = enumSchema(
  ["recaptcha-v2", "hcaptcha", "turnstile"] as const,
  {
    title: "CaptchaType",
  },
);

export const captchaProviderSchema: JsonSchema = enumSchema(["2captcha", "capsolver"] as const, {
  title: "CaptchaProvider",
});

export const captchaDetectionResultSchema: JsonSchema = objectSchema(
  {
    type: captchaTypeSchema,
    siteKey: stringSchema({ minLength: 1 }),
    pageUrl: stringSchema({ minLength: 1 }),
  },
  {
    title: "CaptchaDetectionResult",
    required: ["type", "siteKey", "pageUrl"],
  },
);

export const opensteerCaptchaSolveInputSchema: JsonSchema = objectSchema(
  {
    provider: captchaProviderSchema,
    apiKey: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
    timeoutMs: integerSchema({ minimum: 1 }),
    type: captchaTypeSchema,
    siteKey: stringSchema({ minLength: 1 }),
    pageUrl: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerCaptchaSolveInput",
    required: ["provider", "apiKey"],
  },
);

export const opensteerCaptchaSolveOutputSchema: JsonSchema = objectSchema(
  {
    captcha: captchaDetectionResultSchema,
    token: stringSchema({ minLength: 1 }),
    injected: { type: "boolean" },
    provider: captchaProviderSchema,
  },
  {
    title: "OpensteerCaptchaSolveOutput",
    required: ["captcha", "token", "injected", "provider"],
  },
);
