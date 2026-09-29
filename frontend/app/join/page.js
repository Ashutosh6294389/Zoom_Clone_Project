"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import { api, enterMeeting } from "@/lib/api";

export default function JoinPage() {
  const router = useRouter();
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("code")) setId(p.get("code"));
    api("/me").then((u) => setName(u.name)).catch(() => {});
  }, []);

  async function join() {
    setErr("");
    if (!id.trim()) return setErr("Enter a meeting ID or invite link.");
    if (!name.trim()) return setErr("Enter your name.");
    setBusy(true);
    try {
      const m = await api(`/meetings/lookup/find?q=${encodeURIComponent(id.trim())}`); // validates existence
      await enterMeeting(m.code, name.trim(), false);
      router.push(`/meeting/${m.code}`);
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <>
      <Navbar />
      <div className="center-page">
        <div className="card">
          <h1>Join Meeting</h1>
          {err && <div className="err">{err}</div>}
          <div className="field"><label>Meeting ID or invite link</label>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder="123 456 7890" onKeyDown={(e) => e.key === "Enter" && join()} autoFocus /></div>
          <div className="field"><label>Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()} /></div>
          <div className="footer">
            <button className="btn btn-ghost" onClick={() => router.push("/")}>Cancel</button>
            <button className="btn btn-primary" onClick={join} disabled={busy}>Join</button>
          </div>
        </div>
      </div>
    </>
  );
}
