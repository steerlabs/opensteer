import { IntegrationDefinitionSchema } from "@opensteer/integration-core";

const identifier = { type: "string", minLength: 1, maxLength: 256 } as const;
const cursor = { type: "string", minLength: 1, maxLength: 2048 } as const;
const date = { type: "string", format: "date-time", maxLength: 40 } as const;
const nullableDate = { ...date, type: ["string", "null"] } as const;
const limit = { type: "integer", minimum: 1, maximum: 100, default: 50 } as const;
const scope = { type: "string", enum: ["all", "selected"] } as const;
const mediaKind = { type: "string", enum: ["image", "video", "live-photo"] } as const;
const nextCursor = { ...cursor, type: ["string", "null"] } as const;

const asset = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: identifier,
    createdAt: nullableDate,
    modifiedAt: nullableDate,
    mediaKind,
    width: { type: "integer", minimum: 0 },
    height: { type: "integer", minimum: 0 },
    durationSeconds: { type: ["number", "null"], minimum: 0 },
    favorite: { type: "boolean" },
  },
  required: [
    "id",
    "createdAt",
    "modifiedAt",
    "mediaKind",
    "width",
    "height",
    "durationSeconds",
    "favorite",
  ],
} as const;

/** iPhone-only definitions never enter the Mac helper's grant/contract map. */
export const iphoneAppIntegrations = [
  IntegrationDefinitionSchema.parse({
    id: "iphone-location",
    provider: "iphone-location",
    name: "Location",
    description:
      "Get this iPhone's current location while Opensteer is open, with the accuracy iPhone Settings allows. No location history or background tracking.",
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This iPhone" }],
    config: {
      platforms: ["ios"],
      accessLabels: { read: "Can read", readWrite: "Can read" },
      accessSummaries: {
        read: "Allows reading a current location and its accuracy while Opensteer is open on this iPhone. No background tracking or location history.",
        readWrite: "Allows reading a current location. Location cannot be changed.",
      },
      operations: [
        {
          name: "current_location",
          title: "Get current location",
          description:
            "Read one current location fix, including its time and accuracy. Approximate permission is usable and is labelled approximate. Zero maximum age requires a new fix for this call. If no fresh fix is available, the call fails; it never substitutes an old location or prompts for permission.",
          effect: "read",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              maxAgeSeconds: { type: "integer", minimum: 0, maximum: 300, default: 30 },
            },
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              latitude: { type: "number", minimum: -90, maximum: 90 },
              longitude: { type: "number", minimum: -180, maximum: 180 },
              horizontalAccuracyMeters: { type: "number", exclusiveMinimum: 0 },
              capturedAt: date,
              accuracy: { type: "string", enum: ["precise", "approximate"] },
            },
            required: [
              "latitude",
              "longitude",
              "horizontalAccuracyMeters",
              "capturedAt",
              "accuracy",
            ],
          },
        },
      ],
    },
  }),
  IntegrationDefinitionSchema.parse({
    id: "iphone-photos",
    provider: "iphone-photos",
    name: "Photos",
    description:
      "Read metadata for photos, videos and user albums visible to Opensteer on this iPhone. Photo contents, location, hidden assets and shared albums are not returned.",
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This iPhone" }],
    config: {
      platforms: ["ios"],
      accessLabels: { read: "Can read metadata", readWrite: "Can read metadata" },
      accessSummaries: {
        read: "Allows reading dates, dimensions, media types, favorites and user album names for the photos iPhone Settings permits. Photos cannot be viewed, changed or deleted; photo locations are not shared.",
        readWrite: "Allows reading photo metadata only. Photos cannot be changed or deleted.",
      },
      operations: [
        {
          name: "list_assets",
          title: "List photo metadata",
          description:
            "List visible user-library metadata, newest first; equal dates sort by asset ID, and undated assets come last. Continue with nextCursor and identical filters. The library can change between pages; this is not a snapshot. Only selected assets are visible under limited permission. No image bytes, file names, location or iCloud downloads are requested.",
          effect: "read",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              limit,
              cursor,
              albumId: identifier,
              mediaKinds: {
                type: "array",
                items: mediaKind,
                minItems: 1,
                maxItems: 3,
                uniqueItems: true,
              },
              createdAfter: date,
              createdBefore: date,
              favoritesOnly: { type: "boolean" },
            },
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              scope,
              assets: { type: "array", items: asset, maxItems: 100 },
              nextCursor,
            },
            required: ["scope", "assets", "nextCursor"],
          },
        },
        {
          name: "list_albums",
          title: "List photo albums",
          description:
            "List visible user-created albums, ordered by title and ID. Counts include only visible user-library photos and videos. Smart, shared and hidden albums are excluded. Continue with nextCursor; the library may change between calls.",
          effect: "read",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { limit, cursor },
          },
          outputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              scope,
              albums: {
                type: "array",
                maxItems: 100,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: identifier,
                    title: { type: "string", maxLength: 256 },
                    assetCount: { type: "integer", minimum: 0 },
                  },
                  required: ["id", "title", "assetCount"],
                },
              },
              nextCursor,
            },
            required: ["scope", "albums", "nextCursor"],
          },
        },
      ],
    },
  }),
] as const;
