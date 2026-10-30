import {
  DisplayViewerClientMessageSchema,
  displayViewerCloseCodes,
  encodeDisplayViewerFrame,
  type DisplayViewerServerMessage,
} from "@opensteer/protocol";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import type { WebSocketClient } from "../host/host-session-client.js";

/**
 * The preview phone's home screen as the phone would stream it: one 360×780
 * Constrained Baseline IDR, Annex B with SPS and PPS first, encoded by libx264
 * from the same layout as the phone's passive capture; base64url.
 */
const mockPhoneDisplayKeyframe =
  "AAAAAWdCwB7cFwY-W8BEAAADAAQAAAMA8DxYvgAAAAFozjLIAAABZYiEBLxEYKAAJpccDHAAL3G3333333333333333333331_8fCIQwC7FAAEBDwcEGI6tFtfEP_5EwV111111111111_44RwCFwRcUAAQKvBwBAMRqf1P6pgjrrtbW1ta6666666666667W1ta666666666666666666666666666666666666666666666666666666666666666666666665oJgcAAQFwAG4gCSIAEWddWgT2tra2tra2tra2tra2tra2trT1109PXXXXXXXXXXXXXXXXXXT1109PNigADL5HAAEHOOAAIWVra2tra2tra2trjw__CILjsSmmC-uuuuunrrp6fj__oFYKgcECEedER9PuMS1Ev2na2tra2tra2tr___BVACA6feFMv6gprrrrrp666en_8P8EQMsDwZmWVDaZBdra2tra-Ph_wVV_qmCmuuuuuuuuunrrp6fEMA_9ArBEDgICEekXk0m7W1tbW1tf__0RMEddddddddddPXXT0__4fgkBQKAAIBXlQik1tbW1_8eHkTBTXXXXXXXXXXXT1109P4BgH_BUChL9NPa2tra___wVb_T6YKa66666666666euunp6WlpaWlpa666666666666euv8Ih_wWAowdBEYCIEqjUvwsy-dfi1tbW1tbW1tbW1tbW1tbW1tbWmCmuulpaWlpaWlpaWlpaWlpaWlpaWlpa66___jBCCLBgky3PffffffffffffffffffUO111zccMcNLS0tLS0tLS0tLS0tLS0tLS0tPXXXT11111111111111111109dddPxD__BWDADkAwjL4kABoRABIGVLKVL8GrllVy_a2tra2tra2tra2uPh_6BVBxFBieCBz6nAsQT5dTywmDGuuuunrrrp_AMA_4KgaiCUQnECZECZxJMiSZ2tra2tra2tra2tr__-gVCQFIBMCG0-1fgVtZXTBbXXXXT1110___6BACrFAAEBTa2tra2tra2tra2tt33__iHyJgprp6666fD-IYBwSAwBxAIj6vvvvvvvvvvvvvv___kTBjXT1110__4fgkBEBwICjmX89pO--------__x4dkNv1oEtra1109dddP_4BgHIeCbFa2tra2tra2tr___ImCeuuuuunrrrp__w_BIC4UAA9-V99999999999__iH8iYL6666euuun8QwD_giBFg4CAhHPa2tra2tra2tra2tr___CPqgjrrrp6666elpaWlpaWlpaWlpaWlrrrrrp6666euuuuuuuuuuuuuuuuuunrrrp6666666666666666666euuunrrrrrrrrrrrrrrrrrrp6666f4-H-CsGGByAYRliAEOhAEZAxUsoqX4NuWVuX7W1tbW1tfHw_0CpASoCrhI_JwsQj3J5YTBnXXXXXXXXXT11108zGCgMfH2htra2trazMEzjepgnrrrrrrrrrp6666fD_iGAMFoMMHEAiMRSEtYNuWVuXgxUsoqW1tbW1tbX-Hj9gqRkVYNuWZNzCuWa_iYM6666666666euuuntbW1tbW1tbWuuuuuuuuuunrr_D-IcEIIhJI9y3333333333333333330w_XXXS0tLS0tLS0tLS0tLS0tLS0tLS11111111111111111111111111_xD_wWBwGCTL4OC3z7-07W1tbW1tbW1tbW1tbW1tbW1taYbrrmhyAdTDv_xD8EgKAOBAUcy-VL777777776gprrrrrrrp666en_8AwDka2tra2tra2trT111111109ddPT0tLS0tLS0tLS0tddddddddPXX_H_0CwNCSR4C2FMv-dZ0tbW1tbW1tbW1tbW1tbW1tbW1phuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuvj__w8CQDgBACgpBgOkhsHMNAo3P333334j4_-HgtB0EpgJkjI61KC6uuuuuuuuuuuuuuuuuuuuuuuuuuuuuvA";
export const mockPhoneDisplayPicture = { codec: "avc1.42C01E", width: 360, height: 780 } as const;

type SocketListener = (event: never) => void;

/**
 * The Host's owner viewer socket for one preview phone session: the state a
 * live phone reports, its picture replayed from the cache on join and on a
 * keyframe request. Shared input is accepted and changes nothing; a static
 * screen sends no further frames.
 */
export class MockPhoneDisplaySocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly #listeners = new Map<string, Set<SocketListener>>();

  constructor(availability: "live" | "unsupported" | "ended") {
    this.#later(() => {
      this.readyState = 1;
      this.#emit("open", {});
      if (availability === "ended") {
        this.close(displayViewerCloseCodes.accessEnded, "Display stream ended");
        return;
      }
      if (availability === "unsupported") {
        this.#json({
          type: "display.state",
          state: "unsupported",
          generation: 0,
          width: 0,
          height: 0,
        });
        this.close(displayViewerCloseCodes.ended, "Display unsupported");
        return;
      }
      this.#replay();
    });
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.#later(() => {
      this.readyState = 3;
      this.#emit("close", { code, reason });
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("The mock display socket is not open.");
    const parsed =
      typeof data === "string"
        ? DisplayViewerClientMessageSchema.safeParse(JSON.parse(data))
        : { success: false as const };
    if (!parsed.success) {
      this.close(displayViewerCloseCodes.protocolViolation, "Invalid display command");
      return;
    }
    const message = parsed.data;
    if (message.type === "display.keyframe") {
      this.#later(() => this.#replay());
      return;
    }
  }

  /**
   * The cache is one keyframe of a static screen, replayed as the Host replays
   * it: under its original sequence, named by the state before it.
   */
  #replay(): void {
    const { width, height, codec } = mockPhoneDisplayPicture;
    const sequence = 0;
    this.#json({
      type: "display.state",
      state: "live",
      sharedInput: 1,
      generation: 1,
      width,
      height,
      replayThrough: sequence,
    });
    const frame = encodeDisplayViewerFrame(
      { generation: 1, sequence, ptsUs: 0, key: true, codec, width, height },
      decodeBase64Url(mockPhoneDisplayKeyframe),
    );
    // The display streams always ask for array buffers.
    if (this.readyState === 1) this.#emit("message", { data: frame.slice().buffer });
  }

  #json(message: DisplayViewerServerMessage): void {
    if (this.readyState === 1) this.#emit("message", { data: JSON.stringify(message) });
  }

  #later(callback: () => void): void {
    setTimeout(callback, 0);
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? [])
      (listener as (event: unknown) => void)(event);
  }
}
