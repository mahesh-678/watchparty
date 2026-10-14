import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { io, type Socket } from "socket.io-client";
import "./style.css";

/* -------------------------------------------------------
   TYPES
------------------------------------------------------- */

type Person = {
  id: string;
  username: string;
  isHost: boolean;
};

type Msg = {
  id: string;
  username: string;
  text: string;
  timestamp: number;
  system?: boolean;
};

type Playback = {
  url: string;
  kind: "youtube" | "direct";
  currentTime: number;
  isPlaying: boolean;
  updatedAt: number;
};

type Room = {
  id: string;
  hostId: string;
  participants: Person[];
  messages: Msg[];
  playback: Playback | null;
};

type Ack = {
  ok: boolean;
  roomId?: string;
  room?: Room;
  message?: string;
};

type VideoCommand = {
  action: "play" | "pause" | "seek";
  currentTime: number;
  isPlaying?: boolean;
  updatedAt?: number;
  by?: string;
};

/* -------------------------------------------------------
   YOUTUBE PLAYER TYPES
------------------------------------------------------- */

type YouTubePlayerState = {
  PLAYING: number;
  PAUSED: number;
  ENDED: number;
  BUFFERING: number;
  CUED: number;
  UNSTARTED: number;
};

type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  destroy: () => void;
};

type YouTubePlayerEvent = {
  data: number;
  target: YouTubePlayer;
};

type YouTubePlayerOptions = {
  height?: string;
  width?: string;
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: YouTubePlayerEvent) => void;
    onStateChange?: (event: YouTubePlayerEvent) => void;
    onError?: (event: { data: number }) => void;
  };
};

declare global {
  interface Window {
    YT?: {
      Player: new (
        element: HTMLElement,
        options: YouTubePlayerOptions
      ) => YouTubePlayer;

      PlayerState: YouTubePlayerState;
    };

    onYouTubeIframeAPIReady?: () => void;
  }
}

/* -------------------------------------------------------
   CONFIGURATION
------------------------------------------------------- */

const SOCKET_URL =
  import.meta.env.VITE_SERVER_URL || "http://localhost:3001";

const socket: Socket = io(SOCKET_URL, {
  autoConnect: true,
});

const emptyPlayerState: YouTubePlayerState = {
  PLAYING: 1,
  PAUSED: 2,
  ENDED: 0,
  BUFFERING: 3,
  CUED: 5,
  UNSTARTED: -1,
};

/* -------------------------------------------------------
   HELPERS
------------------------------------------------------- */

function getYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return parsed.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      if (parsed.pathname === "/watch") {
        return parsed.searchParams.get("v");
      }

      const parts = parsed.pathname.split("/").filter(Boolean);

      if (
        ["embed", "shorts", "live"].includes(parts[0]) &&
        parts[1]
      ) {
        return parts[1];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getVideoKind(url: string): "youtube" | "direct" {
  return getYouTubeId(url) ? "youtube" : "direct";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  const mm = String(minutes).padStart(2, "0");
  const ss = String(remainingSeconds).padStart(2, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function loadYouTubeAPI(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(
      'script[src="https://www.youtube.com/iframe_api"]'
    );

    const previousCallback = window.onYouTubeIframeAPIReady;

    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };

    if (!existingScript) {
      const script = document.createElement("script");

      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;

      script.onerror = () => {
        reject(new Error("Could not load the YouTube Player API."));
      };

      document.head.appendChild(script);
    }

    window.setTimeout(() => {
      if (window.YT?.Player) {
        resolve();
      } else {
        reject(new Error("YouTube Player API took too long to load."));
      }
    }, 15000);
  });
}

/* -------------------------------------------------------
   APP
------------------------------------------------------- */

