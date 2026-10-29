import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { delay } from "@opensteer/shared/delay";
import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import {
  Ed25519PortableFsProductAuthorizationSigner,
  PortableFsManagerClient,
} from "../packages/workspace-portablefs/src/control-plane.js";
import { PortableFsRenewalScopeFencedError } from "../packages/workspace-portablefs/src/errors.js";
import type { PortableFsMountGrant } from "../packages/workspace-portablefs/src/schemas.js";

const managerServerName = "manager.test";
const productIssuer = "opensteer-test";
const authorizationDomain = "opensteer-test";
const operatorId = "opensteer-test";
const planSignatureDomain = Buffer.from("portablefs-cell-plan-v2\0");

interface ControlIdentity {
  readonly ca: Buffer;
  readonly cert: Buffer;
  readonly key: Buffer;
}

interface CellPlan {
  readonly cell_id: string;
  readonly generation: number;
  readonly release_id: string;
  readonly volumes: readonly CellVolumePlan[];
}

interface CellVolumePlan {
  readonly authority_generation: number;
  readonly authority_id: string;
  readonly listen_port: number;
  readonly phase: string;
  readonly project_id: number;
  readonly service_gid: number;
  readonly service_uid: number;
  readonly volume_id: string;
}

class PortableFsManagerHttpError extends Error {
  readonly httpStatus: number;
  readonly remoteCode: string | undefined;

  constructor(httpStatus: number, remoteCode: string | undefined, body: string) {
    super(`PortableFS manager HTTP ${httpStatus}: ${body.slice(0, 1_000)}`);
    this.name = "PortableFsManagerHttpError";
    this.httpStatus = httpStatus;
    this.remoteCode = remoteCode;
  }
}

