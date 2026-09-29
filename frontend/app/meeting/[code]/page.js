"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Users,
  Shield,
  LogOut,
} from "lucide-react";

import { api, fmtCode, inviteLink } from "@/lib/api";
import { supabase } from "@/lib/supabase";

const ICE_SERVERS = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};

export default function Room() {
  const { code } = useParams();
  const router = useRouter();

  const [me, setMe] = useState(null);
  const [people, setPeople] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [camOn, setCamOn] = useState(true);
  const [showPeople, setShowPeople] = useState(true);
  const [copied, setCopied] = useState(false);

  const stream = useRef(null);
  const videoEl = useRef(null);

  // participantId -> RTCPeerConnection
  const peers = useRef(new Map());

  // participantId -> queued ICE candidates
  const pendingCandidates = useRef(new Map());

  const channel = useRef(null);

  const exit = useCallback(
    async (q = "") => {
      stream.current?.getTracks().forEach((t) => t.stop());

      peers.current.forEach((pc) => pc.close());
      peers.current.clear();

      if (channel.current) {
        await supabase.removeChannel(channel.current);
        channel.current = null;
      }

      router.replace("/" + q);
    },
    [router]
  );

  // ------------------------------------------------------------
  // Restore participant
  // ------------------------------------------------------------

  useEffect(() => {
    const saved = sessionStorage.getItem(`zoom:${code}`);

    if (!saved) {
      router.replace(`/join?code=${code}`);
      return;
    }

    setMe(JSON.parse(saved));
  }, [code, router]);

  // ------------------------------------------------------------
  // Camera + microphone
  // ------------------------------------------------------------

  useEffect(() => {
    if (!me) return;

    let cancelled = false;

    navigator.mediaDevices
      ?.getUserMedia({
        video: true,
        audio: true,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }

        stream.current = s;

        if (videoEl.current) {
          videoEl.current.srcObject = s;
        }
      })
      .catch((err) => {
        console.error("getUserMedia failed:", err);
        setCamOn(false);
      });

    return () => {
      cancelled = true;
    };
  }, [me]);

  // ------------------------------------------------------------
  // Create peer connection
  // ------------------------------------------------------------

  const createPeer = useCallback(
    async (peerId, shouldOffer) => {
      if (!me || !stream.current) return null;

      if (peerId === me.id) return null;

      if (peers.current.has(peerId)) {
        return peers.current.get(peerId);
      }

      console.log(
        `Creating peer connection ${me.id} -> ${peerId}`
      );

      const pc = new RTCPeerConnection(ICE_SERVERS);

      peers.current.set(peerId, pc);

      // Send our camera/microphone tracks
      stream.current.getTracks().forEach((track) => {
        pc.addTrack(track, stream.current);
      });

      // --------------------------------------------------------
      // Receive remote camera/microphone
      // --------------------------------------------------------

      pc.ontrack = (event) => {
        console.log("Remote track received from:", peerId);

        const remoteStream = event.streams[0];

        if (!remoteStream) return;

        setRemoteStreams((current) => ({
          ...current,
          [peerId]: remoteStream,
        }));
      };

      // --------------------------------------------------------
      // ICE candidates
      // --------------------------------------------------------

      pc.onicecandidate = async (event) => {
        if (!event.candidate) return;

        await channel.current?.send({
          type: "broadcast",
          event: "signal",
          payload: {
            type: "ice",
            from: me.id,
            to: peerId,
            candidate: event.candidate,
          },
        });
      };

      pc.onconnectionstatechange = () => {
        console.log(
          `Peer ${peerId}:`,
          pc.connectionState
        );

        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed" ||
          pc.connectionState === "disconnected"
        ) {
          pc.close();
          peers.current.delete(peerId);

          setRemoteStreams((current) => {
            const next = { ...current };
            delete next[peerId];
            return next;
          });
        }
      };

      // --------------------------------------------------------
      // Create offer
      // --------------------------------------------------------

      if (shouldOffer) {
        const offer = await pc.createOffer();

        await pc.setLocalDescription(offer);

        await channel.current?.send({
          type: "broadcast",
          event: "signal",
          payload: {
            type: "offer",
            from: me.id,
            to: peerId,
            offer,
          },
        });
      }

      return pc;
    },
    [me]
  );

  // ------------------------------------------------------------
  // Handle WebRTC signaling
  // ------------------------------------------------------------

  const handleSignal = useCallback(
    async (payload) => {
      if (!me) return;

      if (payload.to !== me.id) return;

      const peerId = payload.from;

      // --------------------------------------------------------
      // OFFER
      // --------------------------------------------------------

      if (payload.type === "offer") {
        console.log("Received offer from:", peerId);

        const pc =
          peers.current.get(peerId) ||
          (await createPeer(peerId, false));

        if (!pc) return;

        await pc.setRemoteDescription(
          new RTCSessionDescription(payload.offer)
        );

        // Apply queued ICE candidates
        const queued =
          pendingCandidates.current.get(peerId) || [];

        for (const candidate of queued) {
          try {
            await pc.addIceCandidate(
              new RTCIceCandidate(candidate)
            );
          } catch (err) {
            console.error("ICE error:", err);
          }
        }

        pendingCandidates.current.delete(peerId);

        const answer = await pc.createAnswer();

        await pc.setLocalDescription(answer);

        await channel.current?.send({
          type: "broadcast",
          event: "signal",
          payload: {
            type: "answer",
            from: me.id,
            to: peerId,
            answer,
          },
        });

        return;
      }

      // --------------------------------------------------------
      // ANSWER
      // --------------------------------------------------------

      if (payload.type === "answer") {
        console.log("Received answer from:", peerId);

        const pc = peers.current.get(peerId);

        if (!pc) return;

        await pc.setRemoteDescription(
          new RTCSessionDescription(payload.answer)
        );

        const queued =
          pendingCandidates.current.get(peerId) || [];

        for (const candidate of queued) {
          try {
            await pc.addIceCandidate(
              new RTCIceCandidate(candidate)
            );
          } catch (err) {
            console.error("ICE error:", err);
          }
        }

        pendingCandidates.current.delete(peerId);

        return;
      }

      // --------------------------------------------------------
      // ICE CANDIDATE
      // --------------------------------------------------------

      if (payload.type === "ice") {
        const pc = peers.current.get(peerId);

        if (!pc || !pc.remoteDescription) {
          const list =
            pendingCandidates.current.get(peerId) || [];

          list.push(payload.candidate);

          pendingCandidates.current.set(peerId, list);

          return;
        }

        try {
          await pc.addIceCandidate(
            new RTCIceCandidate(payload.candidate)
          );
        } catch (err) {
          console.error("Failed to add ICE:", err);
        }

        return;
      }

      // --------------------------------------------------------
      // PEER LEFT
      // --------------------------------------------------------

      if (payload.type === "leave") {
        const pc = peers.current.get(peerId);

        if (pc) {
          pc.close();
          peers.current.delete(peerId);
        }

        setRemoteStreams((current) => {
          const next = { ...current };
          delete next[peerId];
          return next;
        });
      }
    },
    [me, createPeer]
  );

  // ------------------------------------------------------------
  // Supabase signaling channel
  // ------------------------------------------------------------

  useEffect(() => {
    if (!me) return;

    const roomChannel = supabase.channel(
      `meeting:${code}`,
      {
        config: {
          broadcast: {
            self: false,
          },
        },
      }
    );

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
          // Tell everyone that we're ready for WebRTC
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
      supabase.removeChannel(roomChannel);
      channel.current = null;
    };
  }, [me, code, handleSignal]);

  // ------------------------------------------------------------
  // Poll roster + establish peer connections
  // ------------------------------------------------------------

  useEffect(() => {
    if (!me) return;

    const tick = async () => {
      try {
        const r = await api(
          `/meetings/${code}/participants`
        );

        if (r.status === "ended") {
          return exit("?ended=1");
        }

        const mine = r.participants.find(
          (p) => p.id === me.id
        );

        if (!mine) {
          return exit("?removed=1");
        }

        setPeople(r.participants);

        stream.current
          ?.getAudioTracks()
          .forEach(
            (t) => (t.enabled = !mine.is_muted)
          );

        // ------------------------------------------------------
        // Establish WebRTC connections
        //
        // Only the participant with the smaller ID creates
        // the offer. This prevents both sides from offering.
        // ------------------------------------------------------

        for (const participant of r.participants) {
          if (participant.id === me.id) continue;

          if (!peers.current.has(participant.id)) {
            const shouldOffer =
              Number(me.id) < Number(participant.id);

            await createPeer(
              participant.id,
              shouldOffer
            );
          }
        }
      } catch (err) {
        console.error("Roster error:", err);
      }
    };

    tick();

    const timer = setInterval(tick, 2500);

    return () => clearInterval(timer);
  }, [me, code, exit, createPeer]);

  // ------------------------------------------------------------
  // Keep local video attached
  // ------------------------------------------------------------

  useEffect(() => {
    if (videoEl.current && stream.current) {
      videoEl.current.srcObject = stream.current;
    }
  }, [people]);

  // ------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------

  const mine = people.find(
    (p) => p.id === me?.id
  );

  const muted = mine?.is_muted ?? false;

  const toggleMic = async () => {
    try {
      const p = await api(
        `/participants/${me.id}`,
        {
          method: "PATCH",
          body: {
            is_muted: !muted,
          },
        }
      );

      stream.current
        ?.getAudioTracks()
        .forEach(
          (t) => (t.enabled = !p.is_muted)
        );

      setPeople((list) =>
        list.map((x) =>
          x.id === p.id ? p : x
        )
      );
    } catch (err) {
      console.error(err);
    }
  };

  const toggleCam = () => {
    stream.current
      ?.getVideoTracks()
      .forEach(
        (t) => (t.enabled = !camOn)
      );

    setCamOn((value) => !value);
  };

  const leave = async () => {
    try {
      await api(
        `/participants/${me.id}/leave`,
        {
          method: "POST",
        }
      );

      await channel.current?.send({
        type: "broadcast",
        event: "signal",
        payload: {
          type: "leave",
          from: me.id,
          to: null,
        },
      });
    } finally {
      exit();
    }
  };

  const endAll = async () => {
    await api(
      `/meetings/${code}/end`,
      {
        method: "POST",
      }
    );

    exit();
  };

  const muteAll = () =>
    api(
      `/meetings/${code}/mute-all`,
      {
        method: "POST",
      }
    );

  const remove = (id) =>
    api(
      `/participants/${id}/remove`,
      {
        method: "POST",
      }
    );

  const copy = async () => {
    await navigator.clipboard.writeText(
      inviteLink(code)
    );

    setCopied(true);

    setTimeout(
      () => setCopied(false),
      1500
    );
  };

  // ------------------------------------------------------------
  // Video ref
  // ------------------------------------------------------------

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
      }
    },
    [remoteStreams]
  );

  if (!me) return null;

  return (
    <div className="room">

      <div className="room-top">
        <div
          className="info"
          onClick={copy}
          title="Click to copy invite link"
        >
          {copied
            ? "Invite link copied!"
            : `Meeting ID: ${fmtCode(code)}`}
        </div>

        <div>
          {people.length} in meeting
        </div>
      </div>

      <div className="room-main">

        <div className="grid">

          {people.map((p) => {
            const isMe = p.id === me.id;

            const remoteStream =
              remoteStreams[p.id];

            return (
              <div
                className="vtile"
                key={p.id}
              >

                {isMe ? (
                  camOn ? (
                    <video
                      ref={videoEl}
                      autoPlay
                      muted
                      playsInline
                    />
                  ) : (
                    <div className="ava">
                      {p.display_name[0]?.toUpperCase()}
                    </div>
                  )
                ) : remoteStream ? (
                  <video
                    ref={(el) =>
                      attachRemoteVideo(
                        el,
                        p.id
                      )
                    }
                    autoPlay
                    playsInline
                  />
                ) : (
                  <div className="ava">
                    {p.display_name[0]?.toUpperCase()}
                  </div>
                )}

                <div className="name">

                  {p.is_muted && (
                    <MicOff
                      size={14}
                      color="#ff5a5a"
                    />
                  )}

                  {p.display_name}

                  {isMe && " (Me)"}

                  {p.is_host && " (Host)"}

                </div>

              </div>
            );
          })}

        </div>

        {showPeople && (
          <aside className="side">

            <h3>
              Participants ({people.length})
            </h3>

            <div className="plist">

              {people.map((p) => (

                <div
                  className="prow"
                  key={p.id}
                >

                  <div className="avatar">
                    {p.display_name[0]?.toUpperCase()}
                  </div>

                  <div className="grow">
                    {p.display_name}

                    {p.id === me.id &&
                      " (Me)"}

                    {p.is_host &&
                      " (Host)"}
                  </div>

                  {p.is_muted ? (
                    <MicOff
                      size={16}
                      color="#e02828"
                    />
                  ) : (
                    <Mic
                      size={16}
                      color="#6e7681"
                    />
                  )}

                  {me.is_host &&
                    !p.is_host && (
                      <button
                        className="mini"
                        onClick={() =>
                          remove(p.id)
                        }
                      >
                        Remove
                      </button>
                    )}

                </div>

              ))}

            </div>

            {me.is_host && (
              <div
                style={{
                  padding: 12,
                  borderTop:
                    "1px solid var(--line)",
                }}
              >
                <button
                  className="btn btn-ghost"
                  style={{
                    width: "100%",
                  }}
                  onClick={muteAll}
                >
                  Mute All
                </button>
              </div>
            )}

          </aside>
        )}

      </div>

      <div className="toolbar">

        <div className="tb-group">

          <button
            className={`tb-btn ${
              muted ? "off" : ""
            }`}
            onClick={toggleMic}
          >
            {muted ? (
              <MicOff size={22} />
            ) : (
              <Mic size={22} />
            )}

            {muted
              ? "Unmute"
              : "Mute"}
          </button>

          <button
            className={`tb-btn ${
              !camOn ? "off" : ""
            }`}
            onClick={toggleCam}
          >
            {camOn ? (
              <Video size={22} />
            ) : (
              <VideoOff size={22} />
            )}

            {camOn
              ? "Stop Video"
              : "Start Video"}
          </button>

        </div>

        <div className="tb-group">

          <button
            className="tb-btn"
            onClick={() =>
              setShowPeople(
                !showPeople
              )
            }
          >
            <Users size={22} />
            Participants
          </button>

          {me.is_host && (
            <button
              className="tb-btn"
              onClick={muteAll}
            >
              <Shield size={22} />
              Mute All
            </button>
          )}

        </div>

        <div className="tb-group">

          {me.is_host ? (
            <button
              className="leave"
              onClick={endAll}
            >
              End
            </button>
          ) : (
            <button
              className="leave"
              onClick={leave}
            >
              <LogOut
                size={14}
                style={{
                  display: "inline",
                  marginRight: 6,
                }}
              />
              Leave
            </button>
          )}

        </div>

      </div>

    </div>
  );
}