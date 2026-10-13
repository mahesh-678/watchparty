# WatchParty
A starter full-stack watch-party app with room creation, Socket.IO chat, participant lists, and host-controlled playback.

## Requirements
Install Node.js 20 LTS or newer from https://nodejs.org/.

## Run on Windows
1. Extract the ZIP.
2. Open the `watchparty` folder in VS Code.
3. Open **Terminal → New Terminal**.
4. Run these commands:

```powershell
npm install
npm run install:all
npm run dev
```

5. Open **http://localhost:5173** in your browser. Keep the terminal running.

## Test with two users
1. Open the app in two browser windows (or normal + incognito).
2. In the first, enter a username and create a room.
3. Copy the room ID or invite link.
4. In the second, enter a different username and join.
5. The host loads a direct MP4/WebM URL or YouTube link. Test chat and participant updates.

## Notes and limitations
- Frontend: React + Vite; backend: Express + Socket.IO.
- Rooms and chat are stored in memory and disappear when the server restarts.
- Direct video URLs must allow browser playback. YouTube embeds are displayed, but playback synchronization for YouTube may be limited by iframe/player behavior; HTML5 direct-video synchronization is the primary implemented path.
- Some browsers block autoplay; a viewer may need to press Play once.
- The server synchronizes playback commands, not the video stream itself.
- This is a demo starter, not production-hardened. Add persistent storage, rate limiting, authentication, and stronger abuse protection before public use.
