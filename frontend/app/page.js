"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Video, Plus, CalendarDays, UserPlus } from "lucide-react";

import Navbar from "@/components/Navbar";
import MeetingList from "@/components/MeetingList";
import ScheduleModal from "@/components/ScheduleModal";
import { api, enterMeeting, inviteLink, fmtCode } from "@/lib/api";

export default function Dashboard() {
  const router = useRouter();

  const [user, setUser] = useState(null);
  const [upcoming, setUpcoming] = useState([]);
  const [recent, setRecent] = useState([]);
  const [tab, setTab] = useState("upcoming");
  const [modal, setModal] = useState(false);
  const [toast, setToast] = useState("");

  // Start with null so server and client render the same HTML
  const [time, setTime] = useState(null);

  const load = useCallback(async () => {
    try {
      const [u, up, rc] = await Promise.all([
        api("/me"),
        api("/meetings/upcoming"),
        api("/meetings/recent"),
      ]);

      setUser(u);
      setUpcoming(up);
      setRecent(rc);
    } catch {
      setToast("Cannot reach the server. Is the backend running?");
    }
  }, []);

  useEffect(() => {
    // Set the time only on the client
    setTime(new Date());

    const interval = setInterval(() => {
      setTime(new Date());
    }, 1000);

    load();

    return () => clearInterval(interval);
  }, [load]);

  const flash = (msg) => {
    setToast(msg);

    setTimeout(() => {
      setToast("");
    }, 2500);
  };

  async function start(code) {
    try {
      await enterMeeting(code, user?.name || "Guest", true);
      router.push(`/meeting/${code}`);
    } catch (e) {
      flash(e.message || "Unable to join meeting");
    }
  }

  async function newMeeting() {
    try {
      const m = await api("/meetings/instant", {
        method: "POST",
        body: {},
      });

      await start(m.code);
    } catch (e) {
      flash(e.message || "Unable to create meeting");
    }
  }

  const copy = async (m) => {
    try {
      await navigator.clipboard.writeText(
        `Join Zoom Meeting\n${inviteLink(m.code)}\nMeeting ID: ${fmtCode(
          m.code
        )}`
      );

      flash("Invite copied to clipboard");
    } catch {
      flash("Unable to copy invite");
    }
  };

  const tiles = [
    {
      label: "New Meeting",
      icon: <Video size={40} />,
      color: "var(--orange)",
      on: newMeeting,
    },
    {
      label: "Join",
      icon: <Plus size={40} />,
      color: "var(--blue)",
      on: () => router.push("/join"),
    },
    {
      label: "Schedule",
      icon: <CalendarDays size={40} />,
      color: "var(--blue)",
      on: () => setModal(true),
    },
    {
      label: "Invite",
      icon: <UserPlus size={40} />,
      color: "var(--blue)",
      on: () => router.push("/join"),
    },
  ];

  return (
    <>
      <Navbar user={user} />

      <main className="dash">
        <section>
          <div className="clock">
            <h1>
              {time
                ? time.toLocaleTimeString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "--:--"}
            </h1>

            <p>
              {time
                ? time.toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })
                : ""}
            </p>
          </div>

          <div className="tiles">
            {tiles.map((t) => (
              <button
                key={t.label}
                className="tile"
                onClick={t.on}
              >
                <div
                  className="tile-icon"
                  style={{ background: t.color }}
                >
                  {t.icon}
                </div>

                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section
          className="panel"
          style={{ alignSelf: "start" }}
        >
          <div className="tabs">
            <button
              className={`tab ${tab === "upcoming" ? "on" : ""}`}
              onClick={() => setTab("upcoming")}
            >
              Upcoming
            </button>

            <button
              className={`tab ${tab === "recent" ? "on" : ""}`}
              onClick={() => setTab("recent")}
            >
              Recent
            </button>
          </div>

          <MeetingList
            items={tab === "upcoming" ? upcoming : recent}
            type={tab}
            onStart={(m) => start(m.code)}
            onCopy={copy}
          />
        </section>
      </main>

      {modal && (
        <ScheduleModal
          onClose={() => setModal(false)}
          onCreated={(m) => {
            setModal(false);
            load();
            flash(`Scheduled! Meeting ID ${fmtCode(m.code)}`);
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}