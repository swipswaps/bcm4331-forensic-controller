// PATH: dashboard.ts
// Terminal dashboard — blessed-contrib (github.com/yaronn/blessed-contrib, 15.7k stars)
//
// Data sources confirmed from fix-wifi.sh source (475 lines, GitHub):
//   DB tables:  milestones(timestamp,name,details), commands(timestamp,command,exit_code), config
//   DB config keys: bkw_interface, health_score, pid_kp, pid_ki, pid_kd, pid_signal
//   Health:     ping=40pts, DNS=30pts, default_route=30pts
//   PID:        Kp*error + Ki*I_error + Kd*D_error, SCALE=1000, CLAMP=50000
//   Log format: [2026-04-02 18:15:11.109] emoji message
//
// Panel layout (12×12 grid):
//   Row  0-3  left:   Signal dBm history (line chart)
//   Row  0-3  right:  RX + TX KB/s history (line chart)
//   Row  4-5  left:   Health components gaugeList (ping/DNS/route/overall)
//   Row  4-5  mid:    PID state gaugeList (Kp/Ki/Kd signals, I_error)
//   Row  4-5  right:  Recovery commands table (last 5, exit codes)
//   Row  6-8  left:   Verbatim log (live tail from log file)
//   Row  6-8  right:  Full telemetry table (all data points)
//   Row  9-11 full:   Forensic milestones table (from DB)

import blessed  from 'blessed';
import contrib  from 'blessed-contrib';
import fs       from 'fs';
import { execSync } from 'child_process';

export interface TelemetrySnapshot {
  signal:             number;
  traffic:            { rx: number; tx: number };
  connectivity:       boolean;
  bkwInterface:       string;
  health:             number;
  healthPing:         number;   // 0 or 40
  healthDns:          number;   // 0 or 30
  healthRoute:        number;   // 0 or 30
  timestamp:          string;
  pidKp:              number;
  pidKi:              number;
  pidKd:              number;
  pidSignal:          number;
  pidIError:          number;
  pidPrevError:       number;
  isFixing:           boolean;
  gitUpdateAvailable: boolean;
  localSha:           string;
  remoteSha:          string;
  metricsHistory:     { timestamp: string; signal: number; rx: number; tx: number }[];
  logFile:            string;
  dbFile:             string;
}

export type TelemetryFn = () => TelemetrySnapshot;

// ── DB query helper — runs sqlite3, returns rows as string[][] ────────────────
function dbQuery(dbFile: string, sql: string): string[][] {
  if (!fs.existsSync(dbFile)) return [];
  try {
    const raw = execSync(`sqlite3 -separator "|||" "${dbFile}" "${sql}"`, { timeout: 2000, encoding: 'utf8' }).trim();
    if (!raw) return [];
    return raw.split('\n').map(r => r.split('|||'));
  } catch { return []; }
}

