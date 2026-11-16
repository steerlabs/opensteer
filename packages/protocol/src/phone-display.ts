import { z } from "zod";
import {
  PhoneDisplayDefinitionIdSchema,
  androidPhoneDefinitionId,
  iphoneScreenDefinitionId,
  type PhoneDisplayDefinitionId,
} from "@opensteer/core";
import {
  AndroidPhoneActionSchema,
  AndroidPhoneActResultSchema,
  AndroidPhoneDispatchActParamsSchema,
  AndroidPhoneInstalledAppsParamsSchema,
  AndroidPhoneInstalledAppsResultSchema,
  AndroidPhoneObservationSchema,
  AndroidPhoneObservationResultSchema,
  AndroidPhoneTargetSchema,
  androidPhoneMaxTimedActionMs,
  androidPhoneTimedActionMs,
} from "./android-phone.js";
import {
  ComputerUseErrorSchema,
  ComputerUseObservationIdSchema,
  ComputerUsePerformedSchema,
  computerUseMaxActions,
  computerUseTreeMaxBytes,
} from "./computer-use.js";
import {
  LoginActContextSchema,
  SealedLoginTextSchema,
  validateSealedLoginActionBindings,
} from "./password-sign-in.js";
import {
  PhoneDisplayNavigationIdSchema,
  type PhoneDisplayActionType,
  type PhoneDisplayNavigationButton,
} from "./devices.js";

