"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { MessageSquare, Mic, MicOff, MonitorOff, MonitorUp, Send, Users, Shield, LogOut, Video, VideoOff } from "lucide-react";
import { api, fmtCode, inviteLink } from "@/lib/api";
import { supabase } from "@/lib/supabase";

const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function StreamVideo({ stream, local = false }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} className={local ? "local-video" : "remote-video"} autoPlay muted={local} playsInline />;
}

export default function Room() {
  const { code } = useParams();
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [people, setPeople] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [camOn, setCamOn] = useState(true);
  const [screenShareOn, setScreenShareOn] = useState(false);
  const [sideMode, setSideMode] = useState("people");
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [mediaError, setMediaError] = useState("");
  const stream = useRef(null);
  const screenStream = useRef(null);
  const peers = useRef(new Map());
  const pendingCandidates = useRef(new Map());
  const channel = useRef(null);

  const exit = useCallback((query = "") => {
    stream.current?.getTracks().forEach((track) => track.stop());
    screenStream.current?.getTracks().forEach((track) => track.stop());
    router.replace("/" + query);
  }, [router]);

  useEffect(() => {
    const saved = sessionStorage.getItem(`zoom:${code}`);
    if (!saved) return router.replace(`/join?code=${code}`);
    setMe(JSON.parse(saved));
  }, [code, router]);

  const replaceOutgoingVideo = useCallback(async (track) => {
    await Promise.all([...peers.current.values()].map(async (peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
    }));
  }, []);

  const stopScreenShare = useCallback(async () => {
    const shared = screenStream.current;
    if (!shared) return;
    screenStream.current = null;
    const cameraTrack = stream.current?.getVideoTracks()[0];
    if (cameraTrack) await replaceOutgoingVideo(cameraTrack);
    shared.getTracks().forEach((track) => track.stop());
    setScreenShareOn(false);
  }, [replaceOutgoingVideo]);

  const startScreenShare = async () => {
    try {
      const shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const screenTrack = shared.getVideoTracks()[0];
      if (!screenTrack) return;
      screenStream.current = shared;
      screenTrack.onended = stopScreenShare;
      await replaceOutgoingVideo(screenTrack);
      setScreenShareOn(true);
    } catch (error) {
      if (error.name !== "NotAllowedError") setMediaError("Unable to start screen share.");
    }
  };

  useEffect(() => {
    if (!me) return;
    let active = true;

    const removePeer = (participantId) => {
      const peer = peers.current.get(participantId);
      peers.current.delete(participantId);
      pendingCandidates.current.delete(participantId);
      if (peer) {
        peer.onconnectionstatechange = null;
        peer.close();
      }
      setRemoteStreams((current) => {
        const next = { ...current };
        delete next[participantId];
        return next;
      });
    };

    const sendSignal = async (to, signal) => {
      if (!channel.current) return;
      await channel.current.send({ type: "broadcast", event: "signal", payload: { to, from: String(me.id), signal } });
    };

    const createPeer = (participantId, capturedStream) => {
      const existing = peers.current.get(participantId);
      if (existing) return existing;
      const peer = new RTCPeerConnection(rtcConfig);
      capturedStream.getTracks().forEach((track) => peer.addTrack(track, capturedStream));
      const screenTrack = screenStream.current?.getVideoTracks()[0];
      if (screenTrack) peer.getSenders().find((item) => item.track?.kind === "video")?.replaceTrack(screenTrack);
      peer.onicecandidate = ({ candidate }) => { if (candidate) sendSignal(participantId, { type: "candidate", candidate }); };
      peer.ontrack = ({ streams }) => { if (streams[0]) setRemoteStreams((current) => ({ ...current, [participantId]: streams[0] })); };
      peer.onconnectionstatechange = () => { if (["failed", "closed"].includes(peer.connectionState)) removePeer(participantId); };
      peers.current.set(participantId, peer);
      return peer;
    };

    const flushCandidates = async (participantId, peer) => {
      const queued = pendingCandidates.current.get(participantId) || [];
      pendingCandidates.current.delete(participantId);
      for (const candidate of queued) await peer.addIceCandidate(candidate);
    };

    const connect = async () => {
      try {
        const capturedStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (!active) return capturedStream.getTracks().forEach((track) => track.stop());
        stream.current = capturedStream;
        setLocalStream(capturedStream);
      } catch {
        setCamOn(false);
        setMediaError("Camera or microphone access was blocked.");
        return;
      }

      if (!supabase) {
        setMediaError("Realtime video and chat need the Supabase environment variables.");
        return;
      }

      const realtime = supabase.channel(`meeting:${code}`, { config: { broadcast: { self: false }, presence: { key: String(me.id) } } });
      channel.current = realtime;
      realtime
        .on("broadcast", { event: "signal" }, async ({ payload }) => {
          if (!active || payload.to !== String(me.id)) return;
          const peer = createPeer(payload.from, stream.current);
          const signal = payload.signal;
          if (signal.type === "offer") {
            await peer.setRemoteDescription(signal);
            await flushCandidates(payload.from, peer);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            await sendSignal(payload.from, peer.localDescription);
          } else if (signal.type === "answer") {
            await peer.setRemoteDescription(signal);
            await flushCandidates(payload.from, peer);
          } else if (signal.type === "candidate" && signal.candidate) {
            if (peer.remoteDescription) await peer.addIceCandidate(signal.candidate);
            else pendingCandidates.current.set(payload.from, [...(pendingCandidates.current.get(payload.from) || []), signal.candidate]);
          }
        })
        .on("broadcast", { event: "chat" }, ({ payload }) => { if (active) setMessages((current) => [...current, payload]); })
        .on("presence", { event: "sync" }, async () => {
          const presence = realtime.presenceState();
          const participantIds = Object.values(presence).flat().map((item) => item.participantId).filter((id) => id && id !== String(me.id));
          for (const participantId of new Set(participantIds)) {
            if (Number(me.id) <= Number(participantId) || peers.current.has(participantId)) continue;
            const peer = createPeer(participantId, stream.current);
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            await sendSignal(participantId, peer.localDescription);
          }
        })
        .on("presence", { event: "leave" }, ({ leftPresences }) => { leftPresences.forEach((presence) => removePeer(presence.participantId)); })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") await realtime.track({ participantId: String(me.id), displayName: me.display_name });
        });
    };

    connect();
    return () => {
      active = false;
      if (channel.current) supabase?.removeChannel(channel.current);
      channel.current = null;
      peers.current.forEach((peer) => { peer.onconnectionstatechange = null; peer.close(); });
      peers.current.clear();
      pendingCandidates.current.clear();
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      screenStream.current?.getTracks().forEach((track) => track.stop());
      screenStream.current = null;
    };
  }, [code, me]);

  useEffect(() => {
    if (!me) return;
    const tick = async () => {
      try {
        const response = await api(`/meetings/${code}/participants`);
        if (response.status === "ended") return exit("?ended=1");
        const mine = response.participants.find((participant) => participant.id === me.id);
        if (!mine) return exit("?removed=1");
        setPeople(response.participants);
        stream.current?.getAudioTracks().forEach((track) => { track.enabled = !mine.is_muted; });
      } catch {}
    };
    tick();
    const timer = setInterval(tick, 2500);
    return () => clearInterval(timer);
  }, [me, code, exit]);

  const mine = people.find((person) => person.id === me?.id);
  const muted = mine?.is_muted ?? false;
  const toggleMic = () => api(`/participants/${me.id}`, { method: "PATCH", body: { is_muted: !muted } }).then((participant) => setPeople((current) => current.map((person) => person.id === participant.id ? participant : person)));
  const toggleCam = () => { stream.current?.getVideoTracks().forEach((track) => { track.enabled = !camOn; }); setCamOn(!camOn); };
  const leave = async () => { await api(`/participants/${me.id}/leave`, { method: "POST" }); exit(); };
  const endAll = async () => { await api(`/meetings/${code}/end`, { method: "POST" }); exit(); };
  const muteAll = () => api(`/meetings/${code}/mute-all`, { method: "POST" });
  const remove = (id) => api(`/participants/${id}/remove`, { method: "POST" });
  const copy = async () => { await navigator.clipboard.writeText(inviteLink(code)); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const sendChat = async (event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !channel.current) return;
    const message = { id: `${me.id}-${Date.now()}`, senderId: String(me.id), name: me.display_name, body, sentAt: new Date().toISOString() };
    setMessages((current) => [...current, message]);
    setDraft("");
    await channel.current.send({ type: "broadcast", event: "chat", payload: message });
  };

  if (!me) return null;
  const displayStream = screenShareOn ? screenStream.current : localStream;
  return (
    <div className="room">
      <div className="room-top"><div className="info" onClick={copy} title="Click to copy invite link">{copied ? "Invite link copied!" : `Meeting ID: ${fmtCode(code)}`}</div><div>{people.length} in meeting</div></div>
      {mediaError && <div className="room-alert">{mediaError}</div>}
      <div className="room-main"><div className="grid">{people.map((person) => <div className="vtile" key={person.id}>{person.id === me.id && camOn && displayStream ? <StreamVideo stream={displayStream} local={!screenShareOn} /> : remoteStreams[person.id] ? <StreamVideo stream={remoteStreams[person.id]} /> : <div className="ava">{person.display_name[0]?.toUpperCase()}</div>}<div className="name">{person.is_muted && <MicOff size={14} color="#ff5a5a" />}{person.display_name}{person.id === me.id && " (Me)"}{person.is_host && " (Host)"}</div></div>)}</div>
        {sideMode === "people" ? <aside className="side"><h3>Participants ({people.length})</h3><div className="plist">{people.map((person) => <div className="prow" key={person.id}><div className="avatar">{person.display_name[0]?.toUpperCase()}</div><div className="grow">{person.display_name}{person.id === me.id && " (Me)"}{person.is_host && " (Host)"}</div>{person.is_muted ? <MicOff size={16} color="#e02828" /> : <Mic size={16} color="#6e7681" />}{me.is_host && !person.is_host && <button className="mini" onClick={() => remove(person.id)}>Remove</button>}</div>)}</div>{me.is_host && <div className="side-action"><button className="btn btn-ghost" onClick={muteAll}>Mute All</button></div>}</aside> : <aside className="side chat"><h3>Meeting chat</h3><div className="chat-list">{messages.length ? messages.map((message) => <div className="chat-message" key={message.id}><strong>{message.senderId === String(me.id) ? "You" : message.name}</strong><span>{message.body}</span></div>) : <div className="chat-empty">No messages yet.</div>}</div><form className="chat-form" onSubmit={sendChat}><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type a message" /><button className="icon-btn" type="submit" aria-label="Send message"><Send size={18} /></button></form></aside>}
      </div>
      <div className="toolbar"><div className="tb-group"><button className={`tb-btn ${muted ? "off" : ""}`} onClick={toggleMic}>{muted ? <MicOff size={22} /> : <Mic size={22} />}{muted ? "Unmute" : "Mute"}</button><button className={`tb-btn ${!camOn ? "off" : ""}`} onClick={toggleCam}>{camOn ? <Video size={22} /> : <VideoOff size={22} />}{camOn ? "Stop Video" : "Start Video"}</button><button className={`tb-btn ${screenShareOn ? "off" : ""}`} onClick={screenShareOn ? stopScreenShare : startScreenShare}>{screenShareOn ? <MonitorOff size={22} /> : <MonitorUp size={22} />}{screenShareOn ? "Stop Share" : "Share"}</button></div><div className="tb-group"><button className="tb-btn" onClick={() => setSideMode(sideMode === "people" ? "chat" : "people")}>{sideMode === "people" ? <MessageSquare size={22} /> : <Users size={22} />}{sideMode === "people" ? "Chat" : "Participants"}</button>{me.is_host && <button className="tb-btn" onClick={muteAll}><Shield size={22} />Mute All</button>}</div><div className="tb-group">{me.is_host ? <button className="leave" onClick={endAll}>End</button> : <button className="leave" onClick={leave}><LogOut size={14} />Leave</button>}</div></div>
    </div>
  );
}
