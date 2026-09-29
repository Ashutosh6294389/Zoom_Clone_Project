"use client";
import { useState } from "react";
import { api } from "@/lib/api";

const pad = (n) => String(n).padStart(2, "0");
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default function ScheduleModal({ onClose, onCreated }) {
  const soon = new Date(Date.now() + 3600e3); soon.setMinutes(0);
  const [f, setF] = useState({ title: "", description: "", start: localInput(soon), hours: 0, minutes: 30 });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    const dur = Number(f.hours) * 60 + Number(f.minutes);
    if (!f.title.trim()) return setErr("Please enter a topic.");
    if (!f.start) return setErr("Please pick a date and time.");
    if (dur < 5) return setErr("Duration must be at least 5 minutes.");
    setBusy(true);
    try {
      const m = await api("/meetings/schedule", { method: "POST", body: { title: f.title, description: f.description, start: new Date(f.start).toISOString(), duration_min: dur } });
      onCreated(m);
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Schedule Meeting</h2>
        {err && <div className="err">{err}</div>}
        <div className="field"><label>Topic</label><input value={f.title} onChange={set("title")} placeholder="My Meeting" autoFocus /></div>
        <div className="field"><label>Description (optional)</label><textarea rows={3} value={f.description} onChange={set("description")} /></div>
        <div className="field"><label>When</label><input type="datetime-local" value={f.start} onChange={set("start")} /></div>
        <div className="row2">
          <div className="field"><label>Hours</label><input type="number" min="0" max="23" value={f.hours} onChange={set("hours")} /></div>
          <div className="field"><label>Minutes</label><input type="number" min="0" max="59" step="5" value={f.minutes} onChange={set("minutes")} /></div>
        </div>
        <div className="footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>Save</button>
        </div>
      </div>
    </div>
  );
}
