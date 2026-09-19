import React, { useState } from 'react';
import LandingPage from './LandingPage';
import SignupPage from './SignupPage';
import LoginPage from './LoginPage';
import ArmUpDashboard from './armUpDashboard';

// Raksha's existing test patient. If her seeded user id in armup_db.py
// isn't 1, update this constant to match.
const TEST_PATIENT_ID = 1;

// Only the user id (and whether it's the demo) is saved -- never the password.
const SESSION_KEY = 'armup.session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return Number.isInteger(s?.userId) ? { userId: s.userId, isDemo: !!s.isDemo } : null;
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
  const [saved] = useState(loadSession);

  const [screen, setScreen] = useState(saved ? 'dashboard' : 'landing'); // 'landing' | 'signup' | 'login' | 'dashboard'
  const [activeUserId, setActiveUserId] = useState(saved ? saved.userId : TEST_PATIENT_ID);
  // Demo mode = "Continue as test patient": the dashboard lets you flip
  // between patient IDs. Logged-in / freshly signed-up users only see their own.
  const [isDemo, setIsDemo] = useState(saved ? saved.isDemo : false);

  const openDashboard = (userId, demo = false) => {
    saveSession({ userId, isDemo: demo });
    setActiveUserId(userId);
    setIsDemo(demo);
    setScreen('dashboard');
  };

  const logOut = () => {
    saveSession(null);
    setIsDemo(false);
    setScreen('landing');
  };

  if (screen === 'signup') {
    return (
      <SignupPage
        onBack={() => setScreen('landing')}
        onLogin={() => setScreen('login')}
        onCreated={(newUserId) => openDashboard(newUserId)}
      />
    );
  }

  if (screen === 'login') {
    return (
      <LoginPage
        onBack={() => setScreen('landing')}
        onSignup={() => setScreen('signup')}
        onLoggedIn={(userId) => openDashboard(userId)}
      />
    );
  }

  if (screen === 'dashboard') {
    return (
      <ArmUpDashboard
        initialUserId={activeUserId}
        allowPatientSwitch={isDemo}
        onExit={logOut}
      />
    );
  }

  return (
    <LandingPage
      onGetStarted={() => setScreen('signup')}
      onLogin={() => setScreen('login')}
      onDemo={() => openDashboard(TEST_PATIENT_ID, true)}
    />
  );
}