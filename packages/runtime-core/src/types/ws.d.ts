declare module "ws" {
  class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readonly readyState: number;

    constructor(url: string | URL);

    on(
      event: "open" | "close",
      listener: () => void,
    ): this;
    on(
      event: "message",
      listener: (data: WebSocket.RawData, isBinary: boolean) => void,
    ): this;
    on(event: "error", listener: (error: Error) => void): this;

    once(
      event: "open" | "close",
      listener: () => void,
    ): this;
    once(event: "error", listener: (error: Error) => void): this;

    send(data: string): void;
    close(): void;
  }

  namespace WebSocket {
    type RawData = string | Buffer | ArrayBuffer | Uint8Array | Buffer[];
  }

  export type RawData = WebSocket.RawData;
  export default WebSocket;
}
