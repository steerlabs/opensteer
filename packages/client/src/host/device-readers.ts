import { z } from "zod";
import {
  DeviceIntegrationConnectionSummaryViewSchema,
  DeviceComputerAppSetupRequestViewSchema,
} from "@opensteer/integration-core";
import { hostApi } from "@opensteer/protocol";

const connections = z
  .array(
    z.union([
      DeviceIntegrationConnectionSummaryViewSchema,
      hostApi["integrations.get"].success.shape.connections.element,
    ]),
  )
  .max(1000);
const dashboard = hostApi["integrations.get"].success.extend({ connections });
const setup = hostApi["integration.computer.setup.list"].success.extend({
  requests: z
    .array(
      z.union([
        DeviceComputerAppSetupRequestViewSchema,
        hostApi["integration.computer.setup.list"].success.shape.requests.element,
      ]),
    )
    .max(1000),
});
const commands = z.union([
  hostApi["commands.dispatch"].success,
  z.object({
    type: z.literal("integration.computer.setup.set"),
    connection: DeviceIntegrationConnectionSummaryViewSchema.nullable(),
  }),
]);

export function clientRpcSuccessSchema(name: keyof typeof hostApi): z.ZodType {
  switch (name) {
    case "integrations.get":
      return dashboard;
    case "integration.computer.setup.list":
      return setup;
    case "commands.dispatch":
      return commands;
    default:
      return hostApi[name].success;
  }
}
