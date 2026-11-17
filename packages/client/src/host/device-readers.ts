import { z } from "zod";
import {
  DeviceIntegrationConnectionSummaryViewSchema,
  DeviceComputerAppSetupRequestViewSchema,
} from "@opensteer/integration-core";
import {
  ComputerAppSetupListResponseSchema,
  IntegrationDashboardResponseSchema,
  hostApi,
} from "@opensteer/protocol";

const connections = z
  .array(
    z.union([
      DeviceIntegrationConnectionSummaryViewSchema,
      IntegrationDashboardResponseSchema.shape.connections.element,
    ]),
  )
  .max(1000);
const dashboard = IntegrationDashboardResponseSchema.extend({ connections });
const setup = ComputerAppSetupListResponseSchema.extend({
  requests: z
    .array(
      z.union([
        DeviceComputerAppSetupRequestViewSchema,
        ComputerAppSetupListResponseSchema.shape.requests.element,
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