export function startDashboard(getTelemetry: TelemetryFn): void {

  const screen = blessed.screen({ smartCSR: true, title: 'BCM4331 Forensic Controller v39.8' });
  screen.key(['q', 'C-c'], () => process.exit(0));

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // ── Row 0-3: Signal line chart ────────────────────────────────────────────
  const signalLine = grid.set(0, 0, 4, 6, contrib.line, {
    label:      ' Signal Strength (dBm) — 30 tick history ',
    style:      { line: 'cyan', text: 'white', baseline: 'black' },
    xLabelPadding: 3,
    xPadding:   5,
    showLegend: true,
    legend:     { width: 12 },
  });

  // ── Row 0-3: RX/TX line chart ─────────────────────────────────────────────
  const trafficLine = grid.set(0, 6, 4, 6, contrib.line, {
    label:      ' Throughput (KB/s) — RX green / TX yellow ',
    style:      { line: 'green', text: 'white', baseline: 'black' },
    showLegend: true,
    legend:     { width: 12 },
  });

  // ── Row 4-5: Health component gaugeList ───────────────────────────────────
  // Shows ping / DNS / route / overall as individual bars — replaces lcd widget
  const healthGauges = grid.set(4, 0, 2, 4, contrib.gaugeList, {
    label: ' Health Components ',
    gauges: [
      { percent: [0], stroke: 'green',  label: 'Ping (40pt)  ' },
      { percent: [0], stroke: 'cyan',   label: 'DNS  (30pt)  ' },
      { percent: [0], stroke: 'yellow', label: 'Route(30pt)  ' },
      { percent: [0], stroke: 'white',  label: 'Overall      ' },
    ],
  });

  // ── Row 4-5: PID state gaugeList ──────────────────────────────────────────
  // Kp/Ki/Kd shown as fraction of 1000 (MAX_OUTPUT from fix-wifi.sh)
  const pidGauges = grid.set(4, 4, 2, 4, contrib.gaugeList, {
    label: ' PID Controller State ',
    gauges: [
      { percent: [0], stroke: 'cyan',    label: 'Kp signal    ' },
      { percent: [0], stroke: 'magenta', label: 'Ki (I_error) ' },
      { percent: [0], stroke: 'yellow',  label: 'Kd correction' },
      { percent: [0], stroke: 'green',   label: 'Net output   ' },
    ],
  });

  // ── Row 4-5: Recovery commands table ─────────────────────────────────────
  const cmdTable = grid.set(4, 8, 2, 4, contrib.table, {
    label:         ' Last 5 Commands ',
    keys:          false,
    fg:            'white',
    selectedFg:    'white',
    selectedBg:    'blue',
    interactive:   false,
    columnSpacing: 1,
    columnWidth:   [3, 26],
  });

  // ── Row 6-8: Verbatim log ─────────────────────────────────────────────────
  const logBox = grid.set(6, 0, 3, 6, contrib.log, {
    label:        ' Verbatim Log — live tail ',
    fg:           'green',
    selectedFg:   'green',
    bufferLength: 100,
  });

  // ── Row 6-8: Full telemetry table ─────────────────────────────────────────
  const telTable = grid.set(6, 6, 3, 6, contrib.table, {
    label:         ' All Telemetry ',
    keys:          false,
    fg:            'white',
    selectedFg:    'white',
    selectedBg:    'blue',
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [18, 22],
  });

  // ── Row 9-11: Forensic milestones table ───────────────────────────────────
  const milestoneTable = grid.set(9, 0, 3, 12, contrib.table, {
    label:         ' Forensic Milestones (DB) — latest 8 ',
    keys:          false,
    fg:            'cyan',
    selectedFg:    'white',
    selectedBg:    'blue',
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [22, 20, 54],
  });

  // ── History ring buffers — initialised with tick indices not empty strings ─
  // FIX: previous version used Array(30).fill('') which blessed-contrib rendered
  // as 'nullnull'. Use index strings so x-axis always has valid labels.
  const MAX_HIST = 30;
  const sigHistory: number[]  = Array(MAX_HIST).fill(0);
  const rxHistory:  number[]  = Array(MAX_HIST).fill(0);
  const txHistory:  number[]  = Array(MAX_HIST).fill(0);
  const timeLabels: string[]  = Array.from({ length: MAX_HIST }, (_, i) => `-${MAX_HIST - i}s`);

  // ── Log file tail — start at current EOF so we only show new lines ─────────
  // FIX: previous version started at offset 0, replaying entire 400KB log file.
  let logOffset = 0;
  const t0 = getTelemetry();
  if (t0.logFile && fs.existsSync(t0.logFile)) {
    try { logOffset = fs.statSync(t0.logFile).size; } catch { logOffset = 0; }
  }

  // ── Update function — called every 2s ─────────────────────────────────────
  const update = () => {
    const t = getTelemetry();
    const rx = t.traffic.rx / 1024;
    const tx = t.traffic.tx / 1024;
    const now = new Date().toLocaleTimeString();

    // Shift history ring buffers
    sigHistory.push(t.signal);  sigHistory.shift();
    rxHistory.push(rx);          rxHistory.shift();
    txHistory.push(tx);          txHistory.shift();
    timeLabels.push(now);        timeLabels.shift();

    // ── Signal chart ──────────────────────────────────────────────────────
    const sigColor = t.signal >= -60 ? 'green' : t.signal >= -75 ? 'yellow' : 'red';
    signalLine.setData([{
      title: 'dBm',
      x: timeLabels,
      y: sigHistory,
      style: { line: sigColor },
    }]);

    // ── Traffic chart ─────────────────────────────────────────────────────
    trafficLine.setData([
      { title: 'RX', x: timeLabels, y: rxHistory, style: { line: 'green'  } },
      { title: 'TX', x: timeLabels, y: txHistory, style: { line: 'yellow' } },
    ]);

    // ── Health gaugeList ──────────────────────────────────────────────────
    // Each gauge takes a percent 0-100. ping max=40, dns max=30, route max=30.
    // Normalise each component to 0-100 for display.
    (healthGauges as any).setGauge(0, [t.healthPing  >= 40 ? 100 : 0]);
    (healthGauges as any).setGauge(1, [t.healthDns   >= 30 ? 100 : 0]);
    (healthGauges as any).setGauge(2, [t.healthRoute >= 30 ? 100 : 0]);
    (healthGauges as any).setGauge(3, [t.health]);

    // ── PID gaugeList ─────────────────────────────────────────────────────
    // MAX_OUTPUT=1000 from fix-wifi.sh. Normalise pidSignal to 0-100.
    const pidNorm   = (v: number) => Math.min(100, Math.max(0, Math.abs(v) / 10));
    const iErrNorm  = Math.min(100, Math.abs(t.pidIError) / 500);
    (pidGauges as any).setGauge(0, [pidNorm(t.pidKp)]);
    (pidGauges as any).setGauge(1, [iErrNorm]);
    (pidGauges as any).setGauge(2, [pidNorm(t.pidKd)]);
    (pidGauges as any).setGauge(3, [pidNorm(t.pidSignal)]);

    // ── Commands table — last 5 from DB ───────────────────────────────────
    const cmds = dbQuery(t.dbFile,
      'SELECT exit_code, command FROM commands ORDER BY timestamp DESC LIMIT 5;');
    cmdTable.setData({
      headers: ['RC', 'Command'],
      data: cmds.length > 0
        ? cmds.map(r => [r[0] === '0' ? '✓' : '✗', (r[1] || '').slice(0, 26)])
        : [['—', 'No commands yet']],
    });

    // ── Verbatim log — new bytes only ─────────────────────────────────────
    if (t.logFile && fs.existsSync(t.logFile)) {
      try {
        const stat = fs.statSync(t.logFile);
        if (logOffset > stat.size) logOffset = 0;
        if (stat.size > logOffset) {
          const buf = Buffer.alloc(stat.size - logOffset);
          const fd  = fs.openSync(t.logFile, 'r');
          fs.readSync(fd, buf, 0, buf.length, logOffset);
          fs.closeSync(fd);
          logOffset = stat.size;
          // Strip ANSI codes so blessed doesn't double-interpret them
          buf.toString('utf8')
            .split('\n')
            .filter(l => l.trim())
            .forEach(l => logBox.log(l.replace(/\x1b\[[0-9;]*m/g, '')));
        }
      } catch { /* log unreadable — skip */ }
    }

    // ── Full telemetry table — all named data points ───────────────────────
    telTable.setData({
      headers: ['Metric', 'Value'],
      data: [
        ['Signal',       t.signal + ' dBm'],
        ['RX',           rx.toFixed(2) + ' KB/s'],
        ['TX',           tx.toFixed(2) + ' KB/s'],
        ['Connectivity', t.connectivity ? '● ONLINE'  : '○ OFFLINE'],
        ['Interface',    t.bkwInterface],
        ['Health',       t.health + '/100'],
        ['Ping',         t.healthPing  + '/40'],
        ['DNS',          t.healthDns   + '/30'],
        ['Route',        t.healthRoute + '/30'],
        ['PID Kp',       String(t.pidKp)],
        ['PID Ki',       String(t.pidKi)],
        ['PID Kd',       String(t.pidKd)],
        ['PID signal',   String(t.pidSignal)],
        ['I_error',      String(t.pidIError)],
        ['prev_error',   String(t.pidPrevError)],
        ['Fixing',       t.isFixing ? 'YES' : 'no'],
        ['Git update',   t.gitUpdateAvailable ? `${t.localSha}→${t.remoteSha}` : 'up to date'],
        ['Tick',         t.timestamp.slice(11, 19)],
      ],
    });

    // ── Milestones table — latest 8 from DB ──────────────────────────────
    const ms = dbQuery(t.dbFile,
      'SELECT timestamp, name, details FROM milestones ORDER BY timestamp DESC LIMIT 8;');
    milestoneTable.setData({
      headers: ['Timestamp', 'Milestone', 'Details'],
      data: ms.length > 0
        ? ms.map(r => [
            (r[0] || '').slice(0, 19),
            (r[1] || '').slice(0, 20),
            (r[2] || '').slice(0, 54),
          ])
        : [['—', '—', 'No milestones recorded yet']],
    });

    screen.render();
  };

  // Initial render, then every 2s
  update();
  setInterval(update, 2000);
}
