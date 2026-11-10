import { LatestFrameStream as PortableLatestFrameStream } from "@opensteer/browser-core/latest-frame-stream";
import type { BrowserFrame } from "./frame.js";
export interface BrowserFrameSink {
  sendFrame(frame: BrowserFrame): Promise<void>;
}
export class LatestFrameStream extends PortableLatestFrameStream<BrowserFrame> {}