export async function verifyPortableFsManagerIntegration(options: {
  readonly managerBinary: string;
  readonly sourceDirectory: string;
  readonly temporaryDirectory: string;
}): Promise<{
  readonly expiredEnrollmentOutcome: "EXPIRED";
  readonly firstVolumeEnrollmentSurvivedSecondVolumeIssuance: true;
  readonly initialGrantSequence: number;
  readonly mountEnrollmentOutcome: "ABSENT" | "CLOSED" | "EXPIRED" | "REVOKED";
  readonly managerReleaseId: string;
  readonly fenceRenewalDenied: true;
  readonly postRevocationRenewalDenied: true;
  readonly reauthorizationSequence: number;
  readonly renewalFenceEpoch: number;
  readonly sameVolumeEnrollmentSuperseded: true;
  readonly staleEpochFenced: true;
  readonly volumeIds: readonly [string, string];
}> {
  const pki = join(options.temporaryDirectory, "hosted-pki");
  const cellId = randomUUID();
  await run("bash", [
    join(options.sourceDirectory, "deploy/gcp/generate-hosted-pki.sh"),
    pki,
    managerServerName,
    cellId,
    productIssuer,
    operatorId,
  ]);
  const port = await freePort();
  const manager = spawn(
    options.managerBinary,
    [
      `-listen=127.0.0.1:${port}`,
      `-state-file=${join(options.temporaryDirectory, "manager.state")}`,
      `-tls-cert=${join(pki, "manager/tls/manager.cert")}`,
      `-tls-key=${join(pki, "manager/tls/manager.key")}`,
      `-control-client-ca=${join(pki, "manager/trust/control-client-ca.pem")}`,
      `-plan-signing-key=${join(pki, "manager/keys/plan-signing.key")}`,
      `-capability-signing-key=${join(pki, "manager/keys/capability-signing.key")}`,
      `-authority-ca-cert=${join(pki, "manager/trust/authority-ca.pem")}`,
      `-authority-ca-key=${join(pki, "manager/keys/authority-ca.key")}`,
      `-mount-client-ca-cert=${join(pki, "manager/trust/mount-client-ca.pem")}`,
      `-mount-client-ca-key=${join(pki, "manager/keys/mount-client-ca.key")}`,
      `-mount-enrollment-ca-cert=${join(pki, "manager/trust/mount-enrollment-ca.pem")}`,
      `-mount-enrollment-ca-key=${join(pki, "manager/keys/mount-enrollment-ca.key")}`,
      "-grant-lifetime=3s",
      "-mount-enrollment-lease=6s",
      `-product-issuer-key=${productIssuer}=${join(pki, "manager/trust/product-public.pem")}`,
    ],
    { shell: false, stdio: ["ignore", "ignore", "pipe"] },
  );
  const managerStderr = boundedStderr(manager, 2 * 1_024 * 1_024);
  const baseUrl = new URL(`https://127.0.0.1:${port}/`);
  let stage = "Manager startup";
  try {
    const operator = await loadIdentity(pki, "operator/operator.cert", "operator/operator.key");
    const cell = await loadIdentity(pki, "cell/cell.cert", "cell/cell.key");
    const product = await loadIdentity(
      pki,
      "product/product-client.cert",
      "product/product-client.key",
    );
    await waitUntilReady(baseUrl, operator, manager);
    stage = "cell registration";
    await controlRequest(baseUrl, operator, "/v1/cells", {
      body: {
        authority_dns_zone: "authority.test",
        authority_host: "127.0.0.1",
        availability_zone: "test-zone-1",
        capacity_bytes: 8 * 1024 * 1024 * 1024,
        capacity_inodes: 1_000_000,
        id: cellId,
        pool: "product",
      },
      idempotencyKey: "opensteer-register-cell",
      method: "POST",
    });
    const emptyPlan = await cellPlan(baseUrl, cell, cellId, pki);
    await observeCell(baseUrl, cell, emptyPlan, [], new Map(), "empty");

    const productSigningKey = createPrivateKey(
      await readFile(join(pki, "product/product-signing.key")),
    );
    const portableFs = new PortableFsManagerClient({
      authorizationDomain,
      baseUrl,
      productIssuer,
      signer: new Ed25519PortableFsProductAuthorizationSigner(productSigningKey),
      tls: {
        caCertificatePem: product.ca,
        clientCertificatePem: product.cert,
        clientPrivateKeyPem: product.key,
        serverName: managerServerName,
      },
    });
    stage = "volume creation";
    const created = await portableFs.createVolume(
      { owner: "opensteer-owner-test", quotaBytes: 128 * 1_024 * 1_024, quotaInodes: 50_000 },
      { idempotencyKey: "opensteer-create-volume-a" },
    );
    if (created.state !== "PROVISIONING") {
      throw new Error(`PortableFS manager created volume in unexpected state ${created.state}`);
    }

    stage = "first volume provisioning";
    const firstPlan = await cellPlan(baseUrl, cell, cellId, pki);
    const firstVolume = requireOneVolume(firstPlan, created.id);
    const authorityCsrs = new Map<string, string>();
    const firstAuthority = await createAuthorityIdentity(
      options.temporaryDirectory,
      "authority-1",
      firstVolume.authority_id,
    );
    authorityCsrs.set(firstVolume.volume_id, firstAuthority.csrPem);
    await observeCell(baseUrl, cell, firstPlan, [firstVolume], authorityCsrs, "first");
    const servingPlan = await cellPlan(baseUrl, cell, cellId, pki);
    const servingVolume = requireOneVolume(servingPlan, created.id);
    if (servingVolume.phase !== "SERVE") {
      throw new Error(`PortableFS manager did not publish a serving plan: ${servingVolume.phase}`);
    }
    await observeCell(baseUrl, cell, servingPlan, [servingVolume], authorityCsrs, "first-serving");

    stage = "second volume creation";
    const createdSecond = await portableFs.createVolume(
      { owner: "opensteer-owner-test", quotaBytes: 128 * 1_024 * 1_024, quotaInodes: 50_000 },
      { idempotencyKey: "opensteer-create-volume-b" },
    );
    if (createdSecond.state !== "PROVISIONING") {
      throw new Error(
        `PortableFS manager created second volume in unexpected state ${createdSecond.state}`,
      );
    }

    stage = "second volume provisioning";
    const secondPlan = await cellPlan(baseUrl, cell, cellId, pki);
    const secondPlanVolumes = [
      requireOneVolume(secondPlan, created.id),
      requireOneVolume(secondPlan, createdSecond.id),
    ] as const;
    const secondAuthority = await createAuthorityIdentity(
      options.temporaryDirectory,
      "authority-2",
      secondPlanVolumes[1].authority_id,
    );
    authorityCsrs.set(secondPlanVolumes[1].volume_id, secondAuthority.csrPem);
    await observeCell(baseUrl, cell, secondPlan, secondPlanVolumes, authorityCsrs, "second");
    const readyPlan = await cellPlan(baseUrl, cell, cellId, pki);
    const readyPlanVolumes = [
      requireOneVolume(readyPlan, created.id),
      requireOneVolume(readyPlan, createdSecond.id),
    ] as const;
    for (const volume of readyPlanVolumes) {
      if (volume.phase !== "SERVE") {
        throw new Error(`PortableFS manager did not publish a serving plan: ${volume.phase}`);
      }
    }
    await observeCell(baseUrl, cell, readyPlan, readyPlanVolumes, authorityCsrs, "ready");
    const ready = await portableFs.getVolume(created.id);
    const readySecond = await portableFs.getVolume(createdSecond.id);
    if (ready.state !== "READY") throw new Error(`PortableFS volume did not reach READY`);
    if (readySecond.state !== "READY") {
      throw new Error(`Second PortableFS volume did not reach READY`);
    }

    stage = "unscoped enrollment renewal and product revocation";
    const mountKey = join(options.temporaryDirectory, "mount-client.key");
    const mountCsr = join(options.temporaryDirectory, "mount-client.csr");
    await run("openssl", ["genpkey", "-algorithm", "ED25519", "-out", mountKey]);
    await run("openssl", [
      "req",
      "-new",
      "-key",
      mountKey,
      "-out",
      mountCsr,
      "-subj",
      "/CN=opensteer-run-test",
    ]);
    const clientCertificateRequestPem = await readFile(mountCsr, "utf8");
    const initialIdentity = {
      csrPem: clientCertificateRequestPem,
      key: await readFile(mountKey),
    };
    const now = Math.floor(Date.now() / 1_000);
    const initialInput = {
      access: "write" as const,
      authorization: {
        expiresUnix: now + 600,
        nonce: "opensteer-initial-grant",
        notBeforeUnix: now - 5,
      },
      clientCertificateRequestPem,
      owner: ready.owner,
      subject: "opensteer-run-test",
    };
    const initial = await portableFs.issueAutomaticMountGrant(created.id, initialInput, {
      idempotencyKey: "opensteer-initial-grant",
    });
    const replay = await portableFs.issueAutomaticMountGrant(created.id, initialInput, {
      idempotencyKey: "opensteer-initial-grant",
    });
    if (JSON.stringify(replay) !== JSON.stringify(initial)) {
      throw new Error("PortableFS manager did not exactly replay the initial mount receipt");
    }
    if (initial.enrollment.id === "" || initial.manager.url !== baseUrl.origin) {
      throw new Error("PortableFS manager returned an invalid automatic mount enrollment");
    }
    const initialRenewal = enrollmentRenewalProof(
      initial,
      initialIdentity,
      "opensteer-enrollment-reauthorization-1",
    );
    const reauthorization = await renewEnrollment(baseUrl, product.ca, initialRenewal);
    const revoked = await portableFs.revokeMountEnrollment(
      initial.volumeId,
      initial.enrollment.id,
      "opensteer-verifier-run-terminal",
    );
    if (!["ABSENT", "CLOSED", "EXPIRED", "REVOKED"].includes(revoked.outcome)) {
      throw new Error("PortableFS manager left a product-revoked mount enrollment active");
    }
    await requireEnrollmentRenewalEnded(baseUrl, product.ca, initialRenewal, "product revocation");

    // The renewal-scope contract is proven through enrollment renewal itself.
    // Product revocation would manufacture the terminal fact under test, so no
    // revocation call is allowed in this section.
    stage = "renewal scope and epoch fence";
    const fenceScope = "opensteer-verifier-machine";
    const firstVolumeIdentity = await createMountIdentity(
      options.temporaryDirectory,
      "scope-volume-a-first",
    );
    const secondVolumeIdentity = await createMountIdentity(
      options.temporaryDirectory,
      "scope-volume-b-first",
    );
    const replacementIdentity = await createMountIdentity(
      options.temporaryDirectory,
      "scope-volume-a-second",
    );
    const fencedInput = (epoch: number, nonce: string, csrPem: string) => ({
      access: "write" as const,
      authorization: { expiresUnix: now + 600, nonce, notBeforeUnix: now - 5 },
      clientCertificateRequestPem: csrPem,
      owner: ready.owner,
      renewalEpoch: epoch,
      renewalScope: fenceScope,
      subject: `opensteer-run-test-epoch-${epoch}`,
    });
    const firstVolumeFirst = await portableFs.issueAutomaticMountGrant(
      created.id,
      fencedInput(1, "opensteer-scope-volume-a-first", firstVolumeIdentity.csrPem),
      { idempotencyKey: "opensteer-scope-volume-a-first" },
    );
    const firstVolumeFirstRenewal = enrollmentRenewalProof(
      firstVolumeFirst,
      firstVolumeIdentity,
      "opensteer-scope-volume-a-first-renewal",
    );
    await renewEnrollment(baseUrl, product.ca, firstVolumeFirstRenewal);

    const secondVolumeFirst = await portableFs.issueAutomaticMountGrant(
      createdSecond.id,
      fencedInput(1, "opensteer-scope-volume-b-first", secondVolumeIdentity.csrPem),
      { idempotencyKey: "opensteer-scope-volume-b-first" },
    );
    const secondVolumeFirstRenewal = enrollmentRenewalProof(
      secondVolumeFirst,
      secondVolumeIdentity,
      "opensteer-scope-volume-b-first-renewal",
    );
    await renewEnrollment(baseUrl, product.ca, secondVolumeFirstRenewal);
    await renewEnrollment(baseUrl, product.ca, firstVolumeFirstRenewal);

    const firstVolumeSecond = await portableFs.issueAutomaticMountGrant(
      created.id,
      fencedInput(1, "opensteer-scope-volume-a-second", replacementIdentity.csrPem),
      { idempotencyKey: "opensteer-scope-volume-a-second" },
    );
    await requireEnrollmentRenewalEnded(
      baseUrl,
      product.ca,
      firstVolumeFirstRenewal,
      "same-scope same-volume issuance",
    );
    await renewEnrollment(baseUrl, product.ca, secondVolumeFirstRenewal);
    const firstVolumeSecondRenewal = enrollmentRenewalProof(
      firstVolumeSecond,
      replacementIdentity,
      "opensteer-scope-volume-a-second-renewal",
    );
    await renewEnrollment(baseUrl, product.ca, firstVolumeSecondRenewal);

    const advanced = await portableFs.advanceRenewalFences("opensteer-verifier-stop", [
      { epoch: 2, scope: fenceScope },
      { epoch: 7, scope: `${fenceScope}-sentinel` },
    ]);
    if (
      advanced.fences[0]?.scope !== fenceScope ||
      advanced.fences[0].epoch !== 2 ||
      advanced.fences[1]?.scope !== `${fenceScope}-sentinel` ||
      advanced.fences[1].epoch !== 7
    ) {
      throw new Error("PortableFS manager did not preserve batch fence response order");
    }
    await requireEnrollmentRenewalEnded(
      baseUrl,
      product.ca,
      firstVolumeSecondRenewal,
      "epoch-2 batch fence",
    );
    await requireEnrollmentRenewalEnded(
      baseUrl,
      product.ca,
      secondVolumeFirstRenewal,
      "epoch-2 batch fence across volumes",
    );
    const convergent = await portableFs.advanceRenewalFences("opensteer-verifier-stop-replay", [
      { epoch: 1, scope: fenceScope },
    ]);
    if (convergent.fences[0]?.epoch !== 2) {
      throw new Error("PortableFS manager regressed the renewal fence on a lower-epoch advance");
    }

    const belowFenceIdentity = await createMountIdentity(
      options.temporaryDirectory,
      "fence-below-floor",
    );
    let staleEpochFenced = false;
    try {
      await portableFs.issueAutomaticMountGrant(
        created.id,
        fencedInput(1, "opensteer-fence-below-floor", belowFenceIdentity.csrPem),
        { idempotencyKey: "opensteer-fence-grant-below-floor" },
      );
    } catch (error) {
      staleEpochFenced = error instanceof PortableFsRenewalScopeFencedError;
    }
    if (!staleEpochFenced) {
      throw new Error("PortableFS manager issued below the renewal-scope high-water mark");
    }

    stage = "enrollment lease expiry";
    const expiringIdentity = await createMountIdentity(
      options.temporaryDirectory,
      "expiring-enrollment",
    );
    const expiryNow = Math.floor(Date.now() / 1_000);
    const expiring = await portableFs.issueAutomaticMountGrant(
      createdSecond.id,
      {
        access: "write",
        authorization: {
          expiresUnix: expiryNow + 600,
          nonce: "opensteer-expiring-enrollment",
          notBeforeUnix: expiryNow - 5,
        },
        clientCertificateRequestPem: expiringIdentity.csrPem,
        owner: readySecond.owner,
        subject: "opensteer-expiring-enrollment",
      },
      { idempotencyKey: "opensteer-expiring-enrollment" },
    );
    const expiringRenewal = enrollmentRenewalProof(
      expiring,
      expiringIdentity,
      "opensteer-expiring-enrollment-renewal",
    );
    await renewEnrollment(baseUrl, product.ca, expiringRenewal);
    await delay(7_000);
    const expiredOutcome = await rawRevokeEnrollment(
      baseUrl,
      product,
      createdSecond.id,
      expiring.enrollment.id,
    );
    if (expiredOutcome !== "EXPIRED") {
      throw new Error(`PortableFS manager reported lapsed enrollment as ${expiredOutcome}`);
    }
    await requireEnrollmentRenewalEnded(
      baseUrl,
      product.ca,
      expiringRenewal,
      "enrollment lease expiry",
    );

    return {
      expiredEnrollmentOutcome: "EXPIRED",
      fenceRenewalDenied: true,
      firstVolumeEnrollmentSurvivedSecondVolumeIssuance: true,
      initialGrantSequence: initial.sequence,
      mountEnrollmentOutcome: revoked.outcome,
      managerReleaseId: initial.managerReleaseId,
      postRevocationRenewalDenied: true,
      reauthorizationSequence: reauthorization.sequence,
      renewalFenceEpoch: convergent.fences[0]!.epoch,
      sameVolumeEnrollmentSuperseded: true,
      staleEpochFenced: true,
      volumeIds: [created.id, createdSecond.id],
    };
  } catch (error) {
    throw new Error(
      `PortableFS Manager integration failed during ${stage}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await stopProcess(manager, managerStderr);
  }
}

interface MountIdentity {
  readonly csrPem: string;
  readonly key: Buffer;
}

async function createAuthorityIdentity(
  directory: string,
  name: string,
  authorityId: string,
): Promise<MountIdentity> {
  const keyPath = join(directory, `${name}.key`);
  const csrPath = join(directory, `${name}.csr`);
  await run("openssl", ["genpkey", "-algorithm", "ED25519", "-out", keyPath]);
  await run("openssl", [
    "req",
    "-new",
    "-key",
    keyPath,
    "-out",
    csrPath,
    "-subj",
    `/CN=${authorityId}`,
  ]);
  return { csrPem: await readFile(csrPath, "utf8"), key: await readFile(keyPath) };
}

interface EnrollmentRenewalProof {
  readonly grant: PortableFsMountGrant;
  readonly idempotencyKey: string;
  readonly identity: MountIdentity;
  readonly sequence: number;
  readonly sessionId: string;
}

async function createMountIdentity(directory: string, name: string): Promise<MountIdentity> {
  const keyPath = join(directory, `${name}.key`);
  const csrPath = join(directory, `${name}.csr`);
  await run("openssl", ["genpkey", "-algorithm", "ED25519", "-out", keyPath]);
  await run("openssl", ["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${name}`]);
  return { csrPem: await readFile(csrPath, "utf8"), key: await readFile(keyPath) };
}

