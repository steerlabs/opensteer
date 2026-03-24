declare module "ws" {
  export type RawData = string | Buffer | ArrayBuffer | Buffer[];

  export default class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    readonly readyState: number;

    constructor(url: string);

    on(event: "message", listener: (data: RawData) => void): this;
    once(event: "open", listener: () => void): this;
    once(event: "close", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    send(data: string): void;
    close(): void;
  }
}
