"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Mic, MicOff, Video, VideoOff, Users, Shield, LogOut } from "lucide-react";
import { api, fmtCode, inviteLink } from "@/lib/api";

export default function Room() {
  const { code } = useParams();
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [people, setPeople] = useState([]);
  const [camOn, setCamOn] = useState(true);
  const [showPeople, setShowPeople] = useState(true);
  const [copied, setCopied] = useState(false);
  const stream = useRef(null);
  const videoEl = useRef(null);

  const exit = useCallback((q = "") => {
    stream.current?.getTracks().forEach((t) => t.stop());
    router.replace("/" + q);
  }, [router]);

  // Restore my participant record, or send the user to the join screen
  useEffect(() => {
    const saved = sessionStorage.getItem(`zoom:${code}`);
    if (!saved) return router.replace(`/join?code=${code}`);
    setMe(JSON.parse(saved));
  }, [code, router]);

  // Camera + mic (local only)
  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: true, audio: true })
      .then((s) => { stream.current = s; if (videoEl.current) videoEl.current.srcObject = s; })
      .catch(() => setCamOn(false));
    return () => stream.current?.getTracks().forEach((t) => t.stop());
  }, [me?.id]);

  // Poll roster: detects removal, meeting end, and host's mute-all
  useEffect(() => {
    if (!me) return;
    const tick = async () => {
      try {
        const r = await api(`/meetings/${code}/participants`);
        if (r.status === "ended") return exit("?ended=1");
        const mine = r.participants.find((p) => p.id === me.id);
        if (!mine) return exit("?removed=1");
        setPeople(r.participants);
        stream.current?.getAudioTracks().forEach((t) => (t.enabled = !mine.is_muted));
      } catch {}
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => clearInterval(t);
  }, [me, code, exit]);

  useEffect(() => { if (videoEl.current && stream.current) videoEl.current.srcObject = stream.current; });

  const mine = people.find((p) => p.id === me?.id);
  const muted = mine?.is_muted ?? false;

  const toggleMic = () => api(`/participants/${me.id}`, { method: "PATCH", body: { is_muted: !muted } }).then((p) => setPeople((l) => l.map((x) => (x.id === p.id ? p : x))));
  const toggleCam = () => { stream.current?.getVideoTracks().forEach((t) => (t.enabled = !camOn)); setCamOn(!camOn); };
  const leave = async () => { await api(`/participants/${me.id}/leave`, { method: "POST" }); exit(); };
  const endAll = async () => { await api(`/meetings/${code}/end`, { method: "POST" }); exit(); };
  const muteAll = () => api(`/meetings/${code}/mute-all`, { method: "POST" });
  const remove = (id) => api(`/participants/${id}/remove`, { method: "POST" });
  const copy = async () => { await navigator.clipboard.writeText(inviteLink(code)); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  if (!me) return null;
  return (
    <div className="room">
      <div className="room-top">
        <div className="info" onClick={copy} title="Click to copy invite link">
          {copied ? "Invite link copied!" : `Meeting ID: ${fmtCode(code)}`}
        </div>
        <div>{people.length} in meeting</div>
      </div>

      <div className="room-main">
        <div className="grid">
          {people.map((p) => (
            <div className="vtile" key={p.id}>
              {p.id === me.id && camOn ? <video ref={videoEl} autoPlay muted playsInline /> : <div className="ava">{p.display_name[0]?.toUpperCase()}</div>}
              <div className="name">{p.is_muted && <MicOff size={14} color="#ff5a5a" />}{p.display_name}{p.id === me.id && " (Me)"}{p.is_host && " (Host)"}</div>
            </div>
          ))}
        </div>

        {showPeople && (
          <aside className="side">
            <h3>Participants ({people.length})</h3>
            <div className="plist">
              {people.map((p) => (
                <div className="prow" key={p.id}>
                  <div className="avatar">{p.display_name[0]?.toUpperCase()}</div>
                  <div className="grow">{p.display_name}{p.id === me.id && " (Me)"}{p.is_host && " (Host)"}</div>
                  {p.is_muted ? <MicOff size={16} color="#e02828" /> : <Mic size={16} color="#6e7681" />}
                  {me.is_host && !p.is_host && <button className="mini" onClick={() => remove(p.id)}>Remove</button>}
                </div>
              ))}
            </div>
            {me.is_host && <div style={{ padding: 12, borderTop: "1px solid var(--line)" }}><button className="btn btn-ghost" style={{ width: "100%" }} onClick={muteAll}>Mute All</button></div>}
          </aside>
        )}
      </div>

      <div className="toolbar">
        <div className="tb-group">
          <button className={`tb-btn ${muted ? "off" : ""}`} onClick={toggleMic}>{muted ? <MicOff size={22} /> : <Mic size={22} />}{muted ? "Unmute" : "Mute"}</button>
          <button className={`tb-btn ${!camOn ? "off" : ""}`} onClick={toggleCam}>{camOn ? <Video size={22} /> : <VideoOff size={22} />}{camOn ? "Stop Video" : "Start Video"}</button>
        </div>
        <div className="tb-group">
          <button className="tb-btn" onClick={() => setShowPeople(!showPeople)}><Users size={22} />Participants</button>
          {me.is_host && <button className="tb-btn" onClick={muteAll}><Shield size={22} />Mute All</button>}
        </div>
        <div className="tb-group">
          {me.is_host ? <button className="leave" onClick={endAll}>End</button> : <button className="leave" onClick={leave}><LogOut size={14} style={{ display: "inline", marginRight: 6 }} />Leave</button>}
        </div>
      </div>
    </div>
  );
}