function enrollmentRenewalProof(
  grant: PortableFsMountGrant,
  identity: MountIdentity,
  idempotencyKey: string,
): EnrollmentRenewalProof {
  return {
    grant,
    idempotencyKey,
    identity,
    sequence: 1,
    sessionId: randomBytes(16).toString("base64url"),
  };
}

async function renewEnrollment(
  baseUrl: URL,
  controlCa: Buffer,
  proof: EnrollmentRenewalProof,
): Promise<{ readonly sequence: number; readonly sessionId: string }> {
  const response = (await controlRequest(
    baseUrl,
    {
      ca: controlCa,
      cert: Buffer.from(proof.grant.enrollment.certificatePem),
      key: proof.identity.key,
    },
    `/v1/mount-enrollments/${encodeURIComponent(proof.grant.enrollment.id)}/reauthorizations`,
    {
      body: {
        client_csr_pem: proof.identity.csrPem,
        sequence: proof.sequence,
        session_id: proof.sessionId,
      },
      idempotencyKey: proof.idempotencyKey,
      method: "POST",
    },
  )) as { readonly sequence?: unknown; readonly session_id?: unknown };
  if (response.sequence !== proof.sequence || response.session_id !== proof.sessionId) {
    throw new Error("PortableFS manager returned a mismatched enrollment renewal binding");
  }
  return { sequence: response.sequence, sessionId: response.session_id };
}

