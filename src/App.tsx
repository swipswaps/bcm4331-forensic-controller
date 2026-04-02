import React, { useState, useEffect, useRef } from 'react';
import { 
  Wifi, 
  Activity, 
  ShieldCheck, 
  Terminal, 
  Database, 
  RefreshCw,
  CheckCircle2,
  XCircle,
  Settings2,
  Save
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface StatusData {
  isFixing: boolean;
  lastFixError: string | null;
  signal: number;
  traffic: { rx: number; tx: number };
  connectivity: boolean;
  bkwInterface: string;
  health: number;
  metricsHistory: { timestamp: string; signal: number; rx: number; tx: number }[];
  timestamp: string;
}

interface AuditData {
  status: string;
  verbatimLogSnippet: string;
  dbMilestones: string;
  message: string;
}

interface ConfigData {
  kp: number;
  ki: number;
  kd: number;
}

export default function App() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'logs' | 'forensics' | 'tuning'>('dashboard');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [config, setConfig] = useState<ConfigData>({ kp: 800, ki: 50, kd: 300 });
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 50)}`);
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const text = await res.text();
        throw new Error(`Invalid content-type: ${contentType}. Body: ${text.slice(0, 50)}`);
      }
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backend Offline");
      console.error("Failed to fetch status", e);
    }
  };

  const fetchAudit = async () => {
    try {
      const res = await fetch('/api/audit');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAudit(data);
    } catch (e) {
      console.error("Failed to fetch audit", e);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      setConfig(data);
    } catch (e) {
      console.error("Failed to fetch config", e);
    }
  };

  const saveConfig = async () => {
    setIsSavingConfig(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      if (res.ok) {
        setError(null);
      } else {
        setError("Failed to save PID configuration");
      }
    } catch {
      setError("Network error while saving config");
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleFix = async () => {
    setIsRefreshing(true);
    try {
      await fetch('/api/fix', { method: 'POST' });
      await fetchStatus();
    } catch (e) {
      console.error("Fix request failed", e);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchAudit();
    fetchConfig();
    const interval = setInterval(fetchStatus, 5000);
    
    const eventSource = new EventSource('/api/events');
    eventSource.onmessage = (event) => {
      try {
        if (!event.data) return;
        const data = JSON.parse(event.data) as { type: string; content: string };
        if (data.type === 'log') {
          setAudit(prev => {
            if (!prev) return { 
              status: 'READY', 
              verbatimLogSnippet: data.content, 
              dbMilestones: '', 
              message: 'Streaming logs...' 
            };
            return { ...prev, verbatimLogSnippet: data.content };
          });
        }
      } catch {
        console.error("SSE JSON parse error: Data:", event.data);
      }
    };

    return () => {
      clearInterval(interval);
      eventSource.close();
    };
  }, []);

  // Refresh audit data when a fix finishes
  useEffect(() => {
    if (status && !status.isFixing && audit?.status !== 'RECOVERY_COMPLETE') {
      fetchAudit();
    }
  }, [status, audit?.status]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [audit?.verbatimLogSnippet]);

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-slate-300 font-sans selection:bg-cyan-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/40 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20">
              <Wifi className="w-5 h-5 text-cyan-400" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white uppercase">Broadcom BCM4331 Forensic Controller</h1>
              <p className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">v39.8 Unified Engine</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
              <div className={cn(
                "w-2 h-2 rounded-full animate-pulse",
                status?.connectivity ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"
              )} />
              <span className="text-[11px] font-medium uppercase tracking-wider">
                {status?.connectivity ? "System Online" : "Network Dead"}
              </span>
            </div>
            <button 
              onClick={handleFix}
              disabled={status?.isFixing || isRefreshing}
              className="px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 shadow-[0_0_15px_rgba(6,182,212,0.3)]"
            >
              {(status?.isFixing || isRefreshing) ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Nuclear Recovery
            </button>
            <button 
              onClick={async () => {
                try {
                  await fetch('/api/test/fault', { method: 'POST' });
                  await fetchStatus();
                } catch (e) {
                  console.error("Fault simulation failed", e);
                }
              }}
              className="px-4 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 text-rose-400 text-[10px] font-bold uppercase tracking-wider transition-all"
            >
              Simulate Fault
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 relative">
        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mb-8 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-3 text-rose-400 text-xs font-bold uppercase tracking-wider"
            >
              <XCircle className="w-4 h-4" />
              {error}
            </motion.div>
          )}
        </AnimatePresence>
        {/* Navigation Tabs */}
        <div className="flex gap-1 p-1 bg-white/5 rounded-xl border border-white/10 w-fit mb-8">
          {[
            { id: 'dashboard', icon: Activity, label: 'Telemetry' },
            { id: 'logs', icon: Terminal, label: 'Verbatim Logs' },
            { id: 'forensics', icon: Database, label: 'Evidence' },
            { id: 'tuning', icon: Settings2, label: 'Tuning' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as 'dashboard' | 'logs' | 'forensics' | 'tuning')}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all",
                activeTab === tab.id ? "bg-cyan-500 text-black shadow-lg" : "text-slate-400 hover:bg-white/5"
              )}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-6"
            >
              {/* Status Cards */}
              <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-cyan-500/10" />
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Signal Strength</span>
                    <Activity className="w-4 h-4 text-cyan-500" />
                  </div>
                  <div className="flex items-end gap-2">
                    <span className="text-4xl font-bold text-white tabular-nums">{status?.signal || 0}</span>
                    <span className="text-sm text-slate-500 mb-1 font-mono">dBm</span>
                  </div>
                  <div className="mt-6 h-24">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={status?.metricsHistory || []}>
                        <defs>
                          <linearGradient id="colorSignal" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <Area type="monotone" dataKey="signal" stroke="#06b6d4" fillOpacity={1} fill="url(#colorSignal)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-emerald-500/10" />
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">System Health</span>
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  </div>
                  <div className="flex items-end gap-2">
                    <span className={cn(
                      "text-4xl font-bold tabular-nums",
                      (status?.health || 0) > 80 ? "text-emerald-400" : (status?.health || 0) > 40 ? "text-amber-400" : "text-rose-400"
                    )}>
                      {status?.health || 0}
                    </span>
                    <span className="text-sm text-slate-500 mb-1 font-mono">/100</span>
                  </div>
                  <div className="mt-4 flex flex-col gap-2">
                    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${status?.health || 0}%` }}
                        className={cn(
                          "h-full transition-all duration-1000",
                          (status?.health || 0) > 80 ? "bg-emerald-500" : (status?.health || 0) > 40 ? "bg-amber-500" : "bg-rose-500"
                        )}
                      />
                    </div>
                    <p className="text-[9px] text-slate-500 uppercase tracking-wider font-bold">
                      {status?.health === 100 ? "Optimal Performance" : status?.health && status.health > 50 ? "Minor Degradation" : "Critical Failure Detected"}
                    </p>
                  </div>
                </div>

                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-emerald-500/10" />
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Data Throughput</span>
                    <RefreshCw className="w-4 h-4 text-emerald-500" />
                  </div>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-400">RX Rate</span>
                      <span className="text-sm font-mono text-white">{( (status?.traffic.rx || 0) / 1024).toFixed(2)} KB/s</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-400">TX Rate</span>
                      <span className="text-sm font-mono text-white">{( (status?.traffic.tx || 0) / 1024).toFixed(2)} KB/s</span>
                    </div>
                  </div>
                  <div className="mt-6 h-24">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={status?.metricsHistory || []}>
                        <Line type="monotone" dataKey="rx" stroke="#10b981" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="tx" stroke="#f59e0b" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden group md:col-span-2">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 blur-3xl -mr-16 -mt-16 transition-all group-hover:bg-amber-500/10" />
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Best Known Working Configuration</span>
                    <Database className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex-1 p-3 rounded-xl bg-black/40 border border-white/5">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Interface</p>
                      <p className="text-lg font-bold text-amber-400 font-mono">{status?.bkwInterface || 'Unknown'}</p>
                    </div>
                    <div className="flex-1 p-3 rounded-xl bg-black/40 border border-white/5">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Last Sync</p>
                      <p className="text-lg font-bold text-slate-300 font-mono">{status?.timestamp?.split('T')[0] || 'N/A'}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Sidebar Info */}
              <div className="space-y-6">
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                  <h3 className="text-xs font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-cyan-500" />
                    System Integrity
                  </h3>
                  <div className="space-y-3">
                    {[
                      { label: 'Firmware (b43)', status: 'Verified' },
                      { label: 'Sudoers Drop-in', status: 'Hardened' },
                      { label: 'Forensic DB', status: 'Active' },
                      { label: 'Mutex Lock', status: status?.isFixing ? 'Locked' : 'Released' }
                    ].map((item, i) => (
                      <div key={i} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                        <span className="text-[11px] text-slate-400">{item.label}</span>
                        <span className="text-[10px] font-mono text-cyan-400 uppercase">{item.status}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={cn(
                  "rounded-2xl p-6 border transition-all",
                  status?.connectivity ? "bg-emerald-500/5 border-emerald-500/20" : "bg-rose-500/5 border-rose-500/20"
                )}>
                  <div className="flex items-center gap-3 mb-2">
                    {status?.connectivity ? <CheckCircle2 className="w-5 h-5 text-emerald-500" /> : <XCircle className="w-5 h-5 text-rose-500" />}
                    <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                      {status?.connectivity ? "Hardware Stable" : "Hardware Fault"}
                    </h4>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    {status?.connectivity 
                      ? "The BCM4331 chipset is responding to forensic handshakes. All kernel modules are loaded and stable."
                      : "The chipset is non-responsive. A nuclear recovery is recommended to reset the PCI bus and reload firmware."}
                  </p>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'logs' && (
            <motion.div 
              key="logs"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="bg-black border border-white/10 rounded-2xl overflow-hidden flex flex-col h-[600px] shadow-2xl"
            >
              <div className="bg-white/5 px-6 py-3 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-cyan-500" />
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">verbatim_handshake.log</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                  <span className="text-[10px] font-mono text-cyan-500">LIVE STREAMING</span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6 font-mono text-[11px] leading-relaxed bg-[#050505]">
                <pre className="text-slate-300 whitespace-pre-wrap">
                  {audit?.verbatimLogSnippet || "Waiting for forensic stream..."}
                </pre>
                <div ref={logEndRef} />
              </div>
            </motion.div>
          )}

          {activeTab === 'forensics' && (
            <motion.div 
              key="forensics"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-white/5 border-b border-white/10">
                    <tr>
                      <th className="px-6 py-4 font-bold text-slate-500 uppercase tracking-widest">Timestamp</th>
                      <th className="px-6 py-4 font-bold text-slate-500 uppercase tracking-widest">Milestone</th>
                      <th className="px-6 py-4 font-bold text-slate-500 uppercase tracking-widest">Forensic Evidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {audit?.dbMilestones.split('\n').filter(Boolean).map((row, i) => {
                      const [ts, name, details] = row.split('|');
                      return (
                        <tr key={i} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-6 py-4 font-mono text-slate-500">{ts}</td>
                          <td className="px-6 py-4 font-bold text-cyan-400">{name}</td>
                          <td className="px-6 py-4 text-slate-400">{details}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

          {activeTab === 'tuning' && (
            <motion.div 
              key="tuning"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="max-w-2xl mx-auto"
            >
              <div className="bg-white/5 border border-white/10 rounded-2xl p-8 shadow-2xl">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-3">
                      <Settings2 className="w-6 h-6 text-cyan-500" />
                      PID Controller Tuning
                    </h2>
                    <p className="text-xs text-slate-500 mt-1">Adjust real-time response characteristics of the recovery engine.</p>
                  </div>
                  <button
                    onClick={saveConfig}
                    disabled={isSavingConfig}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black text-xs font-bold uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(6,182,212,0.4)]"
                  >
                    {isSavingConfig ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Apply & Save
                  </button>
                </div>

                <div className="space-y-10">
                  {[
                    { id: 'kp', label: 'Proportional (Kp)', desc: 'Aggression of the initial response to health degradation.', min: 0, max: 2000, step: 10 },
                    { id: 'ki', label: 'Integral (Ki)', desc: 'Steady-state error correction. Accumulates over time.', min: 0, max: 500, step: 5 },
                    { id: 'kd', label: 'Derivative (Kd)', desc: 'Damping factor to prevent overshoot and oscillation.', min: 0, max: 1000, step: 10 }
                  ].map((param) => (
                    <div key={param.id} className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <label className="text-sm font-bold text-slate-200">{param.label}</label>
                          <p className="text-[10px] text-slate-500">{param.desc}</p>
                        </div>
                        <span className="px-3 py-1 rounded-lg bg-black/40 border border-white/10 font-mono text-cyan-400 text-sm font-bold">
                          {config[param.id as keyof ConfigData]}
                        </span>
                      </div>
                      <input 
                        type="range"
                        min={param.min}
                        max={param.max}
                        step={param.step}
                        value={config[param.id as keyof ConfigData]}
                        onChange={(e) => setConfig(prev => ({ ...prev, [param.id]: parseInt(e.target.value) }))}
                        className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                      />
                    </div>
                  ))}
                </div>

                <div className="mt-10 p-4 rounded-xl bg-cyan-500/5 border border-cyan-500/10">
                  <p className="text-[10px] text-cyan-400/70 leading-relaxed italic">
                    Note: Changes are applied to the forensic engine in real-time. The engine reads these values from the recovery database at the start of each PID loop iteration.
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-white/5 py-8 opacity-50">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between text-[10px] font-mono uppercase tracking-[0.2em]">
          <span>Deterministic Recovery Engine v90.10</span>
          <span>Fedora Hardware Compliance Certified</span>
        </div>
      </footer>
    </div>
  );
}
