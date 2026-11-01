import type { DisplayFrame } from "@opensteer/client/integrations";
import { PhoneDisplayDecoder } from "./phone-display-media.js";

export interface BenchmarkDisplayPacket {
  readonly id: number;
  readonly header: DisplayFrame["header"];
  readonly connection: number;
  readonly replayed: boolean;
  readonly data: string;
}

/** Browser bridge; credit belongs to the production decoder, never RPC submission. */
export function benchmarkPhoneDecoder(sink: {
  readonly painted: (sequence: number) => void;
  readonly dequeued: (id: number) => void;
  readonly failed: (message: string) => void;
}) {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const context = canvas.getContext("2d")!;
  const decoder = new PhoneDisplayDecoder({
    acceleration: "prefer-software",
    onPicture: (picture, frame) => {
      if (!frame.replayed) {
        if (canvas.width !== frame.header.width) canvas.width = frame.header.width;
        if (canvas.height !== frame.header.height) canvas.height = frame.header.height;
        context.drawImage(picture, 0, 0, canvas.width, canvas.height);
        sink.painted(frame.header.sequence);
      }
      picture.close();
    },
    onLost: () => sink.failed("Production display decoder lost its stream"),
  });
  return {
    accept: (packet: BenchmarkDisplayPacket) =>
      decoder.push({
        header: packet.header,
        connection: packet.connection,
        replayed: packet.replayed,
        payload: Uint8Array.from(atob(packet.data), (byte) => byte.charCodeAt(0)),
        done: () => sink.dequeued(packet.id),
      }),
    close: () => decoder.close(),
  };
}
