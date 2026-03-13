import {
  JSON_SCHEMA_DRAFT_2020_12,
  literalSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

export const OPENSTEER_PROTOCOL_NAME = "opensteer";
export const OPENSTEER_PROTOCOL_VERSION = "0.1.0";
export const OPENSTEER_PROTOCOL_REVISION_DATE = "2026-03-13";
export const OPENSTEER_PROTOCOL_MEDIA_TYPE = `application/vnd.${OPENSTEER_PROTOCOL_NAME}+json;version=${OPENSTEER_PROTOCOL_VERSION}`;
export const OPENSTEER_PROTOCOL_REST_BASE_PATH = "/api/v1";

export type OpensteerProtocolName = typeof OPENSTEER_PROTOCOL_NAME;
export type OpensteerProtocolVersion = typeof OPENSTEER_PROTOCOL_VERSION;

export interface OpensteerProtocolDescriptor {
  readonly protocol: OpensteerProtocolName;
  readonly version: OpensteerProtocolVersion;
  readonly revisionDate: string;
  readonly mediaType: string;
  readonly restBasePath: string;
}

export const opensteerProtocolDescriptor: OpensteerProtocolDescriptor = {
  protocol: OPENSTEER_PROTOCOL_NAME,
  version: OPENSTEER_PROTOCOL_VERSION,
  revisionDate: OPENSTEER_PROTOCOL_REVISION_DATE,
  mediaType: OPENSTEER_PROTOCOL_MEDIA_TYPE,
  restBasePath: OPENSTEER_PROTOCOL_REST_BASE_PATH,
};

export const opensteerProtocolDescriptorSchema: JsonSchema = objectSchema(
  {
    protocol: literalSchema(OPENSTEER_PROTOCOL_NAME),
    version: literalSchema(OPENSTEER_PROTOCOL_VERSION),
    revisionDate: stringSchema({
      format: "date",
      description: "Calendar revision for this protocol snapshot.",
    }),
    mediaType: stringSchema({
      description: "Canonical media type for JSON payloads using this protocol revision.",
    }),
    restBasePath: stringSchema({
      description: "Base HTTP path for the canonical REST transport.",
    }),
  },
  {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "https://opensteer.dev/schemas/protocol/descriptor.json",
    title: "OpensteerProtocolDescriptor",
    required: ["protocol", "version", "revisionDate", "mediaType", "restBasePath"],
  },
);

export function isSupportedProtocolVersion(value: string): value is OpensteerProtocolVersion {
  return value === OPENSTEER_PROTOCOL_VERSION;
}

export function assertSupportedProtocolVersion(value: string): OpensteerProtocolVersion {
  if (!isSupportedProtocolVersion(value)) {
    throw new RangeError(
      `unsupported protocol version ${value}; expected ${OPENSTEER_PROTOCOL_VERSION}`,
    );
  }

  return value;
}