async function requireEnrollmentRenewalEnded(
  baseUrl: URL,
  controlCa: Buffer,
  proof: EnrollmentRenewalProof,
  transition: string,
): Promise<void> {
  try {
    await renewEnrollment(baseUrl, controlCa, proof);
  } catch (error) {
    if (
      error instanceof PortableFsManagerHttpError &&
      error.httpStatus === 410 &&
      error.remoteCode === "controlplane: mount enrollment has ended"
    ) {
      return;
    }
    throw new Error(`PortableFS manager returned the wrong denial after ${transition}`, {
      cause: error,
    });
  }
  throw new Error(`PortableFS manager renewed an ended enrollment after ${transition}`);
}

async function rawRevokeEnrollment(
  baseUrl: URL,
  identity: ControlIdentity,
  volumeId: string,
  enrollmentId: string,
): Promise<string> {
  const response = (await controlRequest(
    baseUrl,
    identity,
    `/v1/volumes/${encodeURIComponent(volumeId)}/mount-enrollments/${encodeURIComponent(enrollmentId)}/revocation`,
    { body: { reason: "opensteer-expiry-verification" }, method: "PUT" },
  )) as {
    readonly enrollment_id?: unknown;
    readonly outcome?: unknown;
    readonly volume_id?: unknown;
  };
  if (response.volume_id !== volumeId || response.enrollment_id !== enrollmentId) {
    throw new Error("PortableFS manager returned a mismatched enrollment revocation result");
  }
  if (typeof response.outcome !== "string") {
    throw new Error("PortableFS manager omitted the enrollment revocation outcome");
  }
  return response.outcome;
}

