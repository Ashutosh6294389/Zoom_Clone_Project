"use client";
import Link from "next/link";
import { Settings, Bell } from "lucide-react";

export default function Navbar({ user }) {
  return (
    <header className="nav">
      <div className="nav-left">
        <Link href="/" className="logo">zoom</Link>
        <nav className="nav-links">
          <Link href="/" className="active">Home</Link>
          <Link href="/join">Join</Link>
        </nav>
      </div>
      <div className="nav-right">
        <button className="icon-btn" aria-label="Notifications"><Bell size={20} /></button>
        <button className="icon-btn" aria-label="Settings"><Settings size={20} /></button>
        <div className="avatar" title={user?.name}>{user?.name?.[0] || "U"}</div>
      </div>
    </header>
  );
}
