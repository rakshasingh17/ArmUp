# ArmUp (online version)

Rehabilitation depends on consistency, yet repetitive physiotherapy exercises are easy to abandon once the novelty fades. ArmUp addresses this by turning prescribed arm and neck exercises into interactive, game-based sessions that need nothing more than a webcam. Using real-time pose estimation, it counts repetitions, evaluates form against a target range of motion, and records each session, so patients and therapists can follow progress over time.

ArmUp is a mini-project by students of the Department of Computer Science and Technology at Usha Mittal Institute of Technology (SNDT Women's University), Mumbai.

This branch is the **online version**: the desktop app talks to a server, so a therapist and their patients can use ArmUp from different devices. Looking for the single-laptop version? It lives on the [`main`](../../tree/main) branch.

## What it does
- **Separate logins for patients and therapists.** Therapists can follow how their patients are doing, add notes, and edit exercise plans.
- **Appointments.** A therapist books one, and the patient confirms it.
- **Exercise mode.** Structured sets, so a session feels like a real session.
- **Koi "Calm mode".** A gentler game designed with older users in mind.
- **Readability settings.** Larger and darker text.

## Try it
**[Download the Windows installer](https://github.com/rakshasingh17/ArmUp/releases/tag/v0.1-online)**

1. Download the `.exe` from the Assets section of that page.
2. Run it. Windows will probably show a SmartScreen warning, because the app isn't code-signed. Click **More info**, then **Run anyway**.
3. Open ArmUp. A green "Server ready" box in the bottom-left corner means you're connected.

The server runs on a free plan and sleeps when nobody is using it, so the first connection can take up to a minute. Give it a moment.

You'll need a webcam for the exercises and games. Patient sign-up is open to anyone. Therapist sign-up needs an invite code.

## How it fits together
```
Electron app  ──HTTPS──▶  Node API (Render)  ──▶  PostgreSQL (Neon)
```
- The React pages call the API as before. The Electron main process forwards each request to the server over HTTPS, and only `https://` addresses are accepted (plain `http://` is allowed for the same computer).
- The server lives in `armup-dashboard/server/` and has its own `package.json`.
- The server creates its tables when it starts, so there is no manual database setup.

## What changed from the single-laptop version
- **SQLite is gone.** Data lives in PostgreSQL, so everyone sees the same records.
- **Session recording is off.** This was a deliberate choice. The free server wipes its disk when it restarts, and patient videos are the most sensitive data in the app, so we didn't want to half-support them online. The full feature is still on `main`.
- **Security tightening:** secrets and invite codes come from environment variables, not from the code. Login attempts are rate-limited. All queries use placeholders. The demo account is off unless explicitly enabled.

## Run it yourself

**The app**
```
cd armup-dashboard
npm install
```
Then point it at a server and start it (PowerShell):
```
$env:ARMUP_SERVER_URL="https://your-server-address"; npm run electron:dev
```
You can also type the address into the connection box in the bottom-left corner, or set it in `armup-dashboard/electron/server-config.json`.

To build the installer: `npm run electron:build`.

**The server**
```
cd armup-dashboard/server
npm install
node index.cjs
```
It needs these environment variables:

| Name | What it's for |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs login tokens. Must be at least 32 characters |
| `INVITE_CODES` | Comma-separated, single-use therapist invite codes |
| `TRUST_PROXY` | Set to `1` when running behind a host like Render |
| `ENABLE_DEMO` | Optional. Set to `1` to enable the demo patient account |

Never commit real values for any of these.

## Built with
- Electron and React (Vite)
- MediaPipe for pose tracking
- Node.js and PostgreSQL (`pg`)
- Render for the API, Neon for the database

## Team
Raksha Singh, Bhakti More and Arya Satam.

We hope ArmUp makes rehabilitation a little more engaging, and a little easier to stick with.

## A note
This is a student project, so please stick to using fake data. It is not a medical product and shouldn't be used to replace real physiotherapy advice.
