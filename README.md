# Zoom Clone (SDE Fullstack Assignment)

Video-conferencing web app modelled on Zoom's web UI: dashboard, instant meetings, join by ID/link, scheduling, participant list and host controls.

## Tech stack
- **Frontend:** Next.js 14 (App Router, client-rendered SPA), plain CSS, lucide-react icons
- **Backend:** Python, FastAPI, SQLAlchemy
- **Database:** SQLite (`backend/zoom.db`, auto-created and seeded on first run)

## Run locally
```bash
# Backend (http://localhost:8000, docs at /docs)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend (http://localhost:3000)
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

## Database schema
- `users` (id, name, email)
- `meetings` (id, code [10-digit ID, unique], title, description, host_id -> users, kind instant|scheduled, status scheduled|live|ended, scheduled_start, duration_min, started_at, ended_at, created_at)
- `participants` (id, meeting_id -> meetings, user_id -> users [null for guests], display_name, is_host, is_muted, status joined|left|removed, joined_at, left_at)

One user hosts many meetings; one meeting has many participants (participants are per-join records, so history is kept).

## API summary
| Method | Path | Purpose |
|---|---|---|
| GET | /api/me | Default logged-in user |
| GET | /api/meetings/upcoming, /recent | Dashboard lists |
| POST | /api/meetings/instant | Create instant meeting |
| POST | /api/meetings/schedule | Schedule a meeting |
| GET | /api/meetings/lookup/find?q= | Validate meeting (accepts ID or invite link) |
| POST | /api/meetings/{code}/join | Join with display name |
| GET | /api/meetings/{code}/participants | Live roster |
| POST | /api/meetings/{code}/mute-all, /end | Host controls |
| PATCH | /api/participants/{id} | Mute/unmute |
| POST | /api/participants/{id}/leave, /remove | Leave / host removes |

## Assumptions
- No auth: a seeded "Demo User" is always logged in and hosts the meetings on the dashboard.
- Camera/mic work locally through `getUserMedia`. **Media is not streamed between browsers** (no WebRTC signalling); other participants appear as avatar tiles driven by the database roster. Meeting logic (IDs, links, roster, mute all, remove, end) is fully functional.
- Times are stored in UTC and shown in the browser's local timezone.
- The client polls the roster every 2.5s instead of using WebSockets.

## Deployment
- Backend: Render/Railway (`uvicorn main:app --host 0.0.0.0 --port $PORT`). SQLite lives on the instance disk, so it resets on redeploy; the seed re-runs automatically.
- Frontend: Vercel, with `NEXT_PUBLIC_API_URL` set to the deployed backend URL.

## Possible next steps
WebRTC media via a signalling WebSocket, chat, screen share, login/signup.
