import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";

export interface Gateway {
  publish: (channel: string, payload: unknown) => void;
  onClient: (handler: (socket: Socket) => void) => void;
  close: () => void;
}

export function createGateway(httpServer: HttpServer): Gateway {
  const io = new Server(httpServer, { cors: { origin: "*" } });
  return {
    publish: (channel, payload) => {
      io.emit(channel, payload);
    },
    onClient: (handler) => {
      io.on("connection", handler);
    },
    close: () => {
      io.close();
    },
  };
}
