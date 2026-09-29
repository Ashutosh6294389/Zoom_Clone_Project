"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";

const ICE_SERVERS = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};

export default function MeetingRoom() {
  const { code } = useParams();
  const router = useRouter();

  // --------------------------------------------------
  // STATE
  // --------------------------------------------------

  const [me, setMe] = useState(null);
  const [meeting, setMeeting] = useState(null);
  const [people, setPeople] = useState([]);

  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);

  const [showPeople, setShowPeople] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mediaReady, setMediaReady] = useState(false);

  // participantId -> MediaStream
  const [remoteStreams, setRemoteStreams] = useState({});

  // --------------------------------------------------
  // REFS
  // --------------------------------------------------

  const stream = useRef(null);
  const videoEl = useRef(null);

  // participantId -> RTCPeerConnection
  const peers = useRef(new Map());

  // participantId -> ICE candidates waiting for remote description
  const pendingCandidates = useRef(new Map());

  const channel = useRef(null);

  const mounted = useRef(true);

  // --------------------------------------------------
  // GET PARTICIPANT FROM SESSION
  // --------------------------------------------------

  useEffect(() => {
    mounted.current = true;

    try {
      const saved = sessionStorage.getItem(`zoom:${code}`);

      if (saved) {
        const participant = JSON.parse(saved);
        setMe(participant);
      }
    } catch (err) {
      console.error("Failed to restore participant:", err);
    }

    return () => {
      mounted.current = false;
    };
  }, [code]);

  // --------------------------------------------------
  // GET MEETING INFORMATION
  // --------------------------------------------------

  useEffect(() => {
    if (!code) return;

    let cancelled = false;

    async function loadMeeting() {
      try {
        const data = await api(`/meetings/${code}`);

        if (!cancelled) {
          setMeeting(data);
        }
      } catch (err) {
        console.error("Failed to load meeting:", err);
      }
    }

    loadMeeting();

    return () => {
      cancelled = true;
    };
  }, [code]);

  // --------------------------------------------------
  // START CAMERA + MICROPHONE
  // --------------------------------------------------

  useEffect(() => {
    if (!me) return;

    let cancelled = false;

    async function startMedia() {
      try {
        const localStream =
          await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });

        if (cancelled) {
          localStream.getTracks().forEach((track) => track.stop());
          return;
        }

        stream.current = localStream;

        if (videoEl.current) {
          videoEl.current.srcObject = localStream;
        }

        setMediaReady(true);
      } catch (err) {
        console.error("Camera/microphone permission error:", err);

        // Allow the meeting to continue without camera.
        try {
          const audioOnly =
            await navigator.mediaDevices.getUserMedia({
              audio: true,
            });

          if (!cancelled) {
            stream.current = audioOnly;

            if (videoEl.current) {
              videoEl.current.srcObject = audioOnly;
            }

            setCamOn(false);
            setMediaReady(true);
          }
        } catch (audioErr) {
          console.error("Microphone permission error:", audioErr);
          setCamOn(false);
          setMicOn(false);
          setMediaReady(true);
        }
      }
    }

    startMedia();

    return () => {
      cancelled = true;

      if (stream.current) {
        stream.current.getTracks().forEach((track) => track.stop());
        stream.current = null;
      }
    };
  }, [me]);

  // --------------------------------------------------
  // CREATE PEER CONNECTION
  // --------------------------------------------------

  const sendSignal = useCallback(async (payload) => {
    if (!channel.current) return;

    try {
      await channel.current.send({
        type: "broadcast",
        event: "signal",
        payload,
      });
    } catch (err) {
      console.error("Failed to send WebRTC signal:", err);
    }
  }, []);

  const createPeer = useCallback(
    async (peerId, shouldOffer = false) => {
      if (!me || !stream.current) {
        return null;
      }

      const numericPeerId = Number(peerId);

      // Don't connect to ourselves.
      if (numericPeerId === Number(me.id)) {
        return null;
      }

      // Already have a connection.
      if (peers.current.has(numericPeerId)) {
        const existing = peers.current.get(numericPeerId);

        if (
          existing &&
          existing.connectionState !== "closed" &&
          existing.connectionState !== "failed"
        ) {
          return existing;
        }
      }

      console.log(
        `Creating peer connection: me=${me.id}, peer=${numericPeerId}, offer=${shouldOffer}`
      );

      const pc = new RTCPeerConnection(ICE_SERVERS);

      peers.current.set(numericPeerId, pc);

      // ----------------------------------------------
      // Add local audio/video tracks
      // ----------------------------------------------

      stream.current.getTracks().forEach((track) => {
        pc.addTrack(track, stream.current);
      });

      // ----------------------------------------------
      // Receive remote audio/video
      // ----------------------------------------------

      pc.ontrack = (event) => {
        console.log("Remote track received from:", numericPeerId);

        const remoteStream =
          event.streams && event.streams[0]
            ? event.streams[0]
            : null;

        if (!remoteStream) return;

        setRemoteStreams((previous) => ({
          ...previous,
          [numericPeerId]: remoteStream,
        }));
      };

      // ----------------------------------------------
      // ICE candidates
      // ----------------------------------------------

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;

        sendSignal({
          type: "ice",
          from: me.id,
          to: numericPeerId,
          candidate: event.candidate,
        });
      };

      // ----------------------------------------------
      // Connection state
      // ----------------------------------------------

      pc.onconnectionstatechange = () => {
        console.log(
          `Peer ${numericPeerId} connection state:`,
          pc.connectionState
        );

        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed" ||
          pc.connectionState === "disconnected"
        ) {
          try {
            pc.close();
          } catch {}

          peers.current.delete(numericPeerId);

          setRemoteStreams((previous) => {
            const next = { ...previous };
            delete next[numericPeerId];
            return next;
          });
        }
      };

      // ----------------------------------------------
      // Signaling state
      // ----------------------------------------------

      pc.onsignalingstatechange = () => {
        console.log(
          `Peer ${numericPeerId} signaling state:`,
          pc.signalingState
        );
      };

      // ----------------------------------------------
      // Create offer
      // ----------------------------------------------

      if (shouldOffer) {
        try {
          const offer = await pc.createOffer();

          await pc.setLocalDescription(offer);

          await sendSignal({
            type: "offer",
            from: me.id,
            to: numericPeerId,
            offer,
          });
        } catch (err) {
          console.error(
            `Failed to create offer for ${numericPeerId}:`,
            err
          );
        }
      }

      return pc;
    },
    [me, sendSignal]
  );

  // --------------------------------------------------
  // ADD PENDING ICE CANDIDATES
  // --------------------------------------------------

  const flushPendingCandidates = useCallback(async (peerId, pc) => {
    const candidates = pendingCandidates.current.get(
      Number(peerId)
    );

    if (!candidates || candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error("Failed to add queued ICE candidate:", err);
      }
    }

    pendingCandidates.current.delete(Number(peerId));
  }, []);

  // --------------------------------------------------
  // HANDLE WEBRTC SIGNAL
  // --------------------------------------------------

  const handleSignal = useCallback(
    async (payload) => {
      if (!me || !payload) return;

      const peerId = Number(payload.from);

      // Ignore our own messages.
      if (peerId === Number(me.id)) {
        return;
      }

      // Ignore messages intended for someone else.
      if (
        payload.to !== null &&
        payload.to !== undefined &&
        Number(payload.to) !== Number(me.id)
      ) {
        return;
      }

      console.log("Received WebRTC signal:", payload.type, {
        from: peerId,
        to: payload.to,
      });

      // ----------------------------------------------
      // READY
      // ----------------------------------------------

      if (payload.type === "ready") {
        /*
         * Deterministic offerer:
         *
         * Lower participant ID creates the offer.
         * Higher participant ID waits for it.
         */

        if (Number(me.id) < peerId) {
          await createPeer(peerId, true);
        }

        return;
      }

      // ----------------------------------------------
      // OFFER
      // ----------------------------------------------

      if (payload.type === "offer") {
        let pc = peers.current.get(peerId);

        if (!pc) {
          pc = await createPeer(peerId, false);
        }

        if (!pc) return;

        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(payload.offer)
          );

          await flushPendingCandidates(peerId, pc);

          const answer = await pc.createAnswer();

          await pc.setLocalDescription(answer);

          await sendSignal({
            type: "answer",
            from: me.id,
            to: peerId,
            answer,
          });
        } catch (err) {
          console.error("Error handling offer:", err);
        }

        return;
      }

      // ----------------------------------------------
      // ANSWER
      // ----------------------------------------------

      if (payload.type === "answer") {
        const pc = peers.current.get(peerId);

        if (!pc) {
          console.warn(
            "Received answer but peer connection does not exist:",
            peerId
          );
          return;
        }

        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(payload.answer)
          );

          await flushPendingCandidates(peerId, pc);
        } catch (err) {
          console.error("Error handling answer:", err);
        }

        return;
      }

      // ----------------------------------------------
      // ICE CANDIDATE
      // ----------------------------------------------

      if (payload.type === "ice") {
        let pc = peers.current.get(peerId);

        if (!pc) {
          pc = await createPeer(peerId, false);
        }

        if (!pc) return;

        const candidate = new RTCIceCandidate(payload.candidate);

        /*
         * ICE candidates can arrive before the offer/answer
         * has been applied. Queue them until then.
         */

        if (!pc.remoteDescription) {
          const existing =
            pendingCandidates.current.get(peerId) || [];

          existing.push(candidate);

          pendingCandidates.current.set(peerId, existing);
        } else {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.error("Failed to add ICE candidate:", err);
          }
        }

        return;
      }

      // ----------------------------------------------
      // LEAVE
      // ----------------------------------------------

      if (payload.type === "leave") {
        const pc = peers.current.get(peerId);

        if (pc) {
          try {
            pc.close();
          } catch {}

          peers.current.delete(peerId);
        }

        pendingCandidates.current.delete(peerId);

        setRemoteStreams((previous) => {
          const next = { ...previous };
          delete next[peerId];
          return next;
        });

        return;
      }
    },
    [
      me,
      createPeer,
      flushPendingCandidates,
      sendSignal,
    ]
  );

  // --------------------------------------------------
  // SUPABASE REALTIME CHANNEL
  // --------------------------------------------------

  useEffect(() => {
    if (!me || !code || !mediaReady) {
      return;
    }

    console.log("Creating Supabase meeting channel:", code);

    const roomChannel = supabase.channel(`meeting:${code}`, {
      config: {
        broadcast: {
          self: false,
        },
      },
    });

    channel.current = roomChannel;

    roomChannel
      .on(
        "broadcast",
        { event: "signal" },
        ({ payload }) => {
          handleSignal(payload);
        }
      )
      .subscribe(async (status) => {
        console.log("Realtime status:", status);

        if (status === "SUBSCRIBED") {
          console.log("Joined signaling channel");

          /*
           * Tell everyone already in the meeting
           * that this participant is ready.
           */

          await roomChannel.send({
            type: "broadcast",
            event: "signal",
            payload: {
              type: "ready",
              from: me.id,
              to: null,
            },
          });
        }
      });

    return () => {
      console.log("Leaving Supabase signaling channel");

      roomChannel.unsubscribe();

      if (channel.current === roomChannel) {
        channel.current = null;
      }
    };
  }, [me, code, mediaReady, handleSignal]);

  // --------------------------------------------------
  // LOAD PARTICIPANTS
  // --------------------------------------------------

  const loadParticipants = useCallback(async () => {
    if (!code) return;

    try {
      const data = await api(
        `/meetings/${code}/participants`
      );

      if (!mounted.current) return;

      const participants = data.participants || [];

      setPeople(participants);

      /*
       * If someone joined while we weren't listening,
       * the roster itself lets us establish the connection.
       */

      if (me && mediaReady) {
        for (const participant of participants) {
          if (Number(participant.id) === Number(me.id)) {
            continue;
          }

          const peerExists = peers.current.has(
            Number(participant.id)
          );

          if (!peerExists) {
            const shouldOffer =
              Number(me.id) < Number(participant.id);

            await createPeer(
              Number(participant.id),
              shouldOffer
            );
          }
        }
      }
    } catch (err) {
      console.error("Failed to load participants:", err);
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, [code, me, mediaReady, createPeer]);

  // --------------------------------------------------
  // POLL PARTICIPANTS
  // --------------------------------------------------

  useEffect(() => {
    if (!code) return;

    loadParticipants();

    const interval = setInterval(() => {
      loadParticipants();
    }, 2500);

    return () => {
      clearInterval(interval);
    };
  }, [code, loadParticipants]);

  // --------------------------------------------------
  // ATTACH LOCAL VIDEO
  // --------------------------------------------------

  useEffect(() => {
    if (!videoEl.current || !stream.current) {
      return;
    }

    videoEl.current.srcObject = stream.current;
  }, [mediaReady]);

  // --------------------------------------------------
  // ATTACH REMOTE VIDEO
  // --------------------------------------------------

  const attachRemoteVideo = useCallback(
    (element, participantId) => {
      if (!element) return;

      const remoteStream =
        remoteStreams[participantId];

      if (
        remoteStream &&
        element.srcObject !== remoteStream
      ) {
        element.srcObject = remoteStream;

        /*
         * Some browsers require an explicit play().
         */
        element.play?.().catch(() => {});
      }
    },
    [remoteStreams]
  );

  // --------------------------------------------------
  // TOGGLE CAMERA
  // --------------------------------------------------

  const toggleCamera = () => {
    const videoTracks =
      stream.current?.getVideoTracks() || [];

    if (videoTracks.length === 0) {
      alert("Camera is not available.");
      return;
    }

    const next = !camOn;

    videoTracks.forEach((track) => {
      track.enabled = next;
    });

    setCamOn(next);
  };

  // --------------------------------------------------
  // TOGGLE MICROPHONE
  // --------------------------------------------------

  const toggleMic = async () => {
    const audioTracks =
      stream.current?.getAudioTracks() || [];

    if (audioTracks.length === 0) {
      alert("Microphone is not available.");
      return;
    }

    const next = !micOn;

    audioTracks.forEach((track) => {
      track.enabled = next;
    });

    setMicOn(next);

    if (me) {
      try {
        await api(`/participants/${me.id}`, {
          method: "PATCH",
          body: {
            is_muted: !next,
          },
        });
      } catch (err) {
        console.error("Failed to update mute state:", err);
      }
    }
  };

  // --------------------------------------------------
  // COPY INVITE LINK
  // --------------------------------------------------

  const copyInvite = async () => {
    const link =
      `${window.location.origin}/meeting/${code}`;

    try {
      await navigator.clipboard.writeText(link);

      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  // --------------------------------------------------
  // LEAVE MEETING
  // --------------------------------------------------

  const leaveMeeting = async () => {
    try {
      if (me) {
        await api(`/participants/${me.id}/leave`, {
          method: "POST",
        });
      }
    } catch (err) {
      console.error("Leave API error:", err);
    }

    // Tell other participants.
    if (channel.current && me) {
      try {
        await sendSignal({
          type: "leave",
          from: me.id,
          to: null,
        });
      } catch {}
    }

    // Close all peer connections.
    peers.current.forEach((pc) => {
      try {
        pc.close();
      } catch {}
    });

    peers.current.clear();

    // Stop camera/mic.
    if (stream.current) {
      stream.current
        .getTracks()
        .forEach((track) => track.stop());

      stream.current = null;
    }

    try {
      sessionStorage.removeItem(`zoom:${code}`);
    } catch {}

    router.push("/");
  };

  // --------------------------------------------------
  // END MEETING
  // --------------------------------------------------

  const endMeeting = async () => {
    if (!confirm("End this meeting for everyone?")) {
      return;
    }

    try {
      await api(`/meetings/${code}/end`, {
        method: "POST",
      });
    } catch (err) {
      console.error("Failed to end meeting:", err);
    }

    // Notify participants.
    if (channel.current && me) {
      try {
        await sendSignal({
          type: "leave",
          from: me.id,
          to: null,
        });
      } catch {}
    }

    peers.current.forEach((pc) => {
      try {
        pc.close();
      } catch {}
    });

    peers.current.clear();

    if (stream.current) {
      stream.current
        .getTracks()
        .forEach((track) => track.stop());

      stream.current = null;
    }

    try {
      sessionStorage.removeItem(`zoom:${code}`);
    } catch {}

    router.push("/");
  };

  // --------------------------------------------------
  // MUTE ALL
  // --------------------------------------------------

  const muteAll = async () => {
    try {
      await api(`/meetings/${code}/mute-all`, {
        method: "POST",
      });

      await loadParticipants();
    } catch (err) {
      console.error("Mute all failed:", err);
    }
  };

  // --------------------------------------------------
  // REMOVE PARTICIPANT
  // --------------------------------------------------

  const removeParticipant = async (participantId) => {
    try {
      await api(`/participants/${participantId}/remove`, {
        method: "POST",
      });

      // Close WebRTC connection too.
      const pc = peers.current.get(
        Number(participantId)
      );

      if (pc) {
        try {
          pc.close();
        } catch {}

        peers.current.delete(Number(participantId));
      }

      setRemoteStreams((previous) => {
        const next = { ...previous };
        delete next[participantId];
        return next;
      });

      await loadParticipants();
    } catch (err) {
      console.error("Remove participant failed:", err);
    }
  };

  // --------------------------------------------------
  // CLEANUP ON PAGE CLOSE
  // --------------------------------------------------

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (me && channel.current) {
        /*
         * fire-and-forget
         */
        channel.current.send({
          type: "broadcast",
          event: "signal",
          payload: {
            type: "leave",
            from: me.id,
            to: null,
          },
        });
      }

      if (stream.current) {
        stream.current
          .getTracks()
          .forEach((track) => track.stop());
      }
    };

    window.addEventListener(
      "beforeunload",
      handleBeforeUnload
    );

    return () => {
      window.removeEventListener(
        "beforeunload",
        handleBeforeUnload
      );
    };
  }, [me]);

  // --------------------------------------------------
  // LOADING
  // --------------------------------------------------

  if (!me) {
    return (
      <div style={styles.loading}>
        <div>
          <h2>Joining meeting...</h2>
          <p>Preparing your camera and microphone.</p>
        </div>
      </div>
    );
  }

  // --------------------------------------------------
  // RENDER
  // --------------------------------------------------

  return (
    <div style={styles.page}>
      {/* -------------------------------------------- */}
      {/* TOP BAR */}
      {/* -------------------------------------------- */}

      <header style={styles.topbar}>
        <div>
          <div style={styles.brand}>
            Zoom Clone
          </div>

          <div style={styles.meetingTitle}>
            {meeting?.title || "Meeting"}
          </div>
        </div>

        <div style={styles.topRight}>
          <span style={styles.meetingCode}>
            {formatMeetingCode(code)}
          </span>

          <button
            style={styles.inviteButton}
            onClick={copyInvite}
          >
            {copied ? "Copied!" : "Invite"}
          </button>

          <button
            style={styles.peopleButton}
            onClick={() => setShowPeople((v) => !v)}
          >
            👥 {people.length}
          </button>
        </div>
      </header>

      {/* -------------------------------------------- */}
      {/* MAIN */}
      {/* -------------------------------------------- */}

      <main style={styles.main}>
        <div
          style={{
            ...styles.videoGrid,
            gridTemplateColumns:
              people.length <= 1
                ? "1fr"
                : people.length === 2
                ? "repeat(2, 1fr)"
                : people.length <= 4
                ? "repeat(2, 1fr)"
                : "repeat(3, 1fr)",
          }}
        >
          {/* ---------------------------------------- */}
          {/* PARTICIPANTS */}
          {/* ---------------------------------------- */}

          {people.map((participant) => {
            const isMe =
              Number(participant.id) === Number(me.id);

            const remoteStream =
              remoteStreams[participant.id];

            const participantCameraOn =
              isMe
                ? camOn
                : Boolean(remoteStream);

            return (
              <div
                key={participant.id}
                style={styles.videoTile}
              >
                {/* ---------------------------------- */}
                {/* MY VIDEO */}
                {/* ---------------------------------- */}

                {isMe ? (
                  camOn ? (
                    <video
                      ref={videoEl}
                      autoPlay
                      muted
                      playsInline
                      style={styles.video}
                    />
                  ) : (
                    <Avatar
                      name={participant.display_name}
                    />
                  )
                ) : remoteStream ? (
                  /* -------------------------------- */
                  /* REMOTE VIDEO */
                  /* -------------------------------- */

                  <video
                    ref={(element) =>
                      attachRemoteVideo(
                        element,
                        participant.id
                      )
                    }
                    autoPlay
                    playsInline
                    style={styles.video}
                  />
                ) : (
                  /* -------------------------------- */
                  /* REMOTE CAMERA NOT CONNECTED YET */
                  /* -------------------------------- */

                  <div style={styles.waiting}>
                    <Avatar
                      name={participant.display_name}
                    />

                    <div style={styles.waitingText}>
                      Connecting camera...
                    </div>
                  </div>
                )}

                {/* ---------------------------------- */}
                {/* NAME */}
                {/* ---------------------------------- */}

                <div style={styles.nameLabel}>
                  {participant.display_name}
                  {isMe ? " (You)" : ""}
                </div>

                {/* ---------------------------------- */}
                {/* MIC STATUS */}
                {/* ---------------------------------- */}

                <div style={styles.micStatus}>
                  {isMe
                    ? micOn
                      ? "🎤"
                      : "🔇"
                    : participant.is_muted
                    ? "🔇"
                    : "🎤"}
                </div>
              </div>
            );
          })}

          {/* If participant list hasn't loaded */}
          {people.length === 0 && (
            <div style={styles.empty}>
              <Avatar name={me.display_name} />

              <p>
                {loading
                  ? "Loading participants..."
                  : "Waiting for participants..."}
              </p>
            </div>
          )}
        </div>

        {/* ------------------------------------------ */}
        {/* PEOPLE PANEL */}
        {/* ------------------------------------------ */}

        {showPeople && (
          <aside style={styles.peoplePanel}>
            <div style={styles.panelHeader}>
              <strong>Participants</strong>

              <button
                style={styles.closeButton}
                onClick={() => setShowPeople(false)}
              >
                ×
              </button>
            </div>

            <div style={styles.peopleList}>
              {people.map((participant) => (
                <div
                  key={participant.id}
                  style={styles.personRow}
                >
                  <Avatar
                    name={participant.display_name}
                    small
                  />

                  <div style={{ flex: 1 }}>
                    <div style={styles.personName}>
                      {participant.display_name}
                      {Number(participant.id) ===
                      Number(me.id)
                        ? " (You)"
                        : ""}
                    </div>

                    {participant.is_host && (
                      <div style={styles.hostText}>
                        Host
                      </div>
                    )}
                  </div>

                  <div>
                    {participant.is_muted
                      ? "🔇"
                      : "🎤"}
                  </div>

                  {/* Host controls */}
                  {me.is_host &&
                    Number(participant.id) !==
                      Number(me.id) && (
                      <button
                        style={styles.removeButton}
                        onClick={() =>
                          removeParticipant(
                            participant.id
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                </div>
              ))}
            </div>

            {me.is_host && (
              <button
                style={styles.muteAllButton}
                onClick={muteAll}
              >
                Mute everyone
              </button>
            )}
          </aside>
        )}
      </main>

      {/* -------------------------------------------- */}
      {/* CONTROLS */}
      {/* -------------------------------------------- */}

      <footer style={styles.controls}>
        <button
          style={{
            ...styles.controlButton,
            background: micOn ? "#333" : "#dc3545",
          }}
          onClick={toggleMic}
        >
          {micOn ? "🎤" : "🔇"}
          <span>{micOn ? "Mute" : "Unmute"}</span>
        </button>

        <button
          style={{
            ...styles.controlButton,
            background: camOn ? "#333" : "#dc3545",
          }}
          onClick={toggleCamera}
        >
          {camOn ? "📹" : "🚫"}
          <span>
            {camOn ? "Stop Video" : "Start Video"}
          </span>
        </button>

        <button
          style={styles.leaveButton}
          onClick={leaveMeeting}
        >
          Leave
        </button>

        {me.is_host && (
          <button
            style={styles.endButton}
            onClick={endMeeting}
          >
            End Meeting
          </button>
        )}
      </footer>
    </div>
  );
}

// ==================================================
// AVATAR
// ==================================================

function Avatar({ name, small = false }) {
  const initial =
    name?.trim()?.charAt(0)?.toUpperCase() || "?";

  return (
    <div
      style={{
        ...styles.avatar,
        width: small ? 40 : 100,
        height: small ? 40 : 100,
        fontSize: small ? 16 : 36,
      }}
    >
      {initial}
    </div>
  );
}

// ==================================================
// FORMAT MEETING CODE
// ==================================================

function formatMeetingCode(code) {
  if (!code) return "";

  const value = String(code);

  if (value.length === 10) {
    return `${value.slice(0, 3)} ${value.slice(
      3,
      7
    )} ${value.slice(7)}`;
  }

  return value;
}

// ==================================================
// STYLES
// ==================================================

const styles = {
  page: {
    minHeight: "100vh",
    background: "#111",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
  },

  loading: {
    minHeight: "100vh",
    background: "#111",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
  },

  topbar: {
    height: 70,
    padding: "0 24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#181818",
    borderBottom: "1px solid #292929",
  },

  brand: {
    fontSize: 20,
    fontWeight: 700,
  },

  meetingTitle: {
    fontSize: 13,
    color: "#aaa",
    marginTop: 3,
  },

  topRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  meetingCode: {
    color: "#bbb",
    fontSize: 14,
  },

  inviteButton: {
    border: 0,
    borderRadius: 8,
    padding: "9px 14px",
    background: "#fff",
    color: "#111",
    cursor: "pointer",
    fontWeight: 600,
  },

  peopleButton: {
    border: 0,
    borderRadius: 8,
    padding: "9px 14px",
    background: "#292929",
    color: "#fff",
    cursor: "pointer",
  },

  main: {
    flex: 1,
    position: "relative",
    padding: 20,
    overflow: "auto",
  },

  videoGrid: {
    display: "grid",
    gap: 12,
    width: "100%",
    height: "100%",
    minHeight: 500,
  },

  videoTile: {
    position: "relative",
    minHeight: 280,
    background: "#202020",
    borderRadius: 12,
    overflow: "hidden",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    background: "#111",
  },

  waiting: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 15,
  },

  waitingText: {
    color: "#aaa",
    fontSize: 13,
  },

  avatar: {
    borderRadius: "50%",
    background: "#3d5afe",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
  },

  nameLabel: {
    position: "absolute",
    bottom: 10,
    left: 10,
    padding: "6px 9px",
    borderRadius: 6,
    background: "rgba(0,0,0,.65)",
    fontSize: 13,
  },

  micStatus: {
    position: "absolute",
    right: 10,
    bottom: 10,
    fontSize: 16,
  },

  empty: {
    minHeight: 500,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#aaa",
  },

  peoplePanel: {
    position: "absolute",
    right: 20,
    top: 20,
    width: 330,
    maxHeight: "calc(100% - 40px)",
    background: "#202020",
    borderRadius: 12,
    border: "1px solid #333",
    overflow: "auto",
    zIndex: 20,
    boxShadow: "0 10px 40px rgba(0,0,0,.5)",
  },

  panelHeader: {
    padding: 16,
    borderBottom: "1px solid #333",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },

  closeButton: {
    border: 0,
    background: "transparent",
    color: "#aaa",
    fontSize: 24,
    cursor: "pointer",
  },

  peopleList: {
    padding: 10,
  },

  personRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 6px",
    borderBottom: "1px solid #2d2d2d",
  },

  personName: {
    fontSize: 14,
  },

  hostText: {
    fontSize: 11,
    color: "#aaa",
    marginTop: 2,
  },

  removeButton: {
    border: 0,
    borderRadius: 5,
    padding: "5px 8px",
    background: "#dc3545",
    color: "#fff",
    cursor: "pointer",
    fontSize: 11,
  },

  muteAllButton: {
    margin: 12,
    width: "calc(100% - 24px)",
    padding: 10,
    border: 0,
    borderRadius: 7,
    background: "#333",
    color: "#fff",
    cursor: "pointer",
  },

  controls: {
    minHeight: 85,
    padding: "12px 20px",
    background: "#181818",
    borderTop: "1px solid #292929",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    flexWrap: "wrap",
  },

  controlButton: {
    border: 0,
    borderRadius: 8,
    padding: "11px 15px",
    color: "#fff",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 7,
  },

  leaveButton: {
    border: 0,
    borderRadius: 8,
    padding: "11px 18px",
    background: "#dc3545",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  },

  endButton: {
    border: 0,
    borderRadius: 8,
    padding: "11px 18px",
    background: "#8b0000",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 600,
  },
};