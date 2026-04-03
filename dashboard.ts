// PATH: dashboard.ts
// Terminal dashboard mirroring web dashboard categories:
//   Panel 1: Signal + Throughput charts  (= web Telemetry tab)
//   Panel 2: Health gauges + PID         (= web Telemetry tab sidebar)
//   Panel 3: Verbatim log deduped        (= web Verbatim Logs tab)
//   Panel 4: Forensic events structured  (= web Evidence tab — real data)
//   Panel 5: Commands table              (= web Evidence tab commands)
//   Panel 6: Full telemetry scrollable   (all 18 data points)
//   Nuclear recovery button: press N     (= web Nuclear Recovery button)
//
// All forensic data from /api/forensics — same source as web Evidence tab.
// Deduplication: consecutive identical log lines collapsed with ×count.
// Scrollable: telemetry table has keys:true, interactive:true, focus with Tab.

import blessed    from 'blessed';
import contrib    from 'blessed-contrib';
import fs         from 'fs';
import http       from 'http';

export interface TelemetrySnapshot {
  signal:             number;
  traffic:            { rx: number; tx: number };
  connectivity:       boolean;
  bkwInterface:       string;
  health:             number;
  healthPing:         number;
  healthDns:          number;
  healthRoute:        number;
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
export type OnScreenFn  = (screen: any) => void;

// ── Fetch /api/forensics — same data web Evidence tab shows ──────────────────
let forensicsCache: any = null;
function fetchForensics(): void {
  const req = http.request(
    { hostname: 'localhost', port: 3000, path: '/api/forensics', method: 'GET' },
    res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { forensicsCache = JSON.parse(body); } catch { /* ignore */ }
      });
    }
  );
  req.on('error', () => { /* server not ready yet */ });
  req.end();
}

