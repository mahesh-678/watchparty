import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs';

// ======================================================
// TYPES
// ======================================================

type Person = {
  id: string;
  username: string;
  isHost: boolean;
};

type Message = {
  id: string;
  username: string;
  text: string;
  timestamp: number;
  system?: boolean;
};

type Playback = {
  url: string;
  kind: 'youtube' | 'direct';
  currentTime: number;
  isPlaying: boolean;
  updatedAt: number;
};

type Room = {
  id: string;
  hostId: string;
  participants: Map<string, Person>;
  messages: Message[];
  playback: Playback | null;
};

// ======================================================
// EXPRESS + SOCKET.IO SETUP
// ======================================================

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

const server = createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
});

// ======================================================
// IN-MEMORY ROOM STORAGE
// ======================================================

const rooms = new Map<string, Room>();
const socketRooms = new Map<string, string>();

// ======================================================
// HELPER FUNCTIONS
// ======================================================

function snapshot(room: Room) {
  return {
    id: room.id,
    hostId: room.hostId,
    participants: [...room.participants.values()],
    messages: room.messages.slice(-60),
    playback: room.playback,
  };
}

function cleanName(value: unknown): string {
  return (
    String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 24) || 'Guest'
  );
}

function createId(): string {
  return randomBytes(8).toString('hex');
}

function addSystemMessage(room: Room, text: string) {
  room.messages.push({
    id: createId(),
    username: 'WatchParty',
    text,
    timestamp: Date.now(),
    system: true,
  });

  room.messages = room.messages.slice(-100);
}

function emitRoom(room: Room) {
  io.to(room.id).emit('room:update', snapshot(room));
}

function getMemberRoom(socket: Socket): Room | null {
  const roomId = socketRooms.get(socket.id);

  if (!roomId) {
    return null;
  }

  const room = rooms.get(roomId);

  if (!room || !room.participants.has(socket.id)) {
    return null;
  }

  return room;
}

function sendError(socket: Socket, message: string) {
  socket.emit('app:error', message);
}

// ======================================================
// LEAVE ROOM
// ======================================================

function leaveRoom(socket: Socket) {
  const roomId = socketRooms.get(socket.id);

  if (!roomId) {
    return;
  }

  const room = rooms.get(roomId);

  socket.leave(roomId);
  socketRooms.delete(socket.id);

  if (!room) {
    return;
  }

  const person = room.participants.get(socket.id);

  if (person) {
    room.participants.delete(socket.id);

    addSystemMessage(
      room,
      `${person.username} left the room`
    );
  }

  // Delete empty rooms.
  if (room.participants.size === 0) {
    rooms.delete(roomId);
    return;
  }

  // Transfer host privileges if the host leaves.
  if (room.hostId === socket.id) {
    const nextHost = room.participants.values().next()
      .value as Person | undefined;

    if (nextHost) {
      room.hostId = nextHost.id;
      nextHost.isHost = true;

      addSystemMessage(
        room,
        `${nextHost.username} is now the host`
      );
    }
  }

  emitRoom(room);
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'watchparty',
  });
});

// ======================================================
// SOCKET.IO EVENTS
// ======================================================

