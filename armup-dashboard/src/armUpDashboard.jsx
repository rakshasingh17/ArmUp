import React, { useState, useEffect } from 'react';
import { 
  Activity, Award, Calendar, CheckCircle2, ChevronRight, 
  Dumbbell, Play, ShieldAlert, Flame, TrendingUp, User, Zap 
} from 'lucide-react';

const API_BASE = "http://localhost:8000";

export default function ArmUpDashboard() {
  const [userId, setUserId] = useState(1);
  const [user, setUser] = useState(null);
  const [recommended, setRecommended] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    fetchDashboardData(userId);
  }, [userId]);

  const fetchDashboardData = async (id) => {
    setLoading(true);
    try {
      const [uRes, rRes, sRes] = await Promise.all([
        fetch(`${API_BASE}/users/${id}`).then(r => r.ok ? r.json() : null),
        fetch(`${API_BASE}/users/${id}/exercises`).then(r => r.ok ? r.json() : []),
        fetch(`${API_BASE}/users/${id}/sessions`).then(r => r.ok ? r.json() : [])
      ]);
      setUser(uRes);
      setRecommended(rRes);
      setSessions(sRes);
    } catch (err) {
      console.error("Backend offline or unreachable:", err);
    } finally {
      setLoading(false);
    }
  };

  const startExercise = async (exerciseKey) => {
    try {
      await fetch(`${API_BASE}/start-session?user_id=${userId}&exercise_key=${exerciseKey}`, {
        method: "POST",
      });
    } catch (err) {
      console.error("Could not start session:", err);
    }
  };

  const totalReps = sessions.reduce((acc, s) => acc + s.reps, 0);
  const totalScore = sessions.reduce((acc, s) => acc + s.score, 0);
  const avgAccuracy = sessions.length 
    ? Math.round(sessions.reduce((acc, s) => acc + s.accuracy, 0) / sessions.length) 
    : 0;
  const maxStreak = sessions.length ? Math.max(...sessions.map(s => s.max_streak)) : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#130B24] text-white flex items-center justify-center font-sans">
        <div className="flex items-center gap-3 text-cyan-400">
          <Activity className="animate-spin" size={28} />
          <span className="text-xl font-semibold">Loading ArmUp Clinical Dashboard...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#130B24] text-slate-100 font-sans p-6 md:p-10">
      {/* Top Header Navigation */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8 pb-6 border-b border-purple-900/50">
        <div>
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-r from-purple-600 to-pink-500 p-2.5 rounded-xl text-white shadow-lg shadow-purple-500/20">
              <Dumbbell size={26} />
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-white to-slate-300 bg-clip-text text-transparent">
                ArmUp Clinical Hub
              </h1>
              <p className="text-xs text-slate-400">Therapist Monitoring & Patient Gamification Dashboard</p>
            </div>
          </div>
        </div>

        {/* Patient Switcher */}
        <div className="flex items-center gap-3 bg-[#1B1035] border border-purple-800/40 p-2 rounded-xl">
          <User className="text-purple-400 ml-2" size={18} />
          <span className="text-xs font-medium text-slate-400">Patient ID:</span>
          <input 
            type="number" 
            value={userId}
            onChange={(e) => setUserId(Number(e.target.value) || 1)}
            className="w-16 bg-[#261748] border border-purple-700/50 rounded-lg px-2 py-1 text-sm text-cyan-400 text-center font-mono focus:outline-none focus:ring-2 focus:ring-cyan-400"
          />
          <div className="text-sm font-semibold pr-2 border-l border-purple-800/60 pl-3 text-purple-200">
            {user ? user.name : "Unknown Patient"}
          </div>
        </div>
      </header>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        
        {/* Left Column: Patient Overview & Prescription */}
        <div className="lg:col-span-1 space-y-6">
          {/* Patient Card */}
          <div className="bg-[#1B1035] border border-purple-800/30 rounded-2xl p-5 shadow-xl">
            <h2 className="text-xs font-bold uppercase tracking-wider text-purple-400 mb-4">Patient Profile</h2>
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-cyan-500 to-purple-600 flex items-center justify-center text-lg font-bold text-white shadow-md">
                {user?.name ? user.name.slice(0, 2).toUpperCase() : 'PT'}
              </div>
              <div>
                <h3 className="font-bold text-lg text-white">{user?.name}</h3>
                <p className="text-xs text-slate-400">ID #{user?.id}</p>
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-medium text-slate-400">Diagnosed Tagged Ailments:</span>
              <div className="flex flex-wrap gap-2 pt-1">
                {user?.ailment_tags?.length > 0 ? (
                  user.ailment_tags.map((tag, idx) => (
                    <span key={idx} className="bg-purple-950/80 border border-purple-700/50 text-purple-300 text-xs px-2.5 py-1 rounded-full font-medium">
                      {tag.replace('_', ' ')}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-500 italic">No tags assigned</span>
                )}
              </div>
            </div>
          </div>

          {/* Recommended Exercises Card */}
          <div className="bg-[#1B1035] border border-purple-800/30 rounded-2xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-cyan-400">Prescribed Plan</h2>
              <span className="text-xs bg-cyan-950 text-cyan-300 border border-cyan-800/50 px-2 py-0.5 rounded-full font-mono">
                {recommended.length} Target(s)
              </span>
            </div>

            <div className="space-y-3">
              {recommended.length > 0 ? (
                recommended.map((item, idx) => (
                  <div key={idx} className="group bg-[#241544] hover:bg-[#2c1a52] transition-colors border border-purple-800/40 rounded-xl p-3 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-cyan-400">#{item.priority}</span>
                        <h4 className="text-sm font-semibold text-slate-100">{item.name}</h4>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Start Tolerance: <span className="font-mono text-slate-300">{item.starting_tolerance}°</span>
                      </p>
                    </div>
                    <button
                      onClick={() => startExercise(item.key)}
                      className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500 hover:text-black transition-all cursor-pointer"
                    >
                      <Play size={16} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-xs text-slate-500 italic">No prescribed exercise mapping found.</p>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Key Metrics, Charts & Activity Log */}
        <div className="lg:col-span-3 space-y-6">
          
          {/* Key Metrics Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard 
              label="Total Repetitions" 
              value={totalReps} 
              icon={<Dumbbell className="text-pink-400" size={20} />} 
              sub="Completed in session" 
            />
            <MetricCard 
              label="Avg Form Accuracy" 
              value={`${avgAccuracy}%`} 
              icon={<CheckCircle2 className="text-emerald-400" size={20} />} 
              sub="Range-of-Motion accuracy" 
            />
            <MetricCard 
              label="Max Streak" 
              value={maxStreak} 
              icon={<Flame className="text-amber-400" size={20} />} 
              sub="Consecutive clean reps" 
            />
            <MetricCard 
              label="Total Experience Score" 
              value={totalScore} 
              icon={<Award className="text-cyan-400" size={20} />} 
              sub="Gamified XP points" 
            />
          </div>

          {/* Session History & Progression */}
          <div className="bg-[#1B1035] border border-purple-800/30 rounded-2xl p-6 shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-lg font-bold text-white">Rehabilitation Session Log</h3>
                <p className="text-xs text-slate-400">Historical performance data logged directly from vision layer</p>
              </div>
            </div>

            {sessions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-purple-900/60 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                      <th className="pb-3">Timestamp</th>
                      <th className="pb-3">Exercise</th>
                      <th className="pb-3">Reps</th>
                      <th className="pb-3">Accuracy</th>
                      <th className="pb-3">Streak</th>
                      <th className="pb-3">Level</th>
                      <th className="pb-3 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-purple-900/30 text-sm">
                    {sessions.map((s) => (
                      <tr key={s.id} className="hover:bg-[#251647]/50 transition-colors">
                        <td className="py-3 font-mono text-xs text-slate-400">
                          {new Date(s.timestamp).toLocaleDateString()} {new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="py-3 font-medium text-purple-200">
                          <span className="capitalize">{s.exercise_key.replace('_', ' ')}</span>
                        </td>
                        <td className="py-3 font-semibold text-white">{s.reps}</td>
                        <td className="py-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium font-mono ${
                            s.accuracy >= 80 ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/50' : 'bg-amber-950 text-amber-300 border border-amber-800/50'
                          }`}>
                            {Math.round(s.accuracy)}%
                          </span>
                        </td>
                        <td className="py-3 text-slate-300 font-mono">{s.max_streak}</td>
                        <td className="py-3 text-slate-300 font-mono">Lvl {s.level}</td>
                        <td className="py-3 text-right font-bold text-cyan-400 font-mono">+{s.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-12 border border-dashed border-purple-800/50 rounded-xl">
                <ShieldAlert className="mx-auto text-purple-400 mb-2" size={32} />
                <p className="text-sm font-medium text-slate-300">No session history found for this patient.</p>
                <p className="text-xs text-slate-500 mt-1">Run <code className="text-cyan-400 bg-black/40 px-1.5 py-0.5 rounded">armup_app.py</code> with user ID {userId} to log real-time workouts.</p>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon, sub }) {
  return (
    <div className="bg-[#1B1035] border border-purple-800/30 rounded-2xl p-4 shadow-xl">
      <div className="flex justify-between items-start mb-2">
        <span className="text-xs font-semibold text-slate-400">{label}</span>
        <div className="p-2 rounded-xl bg-purple-950/80 border border-purple-800/40">
          {icon}
        </div>
      </div>
      <div className="text-2xl font-black text-white font-mono tracking-tight mb-1">
        {value}
      </div>
      <p className="text-[10px] text-slate-500">{sub}</p>
    </div>
  );
}