// ── Nuclear recovery ──────────────────────────────────────────────────────────
function triggerNuclearRecovery(onStatus: (msg: string) => void): void {
  onStatus('NUCLEAR RECOVERY INITIATED...');
  const req = http.request(
    { hostname: 'localhost', port: 3000, path: '/api/fix', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
    res => {
      res.on('data', () => {});
      res.on('end', () => onStatus(`RECOVERY: HTTP ${res.statusCode} — monitor will restart`));
    }
  );
  req.on('error', e => onStatus(`RECOVERY ERROR: ${e.message}`));
  req.write('{}');
  req.end();
}

function hasCtx(w: any): boolean { return !!(w && w.ctx); }

export function startDashboard(getTelemetry: TelemetryFn, onScreen?: OnScreenFn): void {

  const screen = blessed.screen({
    smartCSR: true,
    title: 'BCM4331 Forensic Controller v39.8',
    fullUnicode: true,
  });
  if (onScreen) onScreen(screen);

  // Handle both blessed keypress (raw mode) AND process signal (tsx intercept).
  // tsx intercepts SIGINT before blessed sees C-c as a keypress — need both.
  const cleanExit = () => { try { screen.destroy(); } catch { /* ignore */ } process.exit(0); };
  screen.key(['q', 'C-c'], cleanExit);
  process.on('SIGINT',  cleanExit);
  process.on('SIGTERM', cleanExit);

  // Tab cycles focus between scrollable widgets
  let focusIdx = 0;
  const focusable: any[] = [];
  screen.key(['tab'], () => {
    focusIdx = (focusIdx + 1) % focusable.length;
    focusable[focusIdx].focus();
    screen.render();
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // ── Row 0-3: Charts (= web Telemetry tab) ────────────────────────────────
  const signalLine = grid.set(0, 0, 4, 6, contrib.line, {
    label: ' Signal Strength (dBm) ', showLegend: true,
    legend: { width: 10 }, xLabelPadding: 3, xPadding: 5,
  });

  const trafficLine = grid.set(0, 6, 4, 6, contrib.line, {
    label: ' Throughput KB/s ', showLegend: true, legend: { width: 10 },
  });

  // ── Row 4-5: Health + PID + Nuclear ──────────────────────────────────────
  const healthGauges = grid.set(4, 0, 2, 3, contrib.gaugeList, {
    label: ' Health Components ',
    gauges: [
      { stack: [{ percent: 2, stroke: 'green'  }], label: 'Ping  40pt' },
      { stack: [{ percent: 2, stroke: 'cyan'   }], label: 'DNS   30pt' },
      { stack: [{ percent: 2, stroke: 'yellow' }], label: 'Route 30pt' },
      { stack: [{ percent: 2, stroke: 'white'  }], label: 'Overall   ' },
    ],
    gaugeSpacing: 0, gaugeHeight: 1,
  });

  const healthGauge = grid.set(4, 3, 2, 2, contrib.gauge, {
    label: ' Health ', stroke: 'green', fill: 'white',
  });

  const pidBar = grid.set(4, 5, 2, 3, contrib.bar, {
    label: ' PID Params ', barWidth: 4, barSpacing: 3, xOffset: 0, maxHeight: 1000,
  });

  // Nuclear recovery button — red box, press N or click
  const nuclearBtn = grid.set(4, 8, 1, 4, blessed.box, {
    content: '{center}{bold} ⚡ NUCLEAR RECOVERY (N) {/bold}{/center}',
    tags: true, mouse: true,
    style: { fg: 'white', bg: 'red', bold: true, hover: { bg: 'brightred' },
             border: { fg: 'yellow' } },
    border: { type: 'line' },
  });

  const statusBox = grid.set(5, 8, 1, 4, blessed.box, {
    content: 'Ready — press N for nuclear recovery',
    tags: true,
    style: { fg: 'cyan', border: { fg: 'cyan' } },
    border: { type: 'line' },
    label: ' Status ',
  });

  // ── Row 6-8 left: Verbatim log deduped (= web Verbatim Logs tab) ─────────
  const logBox = grid.set(6, 0, 3, 5, contrib.log, {
    label: ' Verbatim Log (deduped) ',
    fg: 'green', selectedFg: 'green', bufferLength: 80,
  });

  // ── Row 6-8 right: Forensic events (= web Evidence tab) ──────────────────
  // Scrollable — Tab to focus, arrows to scroll
  const forensicLog = grid.set(6, 5, 3, 7, contrib.log, {
    label: ' Forensic Events [Tab to focus, ↑↓ to scroll] ',
    fg: 'cyan', selectedFg: 'white', bufferLength: 200,
    keys: true, vi: true, mouse: true, scrollable: true,
    scrollbar: { bg: 'cyan' },
  });
  focusable.push(forensicLog);

  // ── Row 9-10: Commands + Telemetry scrollable ─────────────────────────────
  const cmdTable = grid.set(9, 0, 2, 4, contrib.table, {
    label: ' Recovery Commands ',
    keys: false, interactive: false,
    columnSpacing: 1, columnWidth: [2, 8, 28],
  });

  // Scrollable telemetry — all 18 rows, Tab to focus
  const telTable = grid.set(9, 4, 3, 8, contrib.table, {
    label: ' All Telemetry [Tab to focus, ↑↓ to scroll] ',
    keys: true, vi: true, mouse: true, interactive: true,
    columnSpacing: 2, columnWidth: [16, 22],
    style: { selected: { bg: 'blue' } },
  });
  focusable.push(telTable);

  // ── Row 11: Milestones ────────────────────────────────────────────────────
  const milestoneTable = grid.set(11, 0, 1, 12, contrib.table, {
    label: ' Forensic Milestones ',
    keys: false, interactive: false,
    columnSpacing: 2, columnWidth: [10, 18, 60],
  });

  // Nuclear handlers
  const doNuclear = () => {
    triggerNuclearRecovery(msg => {
      statusBox.setContent(msg);
      screen.render();
    });
  };
  screen.key(['n', 'N'], doNuclear);
  nuclearBtn.on('click', doNuclear);

  // History buffers
  const MAX_HIST    = 30;
  const sigHist:    number[] = Array(MAX_HIST).fill(0);
  const rxHist:     number[] = Array(MAX_HIST).fill(0);
  const txHist:     number[] = Array(MAX_HIST).fill(0);
  const timeLabels: string[] = Array.from({ length: MAX_HIST }, (_, i) => `-${MAX_HIST - i}s`);

  // Log offset: start at EOF so only new lines appear
  let logOffset = 0;
  const t0 = getTelemetry();
  if (t0.logFile && fs.existsSync(t0.logFile)) {
    try { logOffset = fs.statSync(t0.logFile).size; } catch { logOffset = 0; }
  }

  // Track which forensic events have been logged to avoid re-printing
  let lastForensicEventCount = 0;

  // Initial render — ctx assigned in 'attach' event which fires here
  screen.render();

  // Start fetching forensics
  fetchForensics();
  setInterval(fetchForensics, 5000);

  const update = () => {
    const t   = getTelemetry();
    const rx  = t.traffic.rx / 1024;
    const tx  = t.traffic.tx / 1024;
    const now = new Date().toLocaleTimeString();

    sigHist.push(t.signal); sigHist.shift();
    rxHist.push(rx);        rxHist.shift();
    txHist.push(tx);        txHist.shift();
    timeLabels.push(now);   timeLabels.shift();

    const sigColor = t.signal >= -60 ? 'green' : t.signal >= -75 ? 'yellow' : 'red';
    signalLine.setData([{ title: 'dBm', x: timeLabels, y: sigHist, style: { line: sigColor } }]);
    trafficLine.setData([
      { title: 'RX', x: timeLabels, y: rxHist, style: { line: 'green'  } },
      { title: 'TX', x: timeLabels, y: txHist, style: { line: 'yellow' } },
    ]);

    // Health gauges — minimum 2% so bar always visible when offline
    if (hasCtx(healthGauges)) {
      healthGauges.setGauges([
        { stack: [{ percent: t.healthPing  >= 40 ? 100 : 2, stroke: t.healthPing  >= 40 ? 'green'  : 'red' }], label: 'Ping  40pt' },
        { stack: [{ percent: t.healthDns   >= 30 ? 100 : 2, stroke: t.healthDns   >= 30 ? 'cyan'   : 'red' }], label: 'DNS   30pt' },
        { stack: [{ percent: t.healthRoute >= 30 ? 100 : 2, stroke: t.healthRoute >= 30 ? 'yellow' : 'red' }], label: 'Route 30pt' },
        { stack: [{ percent: Math.max(2, t.health), stroke: t.health >= 80 ? 'green' : t.health >= 40 ? 'yellow' : 'red' }], label: 'Overall   ' },
      ]);
    }

    if (hasCtx(healthGauge)) healthGauge.setPercent(Math.max(1, t.health));

    if (hasCtx(pidBar)) {
      pidBar.setData({ titles: ['Kp', 'Ki', 'Kd'], data: [t.pidKp, t.pidKi, t.pidKd] });
    }

    // Nuclear button state
    if (t.isFixing) {
      nuclearBtn.style.bg = 'yellow';
      nuclearBtn.setContent('{center}{bold} ⚡ RECOVERY IN PROGRESS {/bold}{/center}');
    } else {
      nuclearBtn.style.bg = 'red';
      nuclearBtn.setContent('{center}{bold} ⚡ NUCLEAR RECOVERY (N) {/bold}{/center}');
    }

    // Verbatim log — new bytes from file, deduplication handled server-side
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
          buf.toString('utf8')
            .split('\n').filter(l => l.trim())
            .forEach(l => logBox.log(l.replace(/\x1b\[[0-9;]*m/g, '')));
        }
      } catch { /* unreadable */ }
    }

    // Forensic events panel — from /api/forensics (same source as web Evidence tab)
    if (forensicsCache) {
      const f = forensicsCache;
      // Count total events to detect new ones
      const allEvents = [
        ...(f.recoveryEvents  || []),
        ...(f.moduleEvents    || []),
        ...(f.rfkillEvents    || []),
        ...(f.nmcliEvents     || []),
        ...(f.healthEvents    || []),
        ...(f.pidSignals      || []),
        ...(f.mutexEvents     || []),
        ...(f.binaryChecks    || []),
      ];
      if (allEvents.length !== lastForensicEventCount) {
        lastForensicEventCount = allEvents.length;
        // Rebuild forensic log display
        const lines: string[] = [];
        if ((f.recoveryEvents || []).length) {
          lines.push('── RECOVERY ──────────────────');
          f.recoveryEvents.slice(-5).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event} ${e.detail}`));
        }
        if ((f.moduleEvents || []).length) {
          lines.push('── KERNEL MODULES ────────────');
          f.moduleEvents.slice(-8).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event.padEnd(7)} ${e.detail}`));
        }
        if ((f.rfkillEvents || []).length) {
          lines.push('── RFKILL ────────────────────');
          f.rfkillEvents.slice(-5).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event} ${e.detail}`));
        }
        if ((f.nmcliEvents || []).length) {
          lines.push('── NMCLI ─────────────────────');
          f.nmcliEvents.slice(-6).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event} ${e.detail}`));
        }
        if ((f.healthEvents || []).length) {
          lines.push('── HEALTH DEGRADATION ────────');
          f.healthEvents.slice(-4).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event} — ${e.detail.slice(0, 40)}`));
        }
        if ((f.pidSignals || []).length) {
          lines.push('── PID CONTROLLER ────────────');
          f.pidSignals.slice(-4).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event} ${e.detail}`));
        }
        if ((f.mutexEvents || []).length) {
          lines.push('── MUTEX ─────────────────────');
          f.mutexEvents.slice(-4).forEach((e: any) =>
            lines.push(`${e.ts} ${e.event} ${e.detail}`));
        }
        if ((f.binaryChecks || []).length) {
          lines.push('── MISSING BINARIES ──────────');
          f.binaryChecks.forEach((e: any) =>
            lines.push(`${e.ts} ${e.detail} not found`));
        }
        // Re-populate the log widget
        (forensicLog as any).logLines = [];
        lines.forEach(l => forensicLog.log(l));
      }

      // Commands table
      if ((f.commands || []).length) {
        cmdTable.setData({
          headers: ['RC', 'Time', 'Command'],
          data: f.commands.map((c: any) => [
            c.rc === '0' ? '✓' : '✗',
            c.ts,
            c.cmd.slice(0, 28),
          ]),
        });
      } else {
        cmdTable.setData({ headers: ['RC', 'Time', 'Command'], data: [['—', '—', 'No commands yet']] });
      }

      // Milestones
      if ((f.milestones || []).length) {
        milestoneTable.setData({
          headers: ['Time', 'Milestone', 'Details'],
          data: f.milestones.map((m: any) => [m.ts, m.name.slice(0, 18), m.details.slice(0, 60)]),
        });
      } else {
        milestoneTable.setData({ headers: ['Time', 'Milestone', 'Details'], data: [['—', '—', 'No milestones']] });
      }
    }

    // Full telemetry — all 18 data points, scrollable
    telTable.setData({
      headers: ['Metric', 'Value'],
      data: [
        ['Signal',     t.signal + ' dBm'],
        ['RX',         rx.toFixed(2) + ' KB/s'],
        ['TX',         tx.toFixed(2) + ' KB/s'],
        ['Online',     t.connectivity ? '● ONLINE' : '○ OFFLINE'],
        ['Interface',  t.bkwInterface],
        ['Health',     t.health + '/100'],
        ['Ping',       t.healthPing  + '/40'],
        ['DNS',        t.healthDns   + '/30'],
        ['Route',      t.healthRoute + '/30'],
        ['PID Kp',     String(t.pidKp)],
        ['PID Ki',     String(t.pidKi)],
        ['PID Kd',     String(t.pidKd)],
        ['PID out',    String(t.pidSignal)],
        ['I_error',    String(t.pidIError)],
        ['prev_err',   String(t.pidPrevError)],
        ['Fixing',     t.isFixing ? 'YES ⚡' : 'no'],
        ['Git',        t.gitUpdateAvailable ? `${t.localSha}→${t.remoteSha}` : 'current'],
        ['Tick',       t.timestamp.slice(11, 19)],
      ],
    });

    screen.render();
  };

  update();
  setInterval(update, 2000);
}
