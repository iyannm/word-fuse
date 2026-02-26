import { io } from "socket.io-client";

const serverUrl = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";

export const socket = io(serverUrl, {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 2500,
  timeout: 10_000,
});