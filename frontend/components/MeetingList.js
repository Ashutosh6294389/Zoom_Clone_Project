"use client";
import { fmtCode, fmtDate } from "@/lib/api";

export default function MeetingList({ items, type, onStart, onCopy }) {
  if (!items.length) return <div className="empty">{type === "upcoming" ? "No upcoming meetings. Schedule one to get started." : "No recent meetings yet."}</div>;
  return items.map((m) => (
    <div className="m-row" key={m.id}>
      <div>
        <div className="m-title">{m.title}{m.status === "live" && <span className="badge">LIVE</span>}</div>
        <div className="m-sub">{fmtDate(m.scheduled_start)} · {m.duration_min} min · ID {fmtCode(m.code)}</div>
      </div>
      <div className="actions">
        {type === "upcoming" && <button className="btn btn-primary" onClick={() => onStart(m)}>Start</button>}
        {m.status !== "ended" && <button className="btn btn-ghost" onClick={() => onCopy(m)}>Copy invite</button>}
      </div>
    </div>
  ));
}
