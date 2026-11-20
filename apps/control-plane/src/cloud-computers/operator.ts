import { readFileSync } from "node:fs";
import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { ControlPlaneError } from "../server/errors.js";
import { billingErrorDetails } from "./billing-error.js";
import type { CloudComputerStore } from "./store.js";

export const cloudComputerOperatorUsage = `Usage: cloud-computer-operator-main.js <command>

  list | show <id>
  suspend <id> <reason> | unsuspend <id> | delete <id>
  reissue-bootstrap <id> [restore-backup.json] | replace <computer-id> <snapshot-id>
  egress-list | egress-add <url> <username> <password-file> [public-ip]
  egress-address <id> <public-ip|clear> | egress-remove <id>
  egress-rotate <id> <username> <password-file> | egress-assign <computer-id>
  backup-list | backup-add <json-file> | backup-rotate <id> <json-file> | backup-remove <id>
  lease-show | lease-release <holder>
  checkout-list | billing-reconcile | claim-retry <computer-id>

For replace, list snapshot IDs on the source VM with sudo opensteer-home snapshots.
The Account does not list a Home's backup repository.`;

export async function runCloudComputerOperator(
  store: CloudComputerStore,
  [action, subject, ...args]: readonly string[],
): Promise<unknown> {
  let result: unknown;
  if (action === "list" && !subject) result = await store.operatorList();
  else if (action === "egress-list" && !subject) result = await store.listEgressEndpoints();
  else if (action === "backup-list" && !subject) result = await store.listBackupTargets();
  else if (action === "lease-show" && !subject) result = await store.provisionerLease();
  else if (action === "lease-release" && subject && args.length === 0) {
    await store.releaseProvisionerLease(z.uuid().parse(subject));
    result = { released: true };
  } else if (action === "checkout-list" && !subject) result = await store.unresolvedCheckouts();
  else if (action === "billing-reconcile" && !subject) {
    const errors: ReturnType<typeof billingErrorDetails>[] = [];
    const ran = await store.reconcileBilling((error) => errors.push(billingErrorDetails(error)));
    result = { ran, errors };
  } else if (action === "backup-add" && subject && args.length === 0)
    result = { id: await store.addBackupTarget(JSON.parse(readFileSync(subject, "utf8"))) };
  else if (action === "backup-rotate" && subject && args.length === 1) {
    await store.rotateBackupTarget(
      z.uuid().parse(subject),
      JSON.parse(readFileSync(args[0]!, "utf8")),
    );
    result = { rotated: true };
  } else if (action === "backup-remove" && subject && args.length === 0) {
    await store.removeBackupTarget(z.uuid().parse(subject));
    result = { removed: true };
  } else if (action === "egress-rotate" && subject && args.length === 2) {
    await store.rotateEgressEndpoint(z.uuid().parse(subject), {
      username: args[0]!,
      password: readFileSync(args[1]!, "utf8").trimEnd(),
    });
    result = { rotated: true };
  } else if (action === "egress-address" && subject && args.length === 1) {
    await store.setEgressAddress(z.uuid().parse(subject), args[0] === "clear" ? null : args[0]!);
    result = { updated: true };
  } else if (action === "egress-add" && subject && (args.length === 2 || args.length === 3)) {
    result = {
      id: await store.addEgressEndpoint({
        url: subject,
        username: args[0]!,
        password: readFileSync(args[1]!, "utf8").trimEnd(),
        ...(args[2] !== undefined ? { publicAddress: args[2] } : {}),
      }),
    };
  } else if (action === "egress-remove" && args.length === 0) {
    await store.removeEgressEndpoint(z.uuid().parse(subject));
    result = { removed: true };
  } else {
    if (!subject) throw new ControlPlaneError("bad_request", cloudComputerOperatorUsage);
    const id = CloudComputerIdSchema.parse(subject);
    if (action === "show" && args.length === 0) result = await store.operatorShow(id);
    else if (action === "egress-assign" && args.length === 0) result = await store.assignEgress(id);
    else if (action === "claim-retry" && args.length === 0) {
      await store.retryClaim(id);
      result = { queued: true };
    } else if (action === "delete" && args.length === 0) result = await store.mutate(id, "delete");
    else if (action === "suspend" && args.length > 0)
      result = await store.mutate(
        id,
        "operator-suspend",
        undefined,
        args.join(" ").trim().slice(0, 1000),
      );
    else if (action === "unsuspend" && args.length === 0)
      result = await store.mutate(id, "operator-unsuspend");
    else if (action === "replace" && args.length === 1)
      result = await store.mutate(id, "replace", undefined, args[0]);
    else if (action === "reissue-bootstrap" && args.length <= 1)
      result = await store.mutate(
        id,
        "reissue",
        undefined,
        args[0] ? readFileSync(args[0], "utf8") : undefined,
      );
    else throw new ControlPlaneError("bad_request", cloudComputerOperatorUsage);
  }
  return result;
}