io.on('connection', (socket: Socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.emit('server:ready', {
    ok: true,
  });

  // ----------------------------------------------------
  // CREATE ROOM
  // ----------------------------------------------------

  socket.on(
    'room:create',
    (
      payload: { username?: string },
      ack?: (response: unknown) => void
    ) => {
      leaveRoom(socket);

      let roomId = '';

      do {
        roomId = randomBytes(4)
          .toString('hex')
          .slice(0, 6)
          .toUpperCase();
      } while (rooms.has(roomId));

      const username = cleanName(payload?.username);

      const person: Person = {
        id: socket.id,
        username,
        isHost: true,
      };

      const room: Room = {
        id: roomId,
        hostId: socket.id,
        participants: new Map([
          [socket.id, person],
        ]),
        messages: [],
        playback: null,
      };

      addSystemMessage(
        room,
        `${username} created the room`
      );

      rooms.set(roomId, room);

      socket.join(roomId);
      socketRooms.set(socket.id, roomId);

      ack?.({
        ok: true,
        roomId,
        room: snapshot(room),
      });

      emitRoom(room);

      console.log(`Room created: ${roomId}`);
    }
  );

  // ----------------------------------------------------
  // JOIN ROOM
  // ----------------------------------------------------

  socket.on(
    'room:join',
    (
      payload: {
        roomId?: string;
        username?: string;
      },
      ack?: (response: unknown) => void
    ) => {
      leaveRoom(socket);

      const roomId = String(
        payload?.roomId ?? ''
      )
        .trim()
        .toUpperCase();

      const room = rooms.get(roomId);

      if (!/^[A-Z0-9]{6}$/.test(roomId) || !room) {
        ack?.({
          ok: false,
          message:
            'Room not found. Check the room ID and try again.',
        });

        return;
      }

      const username = cleanName(payload?.username);

      const person: Person = {
        id: socket.id,
        username,
        isHost: false,
      };

      room.participants.set(socket.id, person);

      socket.join(roomId);
      socketRooms.set(socket.id, roomId);

      addSystemMessage(
        room,
        `${username} joined the room`
      );

      ack?.({
        ok: true,
        roomId,
        room: snapshot(room),
      });

      emitRoom(room);

      // Send existing playback state to the new participant.
      if (room.playback) {
        const playback = { ...room.playback };

        if (playback.isPlaying) {
          playback.currentTime +=
            (Date.now() - playback.updatedAt) / 1000;
        }

        socket.emit('video:sync-state', playback);
      }

      console.log(
        `${username} joined room ${roomId}`
      );
    }
  );

  // ----------------------------------------------------
  // LEAVE ROOM
  // ----------------------------------------------------

  socket.on('room:leave', () => {
    leaveRoom(socket);
  });

  // ----------------------------------------------------
  // CHAT
  // ----------------------------------------------------

  socket.on(
    'chat:send',
    (payload: { text?: string }) => {
      const room = getMemberRoom(socket);

      if (!room) {
        sendError(
          socket,
          'Join a room before chatting.'
        );

        return;
      }

      const text = String(
        payload?.text ?? ''
      ).trim();

      if (!text) {
        return;
      }

      if (text.length > 500) {
        sendError(
          socket,
          'Messages must be 500 characters or fewer.'
        );

        return;
      }

      const person = room.participants.get(socket.id);

      if (!person) {
        return;
      }

      const message: Message = {
        id: createId(),
        username: person.username,
        text,
        timestamp: Date.now(),
      };

      room.messages.push(message);
      room.messages = room.messages.slice(-100);

      io.to(room.id).emit(
        'chat:message',
        message
      );
    }
  );

  // ----------------------------------------------------
  // LOAD VIDEO
  // ----------------------------------------------------

  socket.on(
    'video:load',
    (payload: { url?: string }) => {
      const room = getMemberRoom(socket);

      if (!room) {
        sendError(socket, 'Join a room first.');
        return;
      }

      if (room.hostId !== socket.id) {
        sendError(
          socket,
          'Only the host can load a video.'
        );

        return;
      }

      const url = String(
        payload?.url ?? ''
      ).trim();

      if (
        url.length > 2000 ||
        !/^https?:\/\//i.test(url)
      ) {
        sendError(
          socket,
          'Enter a valid http or https video URL.'
        );

        return;
      }

      let parsedUrl: URL;

      try {
        parsedUrl = new URL(url);
      } catch {
        sendError(socket, 'Invalid video URL.');
        return;
      }

      const hostname = parsedUrl.hostname.toLowerCase();

      const isYouTube =
        hostname === 'youtube.com' ||
        hostname.endsWith('.youtube.com') ||
        hostname === 'youtu.be' ||
        hostname.endsWith('.youtu.be');

      const kind: Playback['kind'] = isYouTube
        ? 'youtube'
        : 'direct';

      room.playback = {
        url,
        kind,
        currentTime: 0,
        isPlaying: false,
        updatedAt: Date.now(),
      };

      io.to(room.id).emit(
        'video:load',
        room.playback
      );

      emitRoom(room);

      console.log(
        `Video loaded in ${room.id}: ${url}`
      );
    }
  );

  // ----------------------------------------------------
  // PLAY / PAUSE / SEEK
  // ----------------------------------------------------

  socket.on(
    'video:command',
    (payload: {
      action?: string;
      currentTime?: number;
      isPlaying?: boolean;
    }) => {
      const room = getMemberRoom(socket);

      if (!room) {
        sendError(socket, 'Join a room first.');
        return;
      }

      if (room.hostId !== socket.id) {
        sendError(
          socket,
          'Only the host can control playback.'
        );

        return;
      }

      if (!room.playback) {
        sendError(
          socket,
          'Load a video first.'
        );

        return;
      }

      const action = String(payload?.action ?? '');

      if (
        !['play', 'pause', 'seek'].includes(action)
      ) {
        return;
      }

      const requestedTime = Number(
        payload?.currentTime
      );

      const currentTime = Number.isFinite(requestedTime)
        ? Math.max(
            0,
            Math.min(requestedTime, 86400)
          )
        : room.playback.currentTime;

      const isPlaying =
        action === 'play'
          ? true
          : action === 'pause'
            ? false
            : Boolean(
                payload?.isPlaying ??
                  room.playback.isPlaying
              );

      room.playback = {
        ...room.playback,
        currentTime,
        isPlaying,
        updatedAt: Date.now(),
      };

      io.to(room.id).emit(
        'video:command',
        {
          action,
          currentTime,
          isPlaying,
          updatedAt: room.playback.updatedAt,
          by: socket.id,
        }
      );
    }
  );

  // ----------------------------------------------------
  // REQUEST PLAYBACK SYNCHRONIZATION
  // ----------------------------------------------------

  socket.on('video:sync-request', () => {
    const room = getMemberRoom(socket);

    if (!room?.playback) {
      return;
    }

    const playback = { ...room.playback };

    if (playback.isPlaying) {
      playback.currentTime +=
        (Date.now() - playback.updatedAt) / 1000;
    }

    socket.emit(
      'video:sync-state',
      playback
    );
  });

  // ----------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    leaveRoom(socket);
  });
});

// ======================================================
// SERVE THE REACT FRONTEND
// ======================================================

// Render runs this application from the repository root.
// The React build should exist at frontend/dist.

const frontendPath = path.resolve(
  process.cwd(),
  '..',
  'frontend',
  'dist'
);

if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));

  // Return the React application for browser routes.
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/socket.io') ||
      req.path === '/health'
    ) {
      return next();
    }

    res.sendFile(
      path.join(frontendPath, 'index.html')
    );
  });

  console.log(
    `Serving frontend from: ${frontendPath}`
  );
} else {
  console.warn(
    `Frontend build not found at ${frontendPath}. ` +
    'Build frontend before deploying.'
  );
}

// ======================================================
// START SERVER
// ======================================================

const port = Number(process.env.PORT) || 3001;

server.listen(port, '0.0.0.0', () => {
  console.log(
    `WatchParty server listening on port ${port}`
  );
});