export { PhoneDisplayDefinitionIdSchema, androidPhoneDefinitionId, iphoneScreenDefinitionId };
export type { PhoneDisplayDefinitionId };
export {
  PhoneDisplayActionTypeSchema,
  PhoneDisplayNavigationIdSchema,
  PhoneDisplayNavigationButtonSchema,
  PhoneDisplayNavigationButtonsSchema,
} from "./devices.js";
export type { PhoneDisplayActionType, PhoneDisplayNavigationButton } from "./devices.js";
export const phoneDisplayMaxTimedActionMs = androidPhoneMaxTimedActionMs;
export const PhoneDisplayTargetSchema = AndroidPhoneTargetSchema;
export type PhoneDisplayTarget = z.infer<typeof PhoneDisplayTargetSchema>;
export const PhoneDisplayAppIdSchema = z.string().min(1).max(255);
export const PhoneDisplayInstalledAppsParamsSchema = AndroidPhoneInstalledAppsParamsSchema;
export type PhoneDisplayInstalledAppsParams = z.infer<typeof PhoneDisplayInstalledAppsParamsSchema>;
export const PhoneDisplayInstalledAppSchema = z.strictObject({
  label: z.string().min(1).max(200),
  appId: PhoneDisplayAppIdSchema,
});
export type PhoneDisplayInstalledApp = z.infer<typeof PhoneDisplayInstalledAppSchema>;
export const PhoneDisplayInstalledAppsResultSchema = z.strictObject({
  apps: z.array(PhoneDisplayInstalledAppSchema).max(100),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type PhoneDisplayInstalledAppsResult = z.infer<typeof PhoneDisplayInstalledAppsResultSchema>;
const [tap, longPress, swipe, drag, type, clear, , , scroll, wake, wait] =
  AndroidPhoneActionSchema.options;
export const PhoneDisplayActionSchema = z.discriminatedUnion("type", [
  tap,
  longPress,
  swipe,
  drag,
  type,
  clear,
  z.strictObject({ to: PhoneDisplayNavigationIdSchema, type: z.literal("navigate") }),
  z.strictObject({ appId: PhoneDisplayAppIdSchema, type: z.literal("launch") }),
  scroll,
  wake,
  wait,
]);
export type PhoneDisplayAction = z.infer<typeof PhoneDisplayActionSchema>;
export function phoneDisplayTimedActionMs(
  action: Exclude<PhoneDisplayAction, { type: "type" }> | { readonly type: "type" },
): number {
  switch (action.type) {
    case "longPress":
    case "swipe":
    case "drag":
    case "scroll":
    case "wait":
      return androidPhoneTimedActionMs(action);
    default:
      return 0;
  }
}
function validateTimedActions(
  actions: readonly (Exclude<PhoneDisplayAction, { type: "type" }> | { readonly type: "type" })[],
  context: z.RefinementCtx,
): void {
  const total = actions.reduce((sum, action) => sum + phoneDisplayTimedActionMs(action), 0);
  if (total > phoneDisplayMaxTimedActionMs)
    context.addIssue({
      code: "custom",
      message: `Timed actions exceed ${phoneDisplayMaxTimedActionMs} ms`,
    });
}
export const PhoneDisplayActionsSchema = z
  .array(PhoneDisplayActionSchema)
  .min(1)
  .max(computerUseMaxActions)
  .superRefine(validateTimedActions);
const [neutralTap, neutralLongPress, neutralSwipe, neutralDrag, neutralType, ...neutralOther] =
  PhoneDisplayActionSchema.options;
export const PhoneDisplayDispatchActionSchema = z.discriminatedUnion("type", [
  neutralTap,
  neutralLongPress,
  neutralSwipe,
  neutralDrag,
  neutralType.extend({ text: z.union([neutralType.shape.text.options[0], SealedLoginTextSchema]) }),
  ...neutralOther,
]);
export type PhoneDisplayDispatchAction = z.infer<typeof PhoneDisplayDispatchActionSchema>;
export const PhoneDisplayDispatchActionsSchema = z
  .array(PhoneDisplayDispatchActionSchema)
  .min(1)
  .max(computerUseMaxActions)
  .superRefine(validateTimedActions);
export const IphoneScreenActionSchema = z.discriminatedUnion("type", [
  neutralTap,
  neutralLongPress,
  neutralSwipe,
  neutralDrag,
  neutralType.extend({ text: neutralType.shape.text.options[0] }),
  ...neutralOther,
]);
export const IphoneScreenActionsSchema = z
  .array(IphoneScreenActionSchema)
  .min(1)
  .max(computerUseMaxActions)
  .superRefine(validateTimedActions);
export const PhoneDisplayObserveParamsSchema = z.strictObject({});
export const PhoneDisplayDispatchObserveParamsSchema = z.strictObject({
  includeScreenshot: z.boolean(),
});
export const PhoneDisplayCloseParamsSchema = z.strictObject({});
export const PhoneDisplayActParamsSchema = z.strictObject({
  actions: PhoneDisplayActionsSchema,
  observationId: ComputerUseObservationIdSchema,
});
export type PhoneDisplayActParams = z.infer<typeof PhoneDisplayActParamsSchema>;
export const PhoneDisplayDispatchActParamsSchema = PhoneDisplayActParamsSchema.extend({
  actions: PhoneDisplayDispatchActionsSchema,
  includeScreenshot: z.boolean(),
  loginContext: LoginActContextSchema.optional(),
}).superRefine(validateSealedLoginActionBindings);
export const IphoneScreenActParamsSchema = PhoneDisplayActParamsSchema.extend({
  actions: IphoneScreenActionsSchema,
});
export const IphoneScreenDispatchActParamsSchema = IphoneScreenActParamsSchema.extend({
  includeScreenshot: z.boolean(),
});
export type PhoneDisplayDispatchActParams = z.infer<typeof PhoneDisplayDispatchActParamsSchema>;
export const PhoneDisplayScreenshotUnavailableSchema = z.enum([
  "not-requested",
  "screen-off",
  "opensteer-app",
  "failed",
  "locked",
  "protected",
]);
export const PhoneDisplayObservationSchema = z
  .strictObject({
    ...AndroidPhoneObservationSchema.shape,
    foreground: z
      .strictObject({
        label: z.string().min(1).max(255).nullable(),
        appId: PhoneDisplayAppIdSchema,
      })
      .nullable(),
    locked: z.boolean().nullable(),
    secureLock: z.boolean().nullable(),
    screenshotUnavailable: PhoneDisplayScreenshotUnavailableSchema.nullable(),
  })
  .superRefine((observation, context) => {
    const hidden =
      observation.screen === "off" ||
      ["locked", "protected", "opensteer-app"].includes(observation.screenshotUnavailable ?? "");
    if (
      hidden &&
      (observation.tree !== "" ||
        observation.elementCount !== 0 ||
        observation.truncated ||
        observation.screenshot !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Hidden observations contain no screen content",
      });
    if (observation.screen === "off" && observation.screenshotUnavailable !== "screen-off")
      context.addIssue({
        code: "custom",
        message: "A dark screen must say why its content is hidden",
      });
    if ((observation.screenshot === null) === (observation.screenshotUnavailable === null))
      context.addIssue({
        code: "custom",
        message: "An observation carries a screenshot or its unavailable reason",
      });
    if (observation.screenshotUnavailable === "screen-off" && observation.screen !== "off")
      context.addIssue({ code: "custom", message: "Screen-off content requires a dark screen" });
    if (new TextEncoder().encode(observation.tree).byteLength > computerUseTreeMaxBytes)
      context.addIssue({
        code: "custom",
        message: "Observation tree exceeds its UTF-8 byte budget",
      });
    if (
      observation.screenshot !== null &&
      (observation.screenshot.width !== observation.geometry.width ||
        observation.screenshot.height !== observation.geometry.height)
    )
      context.addIssue({
        code: "custom",
        message: "Screenshot geometry must match the observation",
      });
  });
export type PhoneDisplayObservation = z.infer<typeof PhoneDisplayObservationSchema>;
export const PhoneDisplayObservationResultSchema = z.strictObject({
  observation: PhoneDisplayObservationSchema,
});
export const PhoneDisplayActResultSchema = z
  .strictObject({
    error: ComputerUseErrorSchema.shape.error.nullable(),
    observation: PhoneDisplayObservationSchema.nullable(),
    performed: z.array(ComputerUsePerformedSchema).max(computerUseMaxActions),
  })
  .refine(
    (result) => result.error !== null || result.observation !== null,
    "Successful actions require an observation",
  )
  .refine(
    (result) => result.error?.code !== "stale-observation" || result.performed.length === 0,
    "Stale observations perform no actions",
  );
export type PhoneDisplayActResult = z.infer<typeof PhoneDisplayActResultSchema>;
export const PhoneDisplayOperationSchema = z.enum(["observe", "act", "close", "installed_apps"]);
export type PhoneDisplayOperation = z.infer<typeof PhoneDisplayOperationSchema>;

export interface PhoneDisplayActionCapabilities {
  readonly actions: readonly PhoneDisplayActionType[];
  readonly navigationButtons: readonly PhoneDisplayNavigationButton[];
  readonly wake: boolean;
  readonly input: boolean;
  readonly loginText: boolean;
}
export function validatePhoneDisplayActions(
  value: unknown,
  capabilities: PhoneDisplayActionCapabilities,
): PhoneDisplayAction[] {
  const actions = PhoneDisplayActionsSchema.parse(value);
  for (const action of actions) {
    if (!capabilities.actions.includes(action.type))
      throw new Error(`Phone does not advertise ${action.type}`);
    if (
      action.type === "navigate" &&
      !capabilities.navigationButtons.some(({ id }) => id === action.to)
    )
      throw new Error("Phone does not advertise this navigation button");
    if (action.type === "wake" && !capabilities.wake)
      throw new Error("Phone does not support wake");
    if (action.type !== "wait" && action.type !== "wake" && !capabilities.input)
      throw new Error("Phone input is unavailable");
    if (action.type === "type" && typeof action.text !== "string" && !capabilities.loginText)
      throw new Error("Phone does not support login text");
  }
  return actions;
}

function toAndroidAction(action: PhoneDisplayDispatchAction) {
  return action.type === "launch" ? { type: action.type, packageName: action.appId } : action;
}
function fromAndroidAction(action: z.infer<typeof AndroidPhoneActionSchema>): PhoneDisplayAction {
  return action.type === "launch" ? { type: action.type, appId: action.packageName } : action;
}
function fromAndroidObservation(
  value: z.infer<typeof AndroidPhoneObservationSchema>,
): PhoneDisplayObservation {
  const { foreground, ...rest } = value;
  return {
    ...rest,
    foreground:
      foreground === null ? null : { label: foreground.label, appId: foreground.packageName },
  };
}
function toAndroidObservation(value: unknown) {
  const { foreground, ...rest } = PhoneDisplayObservationSchema.parse(value);
  return AndroidPhoneObservationSchema.parse({
    ...rest,
    foreground:
      foreground === null ? null : { label: foreground.label, packageName: foreground.appId },
  });
}
export const IphoneScreenObservationSchema = PhoneDisplayObservationSchema.refine(
  (observation) =>
    observation.locked !== true ||
    (observation.tree === "" &&
      observation.elementCount === 0 &&
      !observation.truncated &&
      observation.screenshot === null &&
      ["locked", "screen-off", "protected"].includes(observation.screenshotUnavailable ?? "")),
  "Locked iPhones expose no screen content",
);
export const IphoneScreenObservationResultSchema = z.strictObject({
  observation: IphoneScreenObservationSchema,
});
export const IphoneScreenActResultSchema = PhoneDisplayActResultSchema.safeExtend({
  observation: IphoneScreenObservationSchema.nullable(),
});
function neutralResult(operation: PhoneDisplayOperation, value: unknown) {
  switch (operation) {
    case "observe":
      return IphoneScreenObservationResultSchema.parse(value);
    case "act":
      return IphoneScreenActResultSchema.parse(value);
    case "installed_apps":
      return PhoneDisplayInstalledAppsResultSchema.parse(value);
    case "close":
      return PhoneDisplayCloseParamsSchema.parse(value);
  }
}
function decodeAndroidResult(operation: PhoneDisplayOperation, value: unknown) {
  switch (operation) {
    case "observe":
      return {
        observation: fromAndroidObservation(
          AndroidPhoneObservationResultSchema.parse(value).observation,
        ),
      };
    case "act": {
      const result = AndroidPhoneActResultSchema.parse(value);
      return {
        ...result,
        observation:
          result.observation === null ? null : fromAndroidObservation(result.observation),
      };
    }
    case "installed_apps": {
      const result = AndroidPhoneInstalledAppsResultSchema.parse(value);
      return {
        ...result,
        apps: result.apps.map(({ label, packageName }) => ({ label, appId: packageName })),
      };
    }
    case "close":
      return PhoneDisplayCloseParamsSchema.parse(value);
  }
}
function encodeAndroidResult(operation: PhoneDisplayOperation, value: unknown) {
  switch (operation) {
    case "observe":
      return {
        observation: toAndroidObservation(
          PhoneDisplayObservationResultSchema.parse(value).observation,
        ),
      };
    case "act": {
      const result = PhoneDisplayActResultSchema.parse(value);
      return AndroidPhoneActResultSchema.parse({
        ...result,
        observation: result.observation === null ? null : toAndroidObservation(result.observation),
      });
    }
    case "installed_apps": {
      const result = PhoneDisplayInstalledAppsResultSchema.parse(value);
      return AndroidPhoneInstalledAppsResultSchema.parse({
        ...result,
        apps: result.apps.map(({ label, appId }) => ({ label, packageName: appId })),
      });
    }
    case "close":
      return PhoneDisplayCloseParamsSchema.parse(value);
  }
}
export interface PhoneDisplayCodec {
  readonly definitionId: PhoneDisplayDefinitionId;
  readonly externalRoute: boolean;
  parseActions(value: unknown): PhoneDisplayAction[];
  encodeParams(operation: PhoneDisplayOperation, value: unknown): unknown;
  encodeActParams(
    value: unknown,
  ): z.infer<typeof AndroidPhoneDispatchActParamsSchema> | PhoneDisplayDispatchActParams;
  decodeResult(operation: PhoneDisplayOperation, value: unknown): ReturnType<typeof neutralResult>;
  encodeResult(operation: PhoneDisplayOperation, value: unknown): unknown;
}
export const phoneDisplayCodecs: Readonly<Record<PhoneDisplayDefinitionId, PhoneDisplayCodec>> = {
  [androidPhoneDefinitionId]: {
    definitionId: androidPhoneDefinitionId,
    externalRoute: false,
    parseActions(value) {
      return PhoneDisplayActionsSchema.parse(
        z
          .array(z.unknown())
          .parse(value)
          .map((action) => {
            const canonical = PhoneDisplayActionSchema.safeParse(action);
            return canonical.success
              ? canonical.data
              : fromAndroidAction(AndroidPhoneActionSchema.parse(action));
          }),
      );
    },
    encodeParams(operation, value) {
      return encodePhoneDisplayParams(this, operation, value);
    },
    encodeActParams(value) {
      const params = PhoneDisplayDispatchActParamsSchema.parse(value);
      return AndroidPhoneDispatchActParamsSchema.parse({
        ...params,
        actions: params.actions.map(toAndroidAction),
      });
    },
    decodeResult: decodeAndroidResult,
    encodeResult: encodeAndroidResult,
  },
  [iphoneScreenDefinitionId]: {
    definitionId: iphoneScreenDefinitionId,
    externalRoute: true,
    parseActions: (value) => IphoneScreenActionsSchema.parse(value),
    encodeParams(operation, value) {
      return encodePhoneDisplayParams(this, operation, value);
    },
    encodeActParams(value) {
      return IphoneScreenDispatchActParamsSchema.parse(value);
    },
    decodeResult: neutralResult,
    encodeResult: neutralResult,
  },
};
export function getPhoneDisplayCodec(definitionId: unknown): PhoneDisplayCodec {
  return phoneDisplayCodecs[PhoneDisplayDefinitionIdSchema.parse(definitionId)];
}

function encodePhoneDisplayParams(
  codec: PhoneDisplayCodec,
  operation: PhoneDisplayOperation,
  value: unknown,
): unknown {
  switch (operation) {
    case "act":
      return codec.encodeActParams(value);
    case "observe":
      return PhoneDisplayDispatchObserveParamsSchema.parse(value);
    case "close":
      return PhoneDisplayCloseParamsSchema.parse(value);
    case "installed_apps":
      return PhoneDisplayInstalledAppsParamsSchema.parse(value);
  }
}

function phoneDisplayJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, {
    io: "input",
    override: ({ jsonSchema }) => {
      // The catalog validator understands enum, while some model tools consume const.
      if ("const" in jsonSchema) jsonSchema.enum = [jsonSchema.const];
    },
  });
}
export const phoneDisplayActionJsonSchema = phoneDisplayJsonSchema(PhoneDisplayActionSchema);
export const phoneDisplayActParamsJsonSchema = phoneDisplayJsonSchema(PhoneDisplayActParamsSchema);
export const phoneDisplayInstalledAppsParamsJsonSchema = phoneDisplayJsonSchema(
  PhoneDisplayInstalledAppsParamsSchema,
);
export const iphoneScreenActParamsJsonSchema = phoneDisplayJsonSchema(IphoneScreenActParamsSchema);

export type PhoneDisplayObservationResult = z.infer<typeof PhoneDisplayObservationResultSchema>;
export type PhoneDisplayObserveParams = z.infer<typeof PhoneDisplayObserveParamsSchema>;
export type PhoneDisplayDispatchObserveParams = z.infer<
  typeof PhoneDisplayDispatchObserveParamsSchema
>;
export type PhoneDisplayCloseParams = z.infer<typeof PhoneDisplayCloseParamsSchema>;
export type IphoneScreenAction = z.infer<typeof IphoneScreenActionSchema>;
export type IphoneScreenActParams = z.infer<typeof IphoneScreenActParamsSchema>;
export type IphoneScreenDispatchActParams = z.infer<typeof IphoneScreenDispatchActParamsSchema>;
export type IphoneScreenObservation = z.infer<typeof IphoneScreenObservationSchema>;
export type IphoneScreenObservationResult = z.infer<typeof IphoneScreenObservationResultSchema>;
export type IphoneScreenActResult = z.infer<typeof IphoneScreenActResultSchema>;