async function cellPlan(
  baseUrl: URL,
  identity: ControlIdentity,
  cellId: string,
  pki: string,
): Promise<CellPlan> {
  const envelope = (await controlRequest(baseUrl, identity, `/v1/cells/${cellId}/plan`, {
    method: "GET",
  })) as { token?: unknown };
  if (typeof envelope.token !== "string") throw new Error("PortableFS cell plan omitted token");
  const parts = envelope.token.split(".");
  if (parts.length !== 3 || parts[0] !== "v2" || !parts[1] || !parts[2]) {
    throw new Error("PortableFS cell plan token is malformed");
  }
  const payload = Buffer.from(parts[1], "base64url");
  const signature = Buffer.from(parts[2], "base64url");
  const publicKey = createPublicKey(await readFile(join(pki, "cell/plan-public.pem")));
  if (!verify(null, Buffer.concat([planSignatureDomain, payload]), publicKey, signature)) {
    throw new Error("PortableFS cell plan signature did not verify");
  }
  return JSON.parse(payload.toString("utf8")) as CellPlan;
}

async function observeCell(
  baseUrl: URL,
  identity: ControlIdentity,
  plan: CellPlan,
  volumes: readonly CellVolumePlan[],
  authorityCsrs: ReadonlyMap<string, string>,
  suffix: string,
): Promise<void> {
  await controlRequest(baseUrl, identity, `/v1/cells/${plan.cell_id}/observations`, {
    body: {
      agent_release_id: "opensteer-test-agent",
      cell_id: plan.cell_id,
      helper_release_id: "opensteer-test-helper",
      manager_release_id: plan.release_id,
      observed_unix: Math.floor(Date.now() / 1_000),
      plan_generation: plan.generation,
      volumes: volumes.map((volume) => {
        const authorityCsrPem = authorityCsrs.get(volume.volume_id);
        if (!authorityCsrPem) {
          throw new Error(`PortableFS verifier has no authority CSR for ${volume.volume_id}`);
        }
        return {
          authority_absent: false,
          authority_csr_pem: authorityCsrPem,
          authority_generation: volume.authority_generation,
          authority_running: true,
          listen_port: volume.listen_port,
          project_id: volume.project_id,
          provisioned: true,
          service_gid: volume.service_gid,
          service_uid: volume.service_uid,
          volume_id: volume.volume_id,
        };
      }),
    },
    idempotencyKey: `opensteer-observe-${suffix}`,
    method: "POST",
  });
}

