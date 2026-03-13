import type { JsonSchema } from "./json.js";
import { OPENSTEER_PROTOCOL_MEDIA_TYPE, OPENSTEER_PROTOCOL_REST_BASE_PATH } from "./version.js";
import { requestEnvelopeSchema, responseEnvelopeSchema } from "./envelopes.js";
import { opensteerOperationSpecifications, type OpensteerOperationName } from "./operations.js";

export type OpensteerHttpMethod = "POST";

export interface OpensteerRestEndpointDescriptor {
  readonly name: OpensteerOperationName;
  readonly method: OpensteerHttpMethod;
  readonly path: string;
  readonly description: string;
  readonly mediaType: string;
  readonly requestSchema: JsonSchema;
  readonly responseSchema: JsonSchema;
}

export const opensteerRestEndpoints: readonly OpensteerRestEndpointDescriptor[] =
  opensteerOperationSpecifications.map((spec) => ({
    name: spec.name,
    method: "POST",
    path: `${OPENSTEER_PROTOCOL_REST_BASE_PATH}/operations/${spec.name}`,
    description: spec.description,
    mediaType: OPENSTEER_PROTOCOL_MEDIA_TYPE,
    requestSchema: requestEnvelopeSchema(spec.inputSchema),
    responseSchema: responseEnvelopeSchema(spec.outputSchema),
  }));