export default function App() {
  /* General app state */

  const [page, setPage] = useState<"home" | "room">("home");

  const [username, setUsername] = useState(
    () => localStorage.getItem("watchparty-username") || ""
  );

  const [roomInput, setRoomInput] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [chatInput, setChatInput] = useState("");

  const [room, setRoom] = useState<Room | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);

  const [connected, setConnected] = useState(socket.connected);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [joining, setJoining] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);

  /* Player state */

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [playbackEnabled, setPlaybackEnabled] = useState(false);
  const [youtubeError, setYoutubeError] = useState("");

  /* References */

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const youtubeContainerRef = useRef<HTMLDivElement | null>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);

  const roomRef = useRef<Room | null>(null);
  const playbackRef = useRef<Playback | null>(null);

  const remoteAtRef = useRef(0);
  const lastYoutubeTimeRef = useRef(0);
  const lastDirectTimeRef = useRef(0);
  const lastYoutubeStateRef = useRef<number | null>(null);

  const notificationTimerRef = useRef<number | undefined>(undefined);

  const host = Boolean(room && room.hostId === socket.id);

  /* Keep refs synchronized with React state */

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);

  /* Notifications */

  const notify = useCallback((message: string) => {
    setNotice(message);

    if (notificationTimerRef.current) {
      window.clearTimeout(notificationTimerRef.current);
    }

    notificationTimerRef.current = window.setTimeout(() => {
      setNotice("");
    }, 3500);
  }, []);

  /* -------------------------------------------------------
     ROOM AND SOCKET STATE
  ------------------------------------------------------- */

  useEffect(() => {
    const handleConnect = () => {
      setConnected(true);
    };

    const handleDisconnect = () => {
      setConnected(false);
    };

    const handleRoomUpdate = (updatedRoom: Room) => {
      setRoom(updatedRoom);
      roomRef.current = updatedRoom;

      if (updatedRoom.playback) {
        setPlayback(updatedRoom.playback);
        playbackRef.current = updatedRoom.playback;
      }
    };

    const handleChatMessage = (message: Msg) => {
      setRoom((previous) => {
        if (!previous) return previous;

        const alreadyExists = previous.messages.some(
          (existing) => existing.id === message.id
        );

        if (alreadyExists) return previous;

        const updated = {
          ...previous,
          messages: [...previous.messages, message],
        };

        roomRef.current = updated;
        return updated;
      });
    };

    const handleError = (payload: { message?: string } | string) => {
      const message =
        typeof payload === "string"
          ? payload
          : payload?.message || "Something went wrong.";

      setJoining(false);
      notify(message);
    };

    const handleVideoLoad = (newPlayback: Playback) => {
      setPlayback(newPlayback);
      playbackRef.current = newPlayback;

      setVideoInput(newPlayback.url);
      setCurrentTime(0);
      setDuration(0);
      setPlayerReady(false);
      setYoutubeError("");

      remoteAtRef.current = Date.now();

      if (newPlayback.kind === "direct") {
        window.setTimeout(() => {
          const video = videoRef.current;

          if (video) {
            video.src = newPlayback.url;
            video.load();
          }
        }, 100);
      }
    };

    const handleVideoCommand = (command: VideoCommand) => {
      /*
       * The server broadcasts commands to everyone, including the host.
       * Do not reapply a command to the client that sent it.
       */
      if (command.by && command.by === socket.id) {
        return;
      }

      remoteAtRef.current = Date.now();

      applyRemoteCommand(
        command.action,
        command.currentTime,
        Boolean(command.isPlaying)
      );
    };

    const handleSyncState = (state: Playback) => {
      setPlayback(state);
      playbackRef.current = state;

      remoteAtRef.current = Date.now();

      applyRemoteCommand(
        state.isPlaying ? "play" : "pause",
        state.currentTime,
        state.isPlaying
      );
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("room:update", handleRoomUpdate);
    socket.on("chat:message", handleChatMessage);
    socket.on("app:error", handleError);
    socket.on("video:load", handleVideoLoad);
    socket.on("video:command", handleVideoCommand);
    socket.on("video:sync-state", handleSyncState);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("room:update", handleRoomUpdate);
      socket.off("chat:message", handleChatMessage);
      socket.off("app:error", handleError);
      socket.off("video:load", handleVideoLoad);
      socket.off("video:command", handleVideoCommand);
      socket.off("video:sync-state", handleSyncState);

      if (notificationTimerRef.current) {
        window.clearTimeout(notificationTimerRef.current);
      }
    };
  }, [notify]);

  /* -------------------------------------------------------
     APPLY REMOTE PLAYBACK COMMANDS
  ------------------------------------------------------- */

  const applyRemoteCommand = useCallback(
    (action: string, time: number, isPlaying: boolean) => {
      const activePlayback = playbackRef.current;

      if (!activePlayback) return;

      if (activePlayback.kind === "youtube") {
        const player = youtubePlayerRef.current;

        if (!player) return;

        const safeTime = Math.max(0, Number(time) || 0);

        try {
          if (action === "seek") {
            player.seekTo(safeTime, true);
          }

          if (action === "play" || (action !== "seek" && isPlaying)) {
            player.playVideo();
          } else if (
            action === "pause" ||
            (action !== "seek" && !isPlaying)
          ) {
            player.pauseVideo();
          }

          lastYoutubeTimeRef.current = safeTime;
        } catch {
          // The player may still be initializing.
        }

        return;
      }

      const video = videoRef.current;

      if (!video) return;

      const safeTime = Math.max(0, Number(time) || 0);

      if (
        Number.isFinite(safeTime) &&
        Math.abs(video.currentTime - safeTime) > 1.5
      ) {
        try {
          video.currentTime = safeTime;
        } catch {
          // Metadata might not be available yet.
        }
      }

      lastDirectTimeRef.current = safeTime;

      if (action === "play" || (action !== "seek" && isPlaying)) {
        video.play().catch(() => {
          setPlaybackEnabled(false);
          notify(
            "Click Enable Playback once so your browser can allow synchronized video."
          );
        });
      } else if (
        action === "pause" ||
        (action !== "seek" && !isPlaying)
      ) {
        video.pause();
      }
    },
    [notify]
  );

  /* -------------------------------------------------------
     YOUTUBE PLAYER INITIALIZATION
  ------------------------------------------------------- */

  useEffect(() => {
    if (
      page !== "room" ||
      !playback ||
      playback.kind !== "youtube" ||
      !youtubeContainerRef.current
    ) {
      return;
    }

    const videoId = getYouTubeId(playback.url);

    if (!videoId) {
      setYoutubeError("This YouTube URL could not be recognized.");
      return;
    }

    let cancelled = false;
    let pollTimer: number | undefined;

    setPlayerReady(false);
    setYoutubeError("");

    const createPlayer = async () => {
      try {
        await loadYouTubeAPI();

        if (cancelled || !youtubeContainerRef.current || !window.YT) {
          return;
        }

        /*
         * Remove the old player before creating a new one.
         */
        if (youtubePlayerRef.current) {
          try {
            youtubePlayerRef.current.destroy();
          } catch {
            // Ignore cleanup errors.
          }

          youtubePlayerRef.current = null;
        }

        youtubeContainerRef.current.innerHTML = "";

        const player = new window.YT.Player(
          youtubeContainerRef.current,
          {
            width: "100%",
            height: "100%",
            videoId,

            playerVars: {
              autoplay: 0,
              controls: host ? 1 : 0,
              disablekb: host ? 0 : 1,
              enablejsapi: 1,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin,
            },

            events: {
              onReady: (event) => {
                if (cancelled) return;

                youtubePlayerRef.current = event.target;

                setPlayerReady(true);

                const activePlayback = playbackRef.current;

                if (activePlayback) {
                  remoteAtRef.current = Date.now();

                  if (activePlayback.currentTime > 0) {
                    event.target.seekTo(
                      activePlayback.currentTime,
                      true
                    );
                  }

                  if (activePlayback.isPlaying) {
                    event.target.playVideo();
                  } else {
                    event.target.pauseVideo();
                  }
                }
              },

              onStateChange: (event) => {
                if (cancelled) return;

                const state =
                  window.YT?.PlayerState || emptyPlayerState;

                const now = Date.now();

                /*
                 * Keep track of local playback state.
                 * Remote commands are prevented from being rebroadcast.
                 */
                if (
                  now - remoteAtRef.current > 900 &&
                  host
                ) {
                  if (event.data === state.PLAYING) {
                    sendCommand("play", getYouTubeTime(), true);
                  } else if (
                    event.data === state.PAUSED ||
                    event.data === state.ENDED
                  ) {
                    sendCommand("pause", getYouTubeTime(), false);
                  }
                }

                lastYoutubeStateRef.current = event.data;
              },

              onError: () => {
                setYoutubeError(
                  "YouTube could not play this video. It may be private, restricted, or unavailable for embedding."
                );
              },
            },
          }
        );

        youtubePlayerRef.current = player;

        /*
         * Poll the host's player time. If the host seeks using the
         * YouTube controls, broadcast that seek to the room.
         */
        pollTimer = window.setInterval(() => {
          const activePlayer = youtubePlayerRef.current;

          if (!activePlayer) return;

          try {
            const time = activePlayer.getCurrentTime();

            if (!Number.isFinite(time)) return;

            setCurrentTime(time);

            if (!host) return;

            const state =
              window.YT?.PlayerState || emptyPlayerState;

            const playerState = activePlayer.getPlayerState();

            if (playerState === state.PLAYING) {
              if (
                Math.abs(time - lastYoutubeTimeRef.current) > 2 &&
                Date.now() - remoteAtRef.current > 900
              ) {
                sendCommand("seek", time, true);
              }

              lastYoutubeTimeRef.current = time;
            } else if (playerState !== state.BUFFERING) {
              lastYoutubeTimeRef.current = time;
            }
          } catch {
            // The YouTube player may be loading.
          }
        }, 500);
      } catch (error) {
        if (!cancelled) {
          setYoutubeError(
            error instanceof Error
              ? error.message
              : "Unable to initialize YouTube."
          );
        }
      }
    };

    void createPlayer();

    return () => {
      cancelled = true;

      if (pollTimer) {
        window.clearInterval(pollTimer);
      }

      if (youtubePlayerRef.current) {
        try {
          youtubePlayerRef.current.destroy();
        } catch {
          // Ignore cleanup errors.
        }

        youtubePlayerRef.current = null;
      }
    };
  }, [page, playback?.url, playback?.kind, host]);

  /* -------------------------------------------------------
     DIRECT VIDEO TIME TRACKING
  ------------------------------------------------------- */

  useEffect(() => {
    const video = videoRef.current;

    if (!video || playback?.kind !== "direct") return;

    const updateTime = () => {
      setCurrentTime(video.currentTime);

      if (Number.isFinite(video.duration)) {
        setDuration(video.duration);
      }
    };

    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("loadedmetadata", updateTime);
    video.addEventListener("durationchange", updateTime);

    return () => {
      video.removeEventListener("timeupdate", updateTime);
      video.removeEventListener("loadedmetadata", updateTime);
      video.removeEventListener("durationchange", updateTime);
    };
  }, [playback?.url, playback?.kind]);

  /* -------------------------------------------------------
     HOST COMMANDS
  ------------------------------------------------------- */

  const sendCommand = useCallback(
    (
      action: "play" | "pause" | "seek",
      time?: number,
      isPlaying?: boolean
    ) => {
      if (!roomRef.current) return;

      if (roomRef.current.hostId !== socket.id) {
        return;
      }

      const video = videoRef.current;
      const youtubePlayer = youtubePlayerRef.current;

      let actualTime = time;

      if (actualTime === undefined) {
        if (playbackRef.current?.kind === "youtube") {
          try {
            actualTime = youtubePlayer?.getCurrentTime() || 0;
          } catch {
            actualTime = 0;
          }
        } else {
          actualTime = video?.currentTime || 0;
        }
      }

      socket.emit("video:command", {
        action,
        currentTime: Math.max(0, actualTime || 0),
        isPlaying,
      });
    },
    []
  );

  /* -------------------------------------------------------
     USER ACTIONS
  ------------------------------------------------------- */

  function saveName(): string | null {
    const cleanName = username.trim();

    if (!cleanName) {
      notify("Enter your name first.");
      return null;
    }

    localStorage.setItem("watchparty-username", cleanName);

    return cleanName;
  }

  function handleRoomAck(response: Ack) {
    setJoining(false);

    if (!response?.ok || !response.room) {
      notify(response?.message || "Could not enter the room.");
      return;
    }

    setRoom(response.room);
    roomRef.current = response.room;

    setPlayback(response.room.playback || null);
    playbackRef.current = response.room.playback || null;

    setPage("room");

    setChatInput("");
    setYoutubeError("");
    setPlaybackEnabled(false);

    const roomId = response.roomId || response.room.id;

    history.replaceState({}, "", `?room=${roomId}`);

    /*
     * Ask the server for the current playback state after joining.
     */
    socket.emit("video:sync-request", {});

    notify("You joined the room.");
  }

  function createRoom() {
    if (!connected) {
      notify("Connecting to the server. Try again in a moment.");
      return;
    }

    const name = saveName();

    if (!name) return;

    setJoining(true);

    socket.emit(
      "room:create",
      { username: name },
      handleRoomAck
    );
  }

  function joinRoom() {
    if (!connected) {
      notify("Connecting to the server. Try again in a moment.");
      return;
    }

    const name = saveName();

    if (!name) return;

    const id = roomInput.trim().toUpperCase();

    if (!id) {
      notify("Enter a room ID.");
      return;
    }

    setJoining(true);

    socket.emit(
      "room:join",
      {
        username: name,
        roomId: id,
      },
      handleRoomAck
    );
  }

  function leaveRoom() {
    socket.emit("room:leave");

    setRoom(null);
    roomRef.current = null;

    setPlayback(null);
    playbackRef.current = null;

    setPage("home");
    setChatInput("");
    setVideoInput("");
    setPlaybackEnabled(false);

    history.replaceState({}, "", location.pathname);
  }

  async function copyInvite() {
    if (!room) return;

    const inviteUrl = `${location.origin}${location.pathname}?room=${room.id}`;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      notify("Invite link copied.");

      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      window.prompt("Copy this invite link:", inviteUrl);
    }
  }

  function loadVideo(event?: FormEvent) {
    event?.preventDefault();

    if (!host) {
      notify("Only the host can change the video.");
      return;
    }

    const url = videoInput.trim();

    if (!url) {
      notify("Paste a YouTube or direct video URL.");
      return;
    }

    let parsed: URL;

    try {
      parsed = new URL(url);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Invalid protocol");
      }
    } catch {
      notify("Enter a valid video URL.");
      return;
    }

    const kind = getVideoKind(url);

    if (kind === "youtube" && !getYouTubeId(url)) {
      notify("That YouTube URL is not valid.");
      return;
    }

    socket.emit("video:load", { url });
  }

  function sendChat(event: FormEvent) {
    event.preventDefault();

    const text = chatInput.trim();

    if (!text) return;

    socket.emit("chat:send", { text });

    setChatInput("");
  }

  /* -------------------------------------------------------
     DIRECT VIDEO EVENTS
  ------------------------------------------------------- */

  function handleDirectPlay() {
    const video = videoRef.current;

    if (!video) return;

    if (Date.now() - remoteAtRef.current < 900) {
      return;
    }

    if (host) {
      sendCommand("play", video.currentTime, true);
    }
  }

  function handleDirectPause() {
    const video = videoRef.current;

    if (!video) return;

    if (Date.now() - remoteAtRef.current < 900) {
      return;
    }

    if (host && !video.ended) {
      sendCommand("pause", video.currentTime, false);
    }
  }

  function handleDirectSeek() {
    const video = videoRef.current;

    if (!video) return;

    if (Date.now() - remoteAtRef.current < 900) {
      return;
    }

    if (host) {
      sendCommand(
        "seek",
        video.currentTime,
        !video.paused
      );
    }
  }

  /* -------------------------------------------------------
     ENABLE VIEWER PLAYBACK
  ------------------------------------------------------- */

  async function enablePlayback() {
    if (playback?.kind !== "direct") {
      setPlaybackEnabled(true);
      return;
    }

    const video = videoRef.current;

    if (!video) {
      notify("Wait for the video to load first.");
      return;
    }

    try {
      /*
       * A viewer's browser may require a user gesture before allowing
       * video playback initiated by a remote socket event.
       */
      video.muted = true;

      await video.play();

      video.pause();
      video.muted = false;

      setPlaybackEnabled(true);

      notify("Playback enabled. Waiting for the host.");
    } catch {
      video.muted = false;

      notify(
        "Your browser blocked playback. Try clicking the video play button if available, or check browser autoplay settings."
      );
    }
  }

  /* -------------------------------------------------------
     PLAYER CONTROLS
  ------------------------------------------------------- */

  function hostPlay() {
    if (!host) return;

    if (playback?.kind === "youtube") {
      youtubePlayerRef.current?.playVideo();
      sendCommand("play", currentTime, true);
    } else {
      const video = videoRef.current;

      if (!video) return;

      video.play().catch(() => {
        notify("Allow playback in your browser and try again.");
      });
    }
  }

  function hostPause() {
    if (!host) return;

    if (playback?.kind === "youtube") {
      youtubePlayerRef.current?.pauseVideo();
      sendCommand("pause", currentTime, false);
    } else {
      videoRef.current?.pause();
    }
  }

  function hostSeek(value: number) {
    if (!host) return;

    if (playback?.kind === "youtube") {
      youtubePlayerRef.current?.seekTo(value, true);
      sendCommand("seek", value, true);
    } else {
      const video = videoRef.current;

      if (!video) return;

      video.currentTime = value;

      sendCommand(
        "seek",
        value,
        !video.paused
      );
    }

    setCurrentTime(value);
  }

  /* -------------------------------------------------------
     HOME PAGE — markup matched to the supplied red stylesheet
  ------------------------------------------------------- */

  if (page === "home" || !room) {
    return (
      <div className="app">
        <header className="site-header">
          <div className="header-inner">
            <a
              href="/"
              className="wordmark"
              onClick={(event) => {
                event.preventDefault();
                setPage("home");
              }}
            >
              Watch<span>Party</span>
            </a>

            <nav className="desktop-nav">
              <a href="#features">Features</a>
              <a href="#how-it-works">How it works</a>
              <button
                className="nav-join"
                type="button"
                onClick={() =>
                  document.getElementById("join-room")?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  })
                }
              >
                Join a room
              </button>
              <button
                className="button-red nav-create"
                type="button"
                onClick={() =>
                  document.getElementById("username")?.focus()
                }
              >
                Create room <span aria-hidden="true">↗</span>
              </button>
            </nav>
          </div>
        </header>

        <main className="landing-main">
          <section className="hero-section">
            <div className="poster-field" aria-hidden="true">
              {Array.from({ length: 12 }, (_, index) => (
                <div
                  className={`poster-tile poster-tile-${index + 1}`}
                  key={index}
                />
              ))}
            </div>
            <div className="hero-vignette" aria-hidden="true" />

            <div className="hero-content">
              <div className="live-label">
                <span className="live-dot" />
                YOUR PEOPLE. YOUR MOVIES. YOUR MOMENT.
              </div>

              <h1>
                Watch together.
                <br />
                <span>Even miles apart.</span>
              </h1>

              <p className="hero-description">
                Create a room, invite your friends, and enjoy videos
                together in sync. No more counting down or asking
                everyone to press play.
              </p>

              <div className="hero-actions">
                <button
                  className="button-red hero-primary"
                  type="button"
                  onClick={() =>
                    document.getElementById("username")?.focus()
                  }
                >
                  Start a watch party <span aria-hidden="true">↗</span>
                </button>
                <a className="button-outline hero-secondary" href="#how-it-works">
                  How it works <span aria-hidden="true">↓</span>
                </a>
              </div>

              <div className="trust-line">
                <span>✓ Free to use</span>
                <span className="trust-separator">•</span>
                <span>✓ No account needed</span>
                <span className="trust-separator">•</span>
                <span>✓ Synchronized playback</span>
              </div>
            </div>

            <a className="discover-link" href="#features">
              <span aria-hidden="true">↓</span> DISCOVER WATCHPARTY
            </a>
            <span className="hero-index">01 / WATCH TOGETHER</span>
          </section>

          <section className="features-section section-shell" id="features">
            <div className="section-heading">
              <div>
                <div className="eyebrow"><span /> MADE FOR SHARED MOMENTS</div>
                <h2>Movie night, <br />without the distance.</h2>
              </div>
              <p className="section-aside">
                Everything you need to turn a regular watch into a shared
                experience with your people.
              </p>
            </div>

            <div className="feature-grid">
              <article className="feature-item">
                <div className="feature-icon">▶</div>
                <div className="feature-index">FEATURE / 01</div>
                <h3>Synchronized playback</h3>
                <p>Host controls keep everyone watching the same moment.</p>
              </article>
              <article className="feature-item">
                <div className="feature-icon">✉</div>
                <div className="feature-index">FEATURE / 02</div>
                <h3>Live group chat</h3>
                <p>React, laugh, and talk while the video plays.</p>
              </article>
              <article className="feature-item">
                <div className="feature-icon">↗</div>
                <div className="feature-index">FEATURE / 03</div>
                <h3>Easy invitations</h3>
                <p>Share a room code or invite link to bring friends in.</p>
              </article>
              <article className="feature-item">
                <div className="feature-icon">◉</div>
                <div className="feature-index">FEATURE / 04</div>
                <h3>Private rooms</h3>
                <p>Make a room for your group without creating an account.</p>
              </article>
            </div>
          </section>

          <section className="steps-section section-shell" id="how-it-works">
            <div className="steps-intro">
              <div className="eyebrow"><span /> SIMPLE BY DESIGN</div>
              <h2>Three steps.<br />One shared screen.</h2>
              <p>
                Set up your room in seconds and let WatchParty keep the
                experience together while you enjoy the show.
              </p>
            </div>
            <div className="steps-list">
              <article className="step-item">
                <div className="step-marker">01<i /></div>
                <div className="step-copy">
                  <h3>Create a room</h3>
                  <p>Choose a name and start your private watch party.</p>
                </div>
                <span className="step-watermark">↗</span>
              </article>
              <article className="step-item">
                <div className="step-marker">02<i /></div>
                <div className="step-copy">
                  <h3>Invite your friends</h3>
                  <p>Share the room ID or copy the invite link.</p>
                </div>
                <span className="step-watermark">↗</span>
              </article>
              <article className="step-item">
                <div className="step-marker">03<i /></div>
                <div className="step-copy">
                  <h3>Press play together</h3>
                  <p>The host controls playback while everyone watches in sync.</p>
                </div>
                <span className="step-watermark">▶</span>
              </article>
            </div>
          </section>

          <section className="closing-section">
            <div className="closing-glow" aria-hidden="true" />
            <div className="closing-content">
              <div className="eyebrow"><span /> YOUR NEXT MOVIE NIGHT STARTS HERE</div>
              <h2>Good stories.<br />Better together.</h2>
              <button
                className="button-red closing-button"
                type="button"
                onClick={() =>
                  document.getElementById("username")?.focus()
                }
              >
                Start watching <span aria-hidden="true">↗</span>
              </button>
            </div>
            <div className="closing-mark" aria-hidden="true">W</div>
          </section>

          <section className="section-shell" id="start-room" style={{ paddingTop: 70, paddingBottom: 80 }}>
            <div className="section-heading">
              <div>
                <div className="eyebrow"><span /> GET EVERYONE IN</div>
                <h2>Start your watch party.</h2>
              </div>
              <p className="section-aside">No account needed. Just you and your friends.</p>
            </div>

            <div className="room-dialog" style={{ margin: "0 auto", position: "relative" }}>
              <div className="dialog-mark">▶</div>
              <div className="eyebrow">YOUR WATCH PARTY</div>
              <h2>Bring your friends together.</h2>
              <p className="dialog-description">
                Enter your name to create a room, or join a friend with their room code.
              </p>

              <form
                className="room-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  createRoom();
                }}
              >
                <label htmlFor="username">Your name</label>
                <input
                  id="username"
                  type="text"
                  placeholder="Enter your name"
                  value={username}
                  maxLength={24}
                  onChange={(event) => setUsername(event.target.value)}
                />
                <button
                  className="button-red room-submit"
                  type="submit"
                  disabled={!connected || joining}
                >
                  {joining ? "Please wait..." : "Create a room"}
                  <span aria-hidden="true">↗</span>
                </button>
              </form>

              <form
                className="room-form"
                id="join-room"
                onSubmit={(event) => {
                  event.preventDefault();
                  joinRoom();
                }}
              >
                <label htmlFor="room-id">Join an existing room</label>
                <input
                  id="room-id"
                  type="text"
                  placeholder="Enter room ID"
                  value={roomInput}
                  maxLength={12}
                  onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
                />
                <button
                  className="button-outline room-submit"
                  type="submit"
                  disabled={!connected || joining}
                >
                  Join room <span aria-hidden="true">↗</span>
                </button>
              </form>
            </div>
          </section>
        </main>

        <footer className="site-footer">
          <div className="footer-main">
            <a href="/" className="wordmark footer-wordmark" onClick={(event) => event.preventDefault()}>
              Watch<span>Party</span>
            </a>
            <p className="footer-love">Made for movie nights, wherever you are.</p>
            <div className="footer-links">
              <a href="#features">Features</a>
              <a href="#how-it-works">How it works</a>
              <a href="#start-room">Start a room</a>
            </div>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} WatchParty</span>
            <span>Good movies are better together.</span>
          </div>
        </footer>

        {notice && <div className="toast" role="status">{notice}</div>}
      </div>
    );
  }

  /* -------------------------------------------------------
     ROOM PAGE — markup matched to the supplied red stylesheet
  ------------------------------------------------------- */

  const isYoutube = playback?.kind === "youtube";
  const isDirect = playback?.kind === "direct";

  return (
    <div className="app room-app">
      <header className="room-topbar">
        <a
          href="/"
          className="wordmark"
          onClick={(event) => {
            event.preventDefault();
            leaveRoom();
          }}
        >
          Watch<span>Party</span>
        </a>

        <div className="status">
          <i className={connected ? "online" : ""} />
          {connected ? "Connected" : "Reconnecting"}
          <b>{room.participants.length} watching</b>
        </div>

        <div className="room-actions">
          <span className="live">● LIVE ROOM</span>
          <button className="secondary" type="button" onClick={copyInvite}>
            {copied ? "Copied!" : "Invite ↗"}
          </button>
          <button className="secondary" type="button" onClick={leaveRoom}>
            Leave room
          </button>
        </div>
      </header>

      <main className="room-page">
        <div className="room-heading">
          <div>
            <small>YOUR WATCH PARTY</small>
            <h1>Watching together <code>{room.id}</code></h1>
          </div>
          <div className="room-actions">
            <span className="live">● {connected ? "ROOM CONNECTED" : "RECONNECTING"}</span>
            <button className="primary" type="button" onClick={copyInvite}>
              {copied ? "Invite copied" : "Copy invite link"} ↗
            </button>
          </div>
        </div>

        <div className="layout">
          <section className="watch">
            <div className="video-box">
              {!playback && (
                <div className="empty">
                  <div className="big-play">▶</div>
                  <h2>Your shared screen is ready.</h2>
                  <p>{host ? "Paste a video URL below to get started." : "The host will choose a video soon."}</p>
                </div>
              )}

              {isDirect && playback && (
                <video
                  ref={videoRef}
                  src={playback.url}
                  className="direct-video"
                  controls={host}
                  playsInline
                  preload="metadata"
                  onPlay={handleDirectPlay}
                  onPause={handleDirectPause}
                  onSeeked={handleDirectSeek}
                />
              )}

              {isYoutube && (
                <div
                  className="youtube-player-container"
                  ref={youtubeContainerRef}
                  style={{ width: "100%", height: "100%" }}
                />
              )}

              {isYoutube && !playerReady && (
                <div className="empty" style={{ position: "absolute", inset: 0, background: "#050505" }}>
                  <div className="big-play">▶</div>
                  <h2>Loading YouTube video...</h2>
                  <p>Please wait a moment.</p>
                </div>
              )}

              {youtubeError && (
                <div className="empty" style={{ position: "absolute", inset: 0, background: "#050505" }}>
                  <h2>Video unavailable</h2>
                  <p>{youtubeError}</p>
                </div>
              )}
            </div>

            {isDirect && !host && playback && !playbackEnabled && (
              <div className="tip">
                <span>ⓘ</span>
                <p>Some browsers require a one-time action before synchronized playback can begin.</p>
                <button className="primary" type="button" onClick={enablePlayback}>
                  Enable playback
                </button>
              </div>
            )}

            {host && (
              <div className="source">
                <div className="source-head">
                  <div>
                    <small>VIDEO SOURCE</small>
                    <h3>Choose what everyone watches</h3>
                  </div>
                  <span className="host-tag">HOST CONTROLS</span>
                </div>

                <form
                  onSubmit={loadVideo}
                  className="source-row"
                >
                  <input
                    type="url"
                    placeholder="Paste a YouTube or direct video URL"
                    value={videoInput}
                    onChange={(event) => setVideoInput(event.target.value)}
                  />
                  <button className="primary" type="submit">Load video ↗</button>
                </form>
                <p className="hint">Only the host can change the video and control playback.</p>
              </div>
            )}

            {host && playback && (
              <div className="source">
                <div className="source-head">
                  <div>
                    <small>PLAYBACK</small>
                    <h3>Host controls</h3>
                  </div>
                  <span className="badge">{playback.isPlaying ? "PLAYING" : "PAUSED"}</span>
                </div>
                <div className="source-row">
                  <button className="primary" type="button" onClick={hostPlay}>▶ Play</button>
                  <button className="secondary" type="button" onClick={hostPause}>Ⅱ Pause</button>
                  <span className="hint">{formatTime(currentTime)} / {formatTime(duration || currentTime)}</span>
                </div>
                <input
                  aria-label="Seek video"
                  type="range"
                  min={0}
                  max={Math.max(duration, 1)}
                  step={0.25}
                  value={Math.min(currentTime, duration || currentTime)}
                  onChange={(event) => hostSeek(Number(event.target.value))}
                  style={{ width: "100%", marginTop: 14, accentColor: "#ed3039" }}
                />
              </div>
            )}

            <div className="source">
              <div className="source-head">
                <div>
                  <small>ROOM INVITE</small>
                  <h3>Make it a group thing.</h3>
                </div>
                <span className="badge">{room.participants.length} watching</span>
              </div>
              <div className="source-row">
                <input readOnly value={`${location.origin}${location.pathname}?room=${room.id}`} />
                <button className="primary" type="button" onClick={copyInvite}>
                  {copied ? "Copied!" : "Copy invite"}
                </button>
              </div>
            </div>
          </section>

          <aside className="side">
            <section className="panel">
              <div className="panel-head">
                <h3>◉ People watching</h3>
                <b>{room.participants.length}</b>
              </div>

              {room.participants.map((person, index) => (
                <div className="person" key={person.id}>
                  <div className="avatar">{person.username.trim().charAt(0).toUpperCase()}</div>
                  <div className="person-name">
                    <strong>
                      {person.username}{person.id === socket.id ? " (you)" : ""}
                    </strong>
                    <small>{person.isHost ? "Room host" : "Watching"}</small>
                  </div>
                  {person.isHost ? <span className="host-tag">HOST</span> : <span className="status"><i className="online" /></span>}
                </div>
              ))}
            </section>

            <section className="panel chat">
              <div className="panel-head">
                <h3>✉ Live room chat</h3>
                <small>{room.messages.length} messages</small>
              </div>

              <div className="messages">
                {room.messages.length === 0 && (
                  <div className="quiet">No messages yet.<br />Start the conversation!</div>
                )}

                {room.messages.map((message) => (
                  <div
                    className={`message ${message.username === username ? "mine" : ""} ${message.system ? "system" : ""}`}
                    key={message.id}
                  >
                    <div>
                      <b>{message.system ? "WatchParty" : message.username}</b>
                      <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    </div>
                    <p>{message.text}</p>
                  </div>
                ))}
              </div>

              <form className="chat-form" onSubmit={sendChat}>
                <input
                  type="text"
                  placeholder="Say something..."
                  value={chatInput}
                  maxLength={500}
                  onChange={(event) => setChatInput(event.target.value)}
                />
                <button type="submit" disabled={!chatInput.trim()} aria-label="Send message">↗</button>
              </form>
            </section>
          </aside>
        </div>
      </main>

      <footer>
        <span>WatchParty · Good movies are better together.</span>
      </footer>

      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}
