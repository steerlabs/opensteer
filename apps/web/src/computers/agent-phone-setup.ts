import type { AgentPhoneArtifact } from "@opensteer/agent-phone-setup";
import { agentPhoneApkMaxBytes } from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { readBoundedJson, readBoundedResponse } from "@opensteer/shared/boundedJson";

/** Where a web build serves the Agent Phone app that `pnpm build:agent-phone` put in it. */
const artifactPaths = {
  apk: "/agent-phone/opensteer-agent-phone.apk",
  manifest: "/agent-phone/agent-phone.json",
} as const;

/**
 * The Agent Phone app this Opensteer carries, still unverified — the setup
 * engine checks the APK against its manifest before using either — or null
 * when this build was made without it.
 *
 * The desktop app reads its bundled copy through its bridge; a browser reads
 * the copy its own origin serves.
 */
export async function loadAgentPhoneArtifact(input: {
  readonly bridge: Pick<OpensteerDesktopBridge, "readAgentPhoneArtifact"> | null;
  readonly signal: AbortSignal;
}): Promise<AgentPhoneArtifact | null> {
  if (input.bridge) return input.bridge.readAgentPhoneArtifact();
  const manifestResponse = await fetch(artifactPaths.manifest, {
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  // The page's server answers any path it has no file for with the app's own
  // HTML, so a build without the manifest shows up as a page, not a 404.
  const contentType = manifestResponse.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (
    manifestResponse.status === 404 ||
    (manifestResponse.ok && contentType !== "application/json")
  ) {
    await manifestResponse.body?.cancel();
    return null;
  }
  if (!manifestResponse.ok) {
    throw new Error(`The Agent Phone app could not be loaded (HTTP ${manifestResponse.status}).`);
  }
  const manifest = await readBoundedJson(manifestResponse, {
    maximumBytes: 16 * 1_024,
    signal: input.signal,
  });
  const apkResponse = await fetch(artifactPaths.apk, {
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  if (!apkResponse.ok) {
    throw new Error(`The Agent Phone app could not be loaded (HTTP ${apkResponse.status}).`);
  }
  const bytes = await readBoundedResponse(apkResponse, {
    maximumBytes: agentPhoneApkMaxBytes,
    signal: input.signal,
  });
  return { bytes, manifest };
}
