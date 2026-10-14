# 🎬 WatchParty

### Watch Together. Anywhere. Anytime.

WatchParty is a real-time web application that allows friends to watch
videos together in synchronized playback sessions, communicate through
live chat, and interact in shared virtual rooms.

The application synchronizes video playback between participants and
provides room creation, room joining, participant tracking, and
host-controlled playback.

## 🌐 Live Demo

**Try WatchParty:** https://watchparty-e3jf.onrender.com/

Open the website, enter your name, create a room, and share the room ID
with your friends.

> Note: The application uses Render's free hosting plan. The server may
> take some time to respond after a period of inactivity.

---

## ✨ Features

### 🏠 Room Management
- Create a room with a unique room ID.
- Join an existing room using its room ID.
- Track participants currently in a room.
- Automatically transfer host privileges when the host leaves.

### 🎥 Synchronized Video Playback
- Load supported YouTube videos and direct video URLs.
- Synchronize playback between room participants.
- Support play, pause, and seeking operations.
- Restrict video loading and playback controls to the room host.

### 💬 Real-Time Chat
- Exchange messages with other participants.
- Receive messages instantly using Socket.IO.
- Display system messages when participants join or leave.
- Maintain recent messages during an active room session.

### 👥 Participant Management
- Display room participants.
- Identify the current host.
- Update participant information when users join or disconnect.

### 🌐 Web-Based Application
- Access the application through a browser.
- No separate desktop application is required.
- Publicly accessible deployment for remote collaboration.

---

## 🛠️ Technologies Used

### Frontend
- React
- TypeScript
- Vite
- Tailwind CSS
- Socket.IO Client
- Lucide React

### Backend
- Node.js
- Express.js
- TypeScript
- Socket.IO
- HTTP Server

### Video Integration
- YouTube embedded player
- HTML5 video playback

### Deployment and Version Control
- Git
- GitHub
- Render

---

## 🏗️ Architecture

WatchParty uses a client-server architecture.

1. The React frontend provides the user interface.
2. The Express backend serves the frontend and handles application
   requests.
3. Socket.IO maintains real-time communication between connected users.
4. Room information tracks participants, messages, host privileges,
   and playback state.
5. Playback events are broadcast to participants in the same room.

The frontend and backend are deployed together as a single web service.

```text
                  WATCHPARTY
                       |
          +------------+------------+
          |                         |
     React Frontend            Express Server
     TypeScript                Node.js
          |                         |
          |                    Socket.IO
          |                         |
          +----------+--------------+
                     |
              Shared Watch Room
                     |
       +-------------+-------------+
       |             |             |
    Host/User      User 2        User 3
       |             |             |
    Playback       Playback       Playback
    Controls       Sync           Sync
       |
    Real-Time Chat and Participants