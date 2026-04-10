import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import * as wsModule from "ws";
import WebSocket from "ws";

export interface LocalViewSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "close", listener: () => void): this;
  off(event: "message", listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  send(
    data: WebSocket.RawData,
    options?: {
      readonly binary?: boolean;
    },
    callback?: (error?: Error) => void,
  ): void;
  close(code?: number, data?: string | Buffer): void;
}

export interface LocalViewSocketServer {
  readonly clients: Set<LocalViewSocket>;
  on(
    event: "connection",
    listener: (socket: LocalViewSocket, request: IncomingMessage) => void,
  ): this;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: LocalViewSocket) => void,
  ): void;
  emit(event: "connection", socket: LocalViewSocket, request: IncomingMessage): boolean;
  close(callback?: () => void): void;
}

interface LocalViewSocketServerConstructor {
  new (options?: { readonly noServer?: boolean }): LocalViewSocketServer;
}

export const LocalViewWebSocketServer = (
  wsModule as unknown as {
    readonly WebSocketServer: LocalViewSocketServerConstructor;
  }
).WebSocketServer;
