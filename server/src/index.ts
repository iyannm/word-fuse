import http from "node:http";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { Server } from "socket.io";
import { createDictionary } from "./dictionary";
import { GameService } from "./gameService";
import {
  AckResponse,
  CreateRoomPayload,
  JoinRoomPayload,
  PlayerActionPayload,
  ReconnectPayload,
  SubmitWordPayload,
  UpdateSettingsPayload,
} from "./types";

dotenv.config();

const PORT = Number(process.env.PORT ?? 3001);
const configuredClientOrigins = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const clientOrigins = configuredClientOrigins
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const dictionary = createDictionary(process.env.DICTIONARY_ENABLED);

const app = express();
app.use(cors({ origin: clientOrigins }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    dictionaryEnabled: dictionary.enabled,
    dictionarySize: dictionary.size,
  });
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: clientOrigins,
    methods: ["GET", "POST"],
  },
});

const gameService = new GameService(io, dictionary);

function ackWith(result: AckResponse, ack?: (payload: AckResponse) => void): void {
  if (typeof ack === "function") {
    ack(result);
  }
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload: CreateRoomPayload, ack?: (payload: AckResponse) => void) => {
    const result = gameService.createRoom(socket.id, payload?.name ?? "");
    ackWith(gameService.toAck(result), ack);
  });

  socket.on("room:join", (payload: JoinRoomPayload, ack?: (payload: AckResponse) => void) => {
    const result = gameService.joinRoom(socket.id, payload?.roomCode ?? "", payload?.name ?? "");
    ackWith(gameService.toAck(result), ack);
  });

  socket.on(
    "room:reconnect",
    (payload: ReconnectPayload, ack?: (payload: AckResponse) => void) => {
      const result = gameService.reconnectPlayer(
        socket.id,
        payload?.roomCode ?? "",
        payload?.playerId ?? "",
        payload?.name,
      );
      ackWith(gameService.toAck(result), ack);
    },
  );

  socket.on(
    "room:updateSettings",
    (payload: UpdateSettingsPayload, ack?: (payload: AckResponse) => void) => {
      const result = gameService.updateSettings(socket.id, payload);
      ackWith(gameService.toAck(result), ack);
    },
  );

  socket.on("game:start", (payload: PlayerActionPayload, ack?: (payload: AckResponse) => void) => {
    const result = gameService.startGame(socket.id, payload);
    ackWith(gameService.toAck(result), ack);
  });

  socket.on(
    "turn:submitWord",
    (payload: SubmitWordPayload, ack?: (payload: AckResponse) => void) => {
      const result = gameService.submitWord(socket.id, payload);
      ackWith(gameService.toAck(result), ack);
    },
  );

  socket.on(
    "game:playAgain",
    (payload: PlayerActionPayload, ack?: (payload: AckResponse) => void) => {
      const result = gameService.playAgain(socket.id, payload);
      ackWith(gameService.toAck(result), ack);
    },
  );

  socket.on("disconnect", () => {
    gameService.handleDisconnect(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Word Fuse server listening on http://localhost:${PORT}`);
  console.log(`Allowed client origins: ${clientOrigins.join(", ")}`);
  console.log(
    `Dictionary: ${dictionary.enabled ? `enabled (${dictionary.size} words)` : "disabled"}`,
  );
});
