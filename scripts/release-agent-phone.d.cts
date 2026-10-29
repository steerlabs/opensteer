import type { z } from "zod";

export interface AgentPhoneReleaseReceipt {
  schemaVersion: 1;
  sourceRevision: string;
  version: string;
  apkSha256: string;
  apkSize: number;
  manifestSha256: string;
  signingCertSha256: string;
}
export interface InspectedAgentPhoneApk {
  apkSha256: string;
  apkSize: number;
  buildType: "debug" | "release";
  minSdk: number;
  packageName: "com.opensteer.agentphone";
  signingCertSha256: string;
  versionCode: number;
  versionName: string;
}
export const agentPhoneReleaseSignerSha256: string;
export const agentPhoneBuildToolsVersion: string;
export const agentPhoneReceiptName: string;
export const agentPhoneReleaseReceiptSchema: z.ZodType<AgentPhoneReleaseReceipt>;
export function androidBuildTools(
  environment?: Readonly<Record<string, string | undefined>>,
): string;
export function inspectAgentPhoneApk(
  apk: string,
  buildTools: string,
  buildType: "debug" | "release",
): InspectedAgentPhoneApk;
export function readAgentPhoneReleaseReceipt(
  filename: string,
  expectedSha256: unknown,
): AgentPhoneReleaseReceipt;
export function verifyAgentPhoneRelease(
  directory: string,
  receiptPath: string,
  options: {
    sourceRevision: unknown;
    version: unknown;
    receiptSha256: unknown;
    buildTools?: string;
  },
): AgentPhoneReleaseReceipt;
