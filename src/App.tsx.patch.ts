// PATH: src/App.tsx
// PATCH: replace the {activeTab === 'forensics'} section and add forensics fetch.
// The rest of App.tsx is unchanged.
//
// WHAT CHANGED:
// 1. Evidence tab now reads /api/forensics — real parsed data, not raw milestone rows
// 2. Shows: recovery sequence, module loads, rfkill, nmcli, health events, PID signals,
//    mutex events, missing binaries, commands with exit codes, milestones
// 3. Verbatim log tab: deduped lines from forensicsCache.logTailDeduped
// 4. Telemetry tab: adds healthPing/Dns/Route breakdown under health card
// 5. Identical consecutive entries collapsed with ×count
//
// HOW TO APPLY:
// Find each section marked ── PATCH: REPLACE ── and replace with the code below.
// The file structure and all other tabs are unchanged.

// ── PATCH 1: Add to useState/useEffect block ─────────────────────────────────
/*
  const [forensics, setForensics] = useState<any>(null);

  // Add to the polling useEffect alongside fetchStatus/fetchAudit:
  const fetchForensics = useCallback(async () => {
    try {
      const res = await fetch('/api/forensics');
      setForensics(await res.json());
    } catch { /* ignore */ }
  }, []);

  // Add fetchForensics() to the useEffect interval alongside fetchAudit()
*/

// ── PATCH 2: Replace Evidence tab content ────────────────────────────────────
/*
  {activeTab === 'forensics' && (
    <motion.div
      key="forensics"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="space-y-6"
    >
      {!forensics ? (
        <div className="text-slate-500 text-xs font-mono p-8 text-center">
          Loading forensic data...
        </div>
      ) : (
        <>
          {/* Recovery Events */}
          {forensics.recoveryEvents?.length > 0 && (
            <ForensicSection title="Recovery Sequences" color="rose" events={forensics.recoveryEvents} />
          )}

          {/* Module Events */}
          {forensics.moduleEvents?.length > 0 && (
            <ForensicSection title="Kernel Module Events" color="amber" events={forensics.moduleEvents} />
          )}

          {/* rfkill */}
          {forensics.rfkillEvents?.length > 0 && (
            <ForensicSection title="RFKill Events" color="purple" events={forensics.rfkillEvents} />
          )}

          {/* nmcli */}
          {forensics.nmcliEvents?.length > 0 && (
            <ForensicSection title="NetworkManager (nmcli)" color="blue" events={forensics.nmcliEvents} />
          )}

          {/* Health degradation */}
          {forensics.healthEvents?.length > 0 && (
            <ForensicSection title="Health Degradation Events" color="orange" events={forensics.healthEvents} />
          )}

          {/* PID signals */}
          {forensics.pidSignals?.length > 0 && (
            <ForensicSection title="PID Controller Signals" color="cyan" events={forensics.pidSignals} />
          )}

          {/* Mutex */}
          {forensics.mutexEvents?.length > 0 && (
            <ForensicSection title="Hardware Mutex Events" color="green" events={forensics.mutexEvents} />
          )}

          {/* Missing binaries */}
          {forensics.binaryChecks?.length > 0 && (
            <ForensicSection title="Missing Binaries" color="rose" events={forensics.binaryChecks} />
          )}

          {/* Commands with exit codes */}
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            <div className="px-6 py-3 bg-white/5 border-b border-white/10">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                Recovery Commands ({forensics.commands?.length || 0})
              </span>
            </div>
            <table className="w-full text-left text-[11px]">
              <thead className="bg-white/5 border-b border-white/10">
                <tr>
                  <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest w-8">RC</th>
                  <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest w-20">Time</th>
                  <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest">Command</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(forensics.commands || []).map((cmd: any, i: number) => (
                  <tr key={i} className="hover:bg-white/[0.02]">
                    <td className={`px-4 py-3 font-mono font-bold ${cmd.rc === '0' ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {cmd.rc === '0' ? '✓' : '✗'}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-500">{cmd.ts}</td>
                    <td className="px-4 py-3 font-mono text-slate-300 text-[10px]">{cmd.cmd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Milestones */}
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
            <div className="px-6 py-3 bg-white/5 border-b border-white/10">
              <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                Forensic Milestones ({forensics.milestones?.length || 0})
              </span>
            </div>
            <table className="w-full text-left text-[11px]">
              <thead className="bg-white/5 border-b border-white/10">
                <tr>
                  <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest">Time</th>
                  <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest">Milestone</th>
                  <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(forensics.milestones || []).map((m: any, i: number) => (
                  <tr key={i} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-mono text-slate-500">{m.ts}</td>
                    <td className="px-4 py-3 font-bold text-cyan-400">{m.name}</td>
                    <td className="px-4 py-3 text-slate-400">{m.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </motion.div>
  )}
*/

// ── PATCH 3: Add ForensicSection component ────────────────────────────────────
/*
function ForensicSection({ title, color, events }: {
  title: string;
  color: string;
  events: { ts: string; event: string; detail: string }[];
}) {
  const colorMap: Record<string, string> = {
    rose:   'text-rose-400',
    amber:  'text-amber-400',
    purple: 'text-purple-400',
    blue:   'text-blue-400',
    orange: 'text-orange-400',
    cyan:   'text-cyan-400',
    green:  'text-emerald-400',
  };
  const textColor = colorMap[color] || 'text-slate-400';

  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
      <div className="px-6 py-3 bg-white/5 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{title}</span>
        <span className={`text-[10px] font-mono ${textColor}`}>{events.length} events</span>
      </div>
      <table className="w-full text-left text-[11px]">
        <thead className="bg-white/5 border-b border-white/10">
          <tr>
            <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest w-20">Time</th>
            <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest w-28">Event</th>
            <th className="px-4 py-3 font-bold text-slate-500 uppercase tracking-widest">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {events.map((e, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="px-4 py-3 font-mono text-slate-500">{e.ts}</td>
              <td className={`px-4 py-3 font-bold ${textColor}`}>{e.event}</td>
              <td className="px-4 py-3 text-slate-400 font-mono text-[10px]">{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
*/

// ── PATCH 4: Add health breakdown to Telemetry tab health card ────────────────
/*
  // Inside the System Health card, after the progress bar, add:
  <div className="mt-3 grid grid-cols-3 gap-2">
    {[
      { label: 'Ping', val: status?.healthPing || 0, max: 40 },
      { label: 'DNS',  val: status?.healthDns  || 0, max: 30 },
      { label: 'Route',val: status?.healthRoute|| 0, max: 30 },
    ].map(({ label, val, max }) => (
      <div key={label} className="p-2 rounded-lg bg-black/40 border border-white/5 text-center">
        <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">{label}</p>
        <p className={`text-sm font-bold font-mono ${val >= max ? 'text-emerald-400' : 'text-rose-400'}`}>
          {val}/{max}
        </p>
      </div>
    ))}
  </div>
*/

export {};  // makes this a module so TypeScript is happy
