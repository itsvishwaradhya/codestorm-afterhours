import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";

export interface Gateway {
  publish: (channel: string, payload: unknown) => void;
  close: () => void;
}

export function createGateway(httpServer: HttpServer): Gateway {
  const io = new Server(httpServer, { cors: { origin: "*" } });
  return {
    publish: (channel, payload) => {
      io.emit(channel, payload);
    },
    close: () => {
      io.close();
    },
  };
}
