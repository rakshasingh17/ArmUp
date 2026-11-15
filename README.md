# ArmUp

Rehabilitation depends on consistency, yet repetitive physiotherapy exercises are easy to abandon once the novelty fades. ArmUp addresses this by turning prescribed arm and neck exercises into interactive, game-based sessions that need nothing more than a webcam. Using real-time pose estimation, it counts repetitions, evaluates form against a target range of motion, and records each session, so patients and therapists can follow progress over time.

ArmUp is a mini-project by students of the Department of Computer Science and Technology at Usha Mittal Institute of Technology (SNDT Women's University), Mumbai.

## What it does
- **Patients and therapists each get their own login.** Therapists can see how their patients are doing, add notes, and edit exercise plans.
- **Appointments.** A therapist can book one, and the patient confirms it.
- **Exercise mode.** Structured sets (like a fixed 10-rep set), so a session feels like a real session.
- **Koi "Calm mode".** A gentler game where you chase glowing buds with your hand, built with older users in mind.
- **Settings for readability.** Bigger text and darker text, for people who need it.
- **Session recording (with consent).** Patients can choose to let their therapist watch a recorded set. This is available on this branch only.

## Two versions
The project exists in two forms, and it's worth knowing which one you're looking at.

| | `main` (you are here) | `server-postgres` |
|---|---|---|
| Where it runs | Entirely on one laptop | Desktop app plus an online server |
| Database | Local SQLite | PostgreSQL on Neon, API on Render |
| Session recording | Yes | Off |

We switched to an online server so that therapists and patients can use it from different devices. We left recording off there on purpose: the free server wipes its disk when it restarts, and patient videos are the most sensitive data in the app, so we didn't want to half-support them online.

## Try it (online version)
**[Download the Windows installer](https://github.com/rakshasingh17/ArmUp/releases/tag/v0.1-online)**

1. Download the `.exe` from the Assets section of that page.
2. Run it. Windows will probably show a SmartScreen warning, because the app isn't code-signed. Click **More info**, then **Run anyway**.
3. Open ArmUp. A green "Server ready" box in the bottom-left corner means you're connected.

A heads-up: the server runs on a free plan and goes to sleep when nobody's using it. If it's been idle, the first connection can take up to a minute. Give it a moment and it will wake up.

You'll need a webcam for the exercises and games. Signing up as a patient is open to anyone. Therapist sign-up needs an invite code.

## Run it from source
This branch runs fully on your own machine:

```
cd armup-dashboard
npm install
npm run electron:dev
```

## Built with
- Electron and React (Vite) for the desktop app
- MediaPipe for pose tracking
- Node.js with SQLite on this branch
- Node.js with PostgreSQL, deployed on Render and Neon, on the `server-postgres` branch

## Team
Raksha Singh, Bhakti More and Arya Satam

We hope ArmUp makes rehabilitation a little more engaging, and a little easier to stick with.

## A note
This is a student project, so please stick to using fake data. It is not a medical product and shouldn't be used to replace real physiotherapy advice.

## A note
This is a student project, so please use fake data only. It is not a medical product and shouldn't be used to replace real physiotherapy advice.
