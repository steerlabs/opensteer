import { DisplayStreamIdSchema } from "./display-stream.js";
export const browserVideoTestHeader = {
  streamId: DisplayStreamIdSchema.parse("dsp_00000000-0000-4000-8000-000000000001"),
  generation: 1,
  sequence: 0,
  ptsUs: 1,
  geometryRevision: 1,
  key: true,
  codec: "avc1.42C01F",
  width: 128,
  height: 128,
  presentation: {
    producerStreamId: "00000000-0000-4000-8000-000000000002",
    documentGeneration: "document",
    authorityEpoch: "epoch",
    drawnRevision: "opaque-certificate",

    rootCssWidth: 100,
    rootCssHeight: 100,

    rasterCrop: { x: 14, y: 14, width: 100, height: 100 },
  },
};
