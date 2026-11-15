import React, { useState, useEffect } from 'react';
import LandingPage from './LandingPage';
import SignupPage from './SignupPage';
import LoginPage from './LoginPage';
import ArmUpDashboard from './armUpDashboard';
import TherapistDashboard from './TherapistDashboard';
import ServerStatus from './ServerStatus';
import { apiFetch, setAuthToken, setUnauthorizedHandler } from './api';

// Where the app starts before anyone has logged in (never shown as a real user).
const TEST_PATIENT_ID = 1;

// What is remembered between launches: who is logged in, their role and their
// login token. Never the password. The token expires on its own (8 hours);
// when the main process rejects it the app logs the user out.
const SESSION_KEY = 'armup.session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const valid =
      Number.isInteger(s?.userId) &&
      typeof s?.token === 'string' &&
      (s?.role === 'patient' || s?.role === 'therapist');
    return valid
      ? { userId: s.userId, role: s.role, token: s.token, isDemo: !!s.isDemo }
      : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked (private mode etc.) -- the app still works, it just
    // won't remember you across reloads.
  }
}

export default function App() {
  // If someone was logged in before the reload, go straight back to their dashboard.
  const [saved] = useState(() => {
    const s = loadSession();
    setAuthToken(s ? s.token : null);
    return s;
  });

  const [screen, setScreen] = useState(saved ? 'dashboard' : 'landing'); // 'landing' | 'signup' | 'login' | 'dashboard'
  const [activeUserId, setActiveUserId] = useState(saved ? saved.userId : TEST_PATIENT_ID);
  const [role, setRole] = useState(saved ? saved.role : 'patient');
  const [demoError, setDemoError] = useState(null);

  // `user` is the answer from /login, /users or /demo-login: { id, role, token, ... }.
  const openDashboard = (user, demo = false) => {  // demo: "Continue as test patient" (a normal patient login)
    setAuthToken(user.token);
    saveSession({ userId: user.id, role: user.role, token: user.token, isDemo: demo });
    setActiveUserId(user.id);
    setRole(user.role);
    setScreen('dashboard');
  };

  const logOut = () => {
    setAuthToken(null);
    saveSession(null);
    setRole('patient');
    setScreen('landing');
  };

  // If the main process says our token is no longer good, go back to the start.
  useEffect(() => {
    setUnauthorizedHandler(logOut);
    return () => setUnauthorizedHandler(null);
  });

  const startDemo = async () => {
    setDemoError(null);
    try {
      const res = await apiFetch('/demo-login', { method: 'POST', body: '{}' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // 404 = the server has the demo account switched off; 503 = can't reach it.
        setDemoError(
          res.status === 404
            ? 'The demo account is not available on this server. Please log in or sign up.'
            : typeof data?.detail === 'string' ? data.detail : "Couldn't open the demo account."
        );
        return;
      }
      openDashboard(data, true);
    } catch (err) {
      console.error(err);
      setDemoError("Couldn't open the demo account.");
    }
  };

  if (screen === 'signup') {
    return (
      <>
        <SignupPage
          onBack={() => setScreen('landing')}
          onLogin={() => setScreen('login')}
          onCreated={(user) => openDashboard(user)}
        />
        <ServerStatus />
      </>
    );
  }

  if (screen === 'login') {
    return (
      <>
        <LoginPage
          onBack={() => setScreen('landing')}
          onSignup={() => setScreen('signup')}
          onLoggedIn={(user) => openDashboard(user)}
        />
        <ServerStatus />
      </>
    );
  }

  if (screen === 'dashboard') {
    // Therapists get their own screen; patients get the exercise dashboard.
    if (role === 'therapist') {
      return <TherapistDashboard userId={activeUserId} onExit={logOut} />;
    }
    return (
      <ArmUpDashboard
        initialUserId={activeUserId}
        onExit={logOut}
      />
    );
  }

  return (
    <>
      <LandingPage
        onGetStarted={() => setScreen('signup')}
        onLogin={() => setScreen('login')}
        onDemo={startDemo}
        demoError={demoError}
      />
      <ServerStatus />
    </>
  );
}