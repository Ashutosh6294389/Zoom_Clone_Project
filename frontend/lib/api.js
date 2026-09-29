const BASE = process.env.NEXT_PUBLIC_API_URL || "";

export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));

    throw new Error(
      typeof e.detail === "string"
        ? e.detail
        : "Something went wrong"
    );
  }

  return r.json();
}

export const fmtCode = (c) =>
  c.replace(/(\d{3})(\d{4})(\d{3,4})/, "$1 $2 $3");

export const inviteLink = (c) =>
  `${typeof window !== "undefined" ? window.location.origin : ""}/meeting/${c}`;

export const fmtDate = (iso) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export async function enterMeeting(code, name, asHost = false) {
  const { participant } = await api(
    `/meetings/${code}/join`,
    {
      method: "POST",
      body: {
        display_name: name,
        as_host: asHost,
      },
    }
  );

  sessionStorage.setItem(
    `zoom:${code}`,
    JSON.stringify(participant)
  );

  return participant;
}