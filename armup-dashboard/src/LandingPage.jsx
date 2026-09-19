import React from 'react';
import { Dumbbell, Activity, TrendingUp, Flame, ArrowRight } from 'lucide-react';

const FEATURES = [
  {
    icon: Activity,
    bg: '#E8E2A8',
    ink: '#6B6434',
    title: 'Reps tracked automatically',
    body: 'Your webcam and MediaPipe pose tracking count clean reps in real time — no wearables, no manual logging.',
  },
  {
    icon: TrendingUp,
    bg: '#F3D9E2',
    ink: '#B15C7E',
    title: 'See your form improve',
    body: 'Every session logs accuracy against your target range of motion, so progress shows up as a trend, not a guess.',
  },
  {
    icon: Flame,
    bg: '#CFE1EC',
    ink: '#3E7396',
    title: 'Stay consistent',
    body: 'Streaks and session history keep rehab from quietly lapsing between check-ins.',
  },
];

export default function LandingPage({ onGetStarted, onLogin, onDemo }) {
  return (
    <div
      className="min-h-screen bg-[#F6F1E7] text-[#221E18] flex flex-col items-center"
      style={{ fontFamily: "'Inter', ui-sans-serif, sans-serif" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        .font-display { font-family: 'Outfit', ui-sans-serif, sans-serif; }
      `}</style>

      <div className="w-full max-w-5xl px-6 pt-8 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="bg-[#E8E2A8] text-[#17140F] p-1.5 rounded-lg">
            <Dumbbell size={18} />
          </div>
          <span className="font-display text-lg font-semibold tracking-tight">ArmUp</span>
        </div>
        <button
          onClick={onLogin}
          className="font-display text-sm font-medium px-4 py-2 rounded-xl hover:bg-white/70 transition-colors"
        >
          Log in
        </button>
      </div>

      <main className="w-full max-w-3xl px-6 pt-20 pb-16 text-center">
        <h1 className="font-display text-4xl md:text-5xl font-semibold tracking-tight leading-tight">
          Webcam physiotherapy,<br />gamified.
        </h1>
        <p className="text-[#6B6450] mt-5 max-w-lg mx-auto">
          ArmUp turns prescribed arm and neck exercises into a tracked, scored
          session, using nothing but your webcam.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-9">
          <button
            onClick={onGetStarted}
            className="font-display inline-flex items-center gap-2 bg-[#17140F] text-[#E9E4D6] px-6 py-3 rounded-2xl font-medium hover:bg-[#221E18] transition-colors"
          >
            Create your profile
            <ArrowRight size={16} />
          </button>
          <button
            onClick={onDemo}
            className="font-display inline-flex items-center gap-2 bg-white border border-[#E7E2D4] text-[#221E18] px-6 py-3 rounded-2xl font-medium hover:bg-[#FBF9F3] transition-colors"
          >
            Continue as test patient
          </button>
        </div>
      </main>

      <div className="w-full max-w-5xl px-6 pb-20 grid grid-cols-1 md:grid-cols-3 gap-5">
        {FEATURES.map(({ icon: Icon, bg, ink, title, body }) => (
          <div key={title} className="rounded-3xl p-6" style={{ backgroundColor: bg }}>
            <div className="w-9 h-9 rounded-xl bg-white/60 flex items-center justify-center mb-4" style={{ color: ink }}>
              <Icon size={18} />
            </div>
            <h3 className="font-display font-semibold mb-1.5" style={{ color: ink }}>{title}</h3>
            <p className="text-sm leading-relaxed" style={{ color: ink, opacity: 0.85 }}>{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}