function requireOneVolume(plan: CellPlan, volumeId: string): CellVolumePlan {
  const volume = plan.volumes.find((candidate) => candidate.volume_id === volumeId);
  if (!volume) throw new Error(`PortableFS cell plan omitted volume ${volumeId}`);
  return volume;
}

async function loadIdentity(
  pki: string,
  certificatePath: string,
  keyPath: string,
): Promise<ControlIdentity> {
  const [ca, cert, key] = await Promise.all([
    readFile(join(pki, "offline/control-ca.pem")),
    readFile(join(pki, certificatePath)),
    readFile(join(pki, keyPath)),
  ]);
  return { ca, cert, key };
}

async function waitUntilReady(
  baseUrl: URL,
  identity: ControlIdentity,
  manager: ReturnType<typeof spawn>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (manager.exitCode !== null) throw new Error("PortableFS manager exited before readiness");
    try {
      await controlRequest(baseUrl, identity, "/healthz", { method: "GET" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("PortableFS manager did not become ready");
}

async function controlRequest(
  baseUrl: URL,
  identity: ControlIdentity,
  path: string,
  options: {
    readonly body?: unknown;
    readonly idempotencyKey?: string;
    readonly method: "GET" | "POST" | "PUT";
  },
): Promise<unknown> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      new URL(path, baseUrl),
      {
        ca: identity.ca,
        cert: identity.cert,
        headers: {
          accept: "application/json",
          ...(body
            ? { "content-length": Buffer.byteLength(body), "content-type": "application/json" }
            : {}),
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        },
        key: identity.key,
        method: options.method,
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        servername: managerServerName,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.from(chunk);
          bytes += value.length;
          if (bytes > 4 * 1_024 * 1_024) {
            response.destroy(new Error("PortableFS manager response exceeded four MiB"));
            return;
          }
          chunks.push(value);
        });
        response.once("error", reject);
        response.once("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            let remoteCode: string | undefined;
            try {
              const envelope = JSON.parse(text) as unknown;
              if (
                envelope &&
                typeof envelope === "object" &&
                !Array.isArray(envelope) &&
                typeof (envelope as { readonly error?: unknown }).error === "string"
              ) {
                remoteCode = (envelope as { readonly error: string }).error;
              }
            } catch {
              // A malformed error body is still a typed HTTP failure; denial
              // assertions require the Manager's exact structured code.
            }
            reject(new PortableFsManagerHttpError(status, remoteCode, text));
            return;
          }
          try {
            resolve(JSON.parse(text) as unknown);
          } catch (error) {
            reject(new Error("PortableFS manager returned invalid JSON", { cause: error }));
          }
        });
      },
    );
    request.setTimeout(5_000, () =>
      request.destroy(new Error("PortableFS manager request timed out")),
    );
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function boundedStderr(child: ReturnType<typeof spawn>, maxBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes <= maxBytes) chunks.push(value);
    else child.kill("SIGKILL");
  });
  return chunks;
}

async function stopProcess(
  child: ReturnType<typeof spawn>,
  stderr: readonly Buffer[],
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const result = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    ),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
  ]);
  if (!result) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  if (result && result.code !== 0 && result.signal !== "SIGTERM") {
    throw new Error(
      `PortableFS manager exited unexpectedly: ${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`,
    );
  }
}

async function run(command: string, arguments_: readonly string[]): Promise<void> {
  const child = spawn(command, [...arguments_], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer | string) => {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 8 * 1_024 * 1_024) child.kill("SIGKILL");
      else (stream === child.stdout ? stdout : stderr).push(value);
    });
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? -1));
  });
  if (bytes > 8 * 1_024 * 1_024) throw new Error(`${command} output exceeded eight MiB`);
  if (code !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-4_000)}`,
    );
  }
}
