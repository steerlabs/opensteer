import { sign, verify } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { Ed25519KeySource } from "@opensteer/shared/proof";
import { normalizeRunnerPrivateKey, normalizeRunnerEd25519PublicKey } from "./proof.js";

export interface DeviceLeaveContext {
  readonly deploymentId: string;
  readonly runnerId: string;
  readonly issuedAt: string;
}
export interface DeviceSessionBindContext extends DeviceLeaveContext {
  readonly sessionId: string;
}

export function deviceSessionBindTranscript(input: DeviceSessionBindContext): readonly string[] {
  return [
    "opensteer-device-session-bind-v1",
    input.deploymentId,
    input.runnerId,
    input.sessionId,
    input.issuedAt,
  ];
}
export function deviceLeaveTranscript(input: DeviceLeaveContext): readonly string[] {
  return ["opensteer-device-leave-v1", input.deploymentId, input.runnerId, input.issuedAt];
}
export function createDeviceSessionBindingSignature(
  key: Ed25519KeySource,
  input: DeviceSessionBindContext,
): string {
  return sign(
    null,
    bytes(deviceSessionBindTranscript(input)),
    normalizeRunnerPrivateKey(key),
  ).toString("base64url");
}
export function verifyDeviceSessionBindingSignature(
  key: Ed25519KeySource,
  input: DeviceSessionBindContext & { readonly signature: string },
  now = Date.now(),
): boolean {
  const issuedAt = Date.parse(input.issuedAt);
  return (
    Number.isFinite(issuedAt) &&
    Math.abs(now - issuedAt) <= 5 * 60_000 &&
    verifySignature(key, deviceSessionBindTranscript(input), input.signature)
  );
}
export function createDeviceLeaveSignature(
  key: Ed25519KeySource,
  input: DeviceLeaveContext,
): string {
  return sign(null, bytes(deviceLeaveTranscript(input)), normalizeRunnerPrivateKey(key)).toString(
    "base64url",
  );
}
// A persisted leave obligation remains deliverable after a long offline interval.
export function verifyDeviceLeaveSignature(
  key: Ed25519KeySource,
  input: DeviceLeaveContext & { readonly signature: string },
): boolean {
  return (
    Number.isFinite(Date.parse(input.issuedAt)) &&
    verifySignature(key, deviceLeaveTranscript(input), input.signature)
  );
}
function bytes(transcript: readonly string[]): Buffer {
  return Buffer.from(canonicalJson(transcript), "utf8");
}
function verifySignature(
  key: Ed25519KeySource,
  transcript: readonly string[],
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  return verify(
    null,
    bytes(transcript),
    normalizeRunnerEd25519PublicKey(key),
    Buffer.from(signature, "base64url"),
  );
}
