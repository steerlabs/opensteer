import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { getDeviceDefinition } from "@opensteer/integration-catalog/devices";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import { AccessRequests } from "./access-requests.js";

type Options = ConstructorParameters<typeof AccessRequests>[0];

it.each([false, true])(
  "uses an existing device grant only on its own computer (matching=%s)",
  async (matching) => {
    const definition = getDeviceDefinition("apple-calendar")!;
    const computerId = createId("runner");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const connectionId = createIntegrationId("connection");
    const service = new AccessRequests({
      definitions: [definition],
      devices: {
        listDiscoveryInventory: async () => [
          {
            installation: {
              id: installationId,
              title: "Calendar",
              status: "active",
              provenance: {
                definitionId: definition.id,
                definitionDigest: integrationDefinitionDigest(definition),
              },
            },
            accounts: [{ connectionId, account: "Calendar on the first Mac" }],
            servers: [{ id: serverId }],
            readiness: { servers: [{ code: "READY", connectionId, serverId }] },
          },
        ],
      } as unknown as Options["devices"],
      store: {
        listGrants: async () => [
          { installationId, connectionId, status: "active", access: "read" },
        ],
        getComputerConnectionForCall: async () => ({ runnerId: computerId }),
        integrationRequests: {
          createIntegrationAccessRequest: async (payload: object) => ({
            events: [],
            request: { payload },
            replayed: false,
          }),
        },
      } as unknown as Options["store"],
      onDeploymentEvent: () => undefined,
    });
    const result = await service.requestDataApp(
      {
        requestedBy: createId("user"),
        runId: createId("run"),
        threadId: createId("thread"),
        callId: "named-computer",
        reason: "Read Calendar on the requested computer",
      },
      {
        dataApp: "calendar",
        access: "read",
        computerId: matching ? computerId : createId("runner"),
      },
    );
    expect(result).toMatchObject(
      matching
        ? { kind: "granted", name: "Calendar on the first Mac" }
        : {
            kind: "request",
            request: { payload: { installationId, requestedConnectionId: null } },
          },
    );
  },
);
