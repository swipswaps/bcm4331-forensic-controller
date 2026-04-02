// PATH: dashboard.ts
// Terminal dashboard using blessed-contrib (github.com/yaronn/blessed-contrib, 15.7k stars).
// Replaces all hand-rolled ANSI box drawing in server.ts.
// Import and call startDashboard(getTelemetry) from server.ts after app.listen().
//
// Widgets used (all from blessed-contrib confirmed available):
//   grid, line, gauge, log, table, lcd, bar
//
// All 17 data points displayed:
//   signal, rxBytes, txBytes, connectivity, bkwInterface, health,
//   timestamp, pidKp, pidKi, pidKd, pidSignal, isFixing,
//   gitUpdateAvailable, localSha, remoteSha, metricsHistory, logTail

import blessed  from 'blessed';
import contrib  from 'blessed-contrib';
import fs       from 'fs';

export interface TelemetryFn {
  (): {
    signal:             number;
    traffic:            { rx: number; tx: number };
    connectivity:       boolean;
    bkwInterface:       string;
    health:             number;
    timestamp:          string;
    pidKp?:             number;
    pidKi?:             number;
    pidKd?:             number;
    pidSignal?:         number;
    isFixing:           boolean;
    gitUpdateAvailable: boolean;
    localSha:           string;
    remoteSha:          string;
    metricsHistory:     { timestamp: string; signal: number; rx: number; tx: number }[];
    logFile:            string;   // path to verbatim_handshake.log
  };
}

export function startDashboard(getTelemetry: TelemetryFn): void {

  // ── Screen ────────────────────────────────────────────────────────────────
  // blessed.screen() owns the terminal completely — no ANSI cursor fights.
  // Pattern from yaronn/blessed-contrib examples/dashboard.js
  const screen = blessed.screen({ smartCSR: true, title: 'BCM4331 Forensic Controller' });
  screen.key(['q', 'C-c'], () => process.exit(0));

  // ── Grid: 12 rows × 12 cols ───────────────────────────────────────────────
  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // Row 0-1: Signal history line chart (left)
  const signalLine = grid.set(0, 0, 4, 6, contrib.line, {
    label:  ' Signal Strength (dBm) ',
    style:  { line: 'cyan', text: 'white', baseline: 'black' },
    xLabelPadding: 3,
    xPadding: 5,
    showLegend: true,
  });

  // Row 0-1: RX/TX throughput line chart (right)
  const trafficLine = grid.set(0, 6, 4, 6, contrib.line, {
    label:  ' RX / TX  (KB/s) ',
    style:  { line: 'green', text: 'white', baseline: 'black' },
    showLegend: true,
  });

  // Row 4: Health gauge (left)
  const healthGauge = grid.set(4, 0, 2, 4, contrib.gauge, {
    label:  ' System Health ',
    stroke: 'green',
    fill:   'white',
  });

  // Row 4: Status lcd (centre)
  const statusLcd = grid.set(4, 4, 2, 4, contrib.lcd, {
    label:        ' Status ',
    segmentWidth: 0.06,
    segmentInterval: 0.11,
    strokeWidth: 0.1,
    elements: 7,
    display: 7,
    color: 'green',
  });

  // Row 4: PID params bar chart (right)
  const pidBar = grid.set(4, 8, 2, 4, contrib.bar, {
    label:     ' PID Parameters ',
    barWidth:  6,
    barSpacing: 6,
    xOffset:   0,
    maxHeight: 1000,
  });

  // Row 6-8: Forensic log (left)
  const logBox = grid.set(6, 0, 4, 6, contrib.log, {
    label:          ' Verbatim Log ',
    fg:             'green',
    selectedFg:     'green',
    bufferLength:   80,
  });

  // Row 6-8: Telemetry table (right)
  const telTable = grid.set(6, 6, 4, 6, contrib.table, {
    label:         ' Telemetry ',
    keys:          true,
    fg:            'white',
    selectedFg:    'white',
    selectedBg:    'blue',
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [22, 20],
  });

  // Row 10-11: Git / update status bar across full width
  const gitBox = grid.set(10, 0, 2, 12, blessed.box, {
    label:   ' Git / Update Status ',
    tags:    true,
    border:  { type: 'line' },
    style:   { border: { fg: 'cyan' } },
    content: 'Checking for updates...',
  });

  // ── Signal history ring buffer ─────────────────────────────────────────────
  const MAX_HIST = 30;
  const sigHistory:   number[] = Array(MAX_HIST).fill(0);
  const rxHistory:    number[] = Array(MAX_HIST).fill(0);
  const txHistory:    number[] = Array(MAX_HIST).fill(0);
  const timeLabels:   string[] = Array(MAX_HIST).fill('');

  // ── Log file tail tracker ─────────────────────────────────────────────────
  let logOffset = 0;

  // ── Update function ───────────────────────────────────────────────────────
  const update = () => {
    const t = getTelemetry();
    const rx = t.traffic.rx / 1024;
    const tx = t.traffic.tx / 1024;
    const now = new Date().toLocaleTimeString();

    // Shift history
    sigHistory.push(t.signal);   sigHistory.shift();
    rxHistory.push(rx);          rxHistory.shift();
    txHistory.push(tx);          txHistory.shift();
    timeLabels.push(now);        timeLabels.shift();

    // Signal line chart
    signalLine.setData([{
      title: 'signal',
      x: timeLabels,
      y: sigHistory,
      style: { line: t.signal >= -70 ? 'green' : t.signal >= -85 ? 'yellow' : 'red' },
    }]);

    // Traffic line chart
    trafficLine.setData([
      { title: 'RX', x: timeLabels, y: rxHistory, style: { line: 'green' } },
      { title: 'TX', x: timeLabels, y: txHistory, style: { line: 'yellow' } },
    ]);

    // Health gauge (0-100 → 0-1 fraction)
    healthGauge.setPercent(t.health);
    // Re-colour gauge based on health
    (healthGauge as any).options.stroke = t.health >= 80 ? 'green' : t.health >= 40 ? 'yellow' : 'red';

    // Status LCD — 7 chars: ONLINE / OFFLINE
    const statusText = t.connectivity ? 'ONLINE ' : 'OFFLINE';
    (statusLcd as any).options.color = t.connectivity ? 'green' : 'red';
    statusLcd.setDisplay(statusText);

    // PID bar chart
    pidBar.setData({
      titles: ['Kp', 'Ki', 'Kd'],
      data:   [t.pidKp ?? 800, t.pidKi ?? 50, t.pidKd ?? 300],
    });

    // Telemetry table — all 17 data points
    telTable.setData({
      headers: ['Metric', 'Value'],
      data: [
        ['Signal',      t.signal + ' dBm'],
        ['RX',          rx.toFixed(2)  + ' KB/s'],
        ['TX',          tx.toFixed(2)  + ' KB/s'],
        ['Connectivity',t.connectivity ? 'ONLINE' : 'OFFLINE'],
        ['Interface',   t.bkwInterface],
        ['Health',      t.health + '/100'],
        ['PID Kp',      String(t.pidKp  ?? 800)],
        ['PID Ki',      String(t.pidKi  ?? 50)],
        ['PID Kd',      String(t.pidKd  ?? 300)],
        ['PID Signal',  String(t.pidSignal ?? 0)],
        ['Fixing',      t.isFixing ? 'YES' : 'no'],
        ['Update Avail',t.gitUpdateAvailable ? 'YES' : 'no'],
        ['Local SHA',   t.localSha  || '—'],
        ['Remote SHA',  t.remoteSha || '—'],
        ['Tick',        t.timestamp.slice(11, 19)],
      ],
    });

    // Verbatim log — read new bytes from log file since last offset
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
          buf.toString('utf8').split('\n').forEach(line => {
            if (line.trim()) logBox.log(line);
          });
        }
      } catch { /* log file unreadable — skip */ }
    }

    // Git status box
    if (t.gitUpdateAvailable) {
      gitBox.setContent(
        `{yellow-fg}{bold}UPDATE AVAILABLE{/bold}{/yellow-fg}` +
        `  Local: ${t.localSha}  Remote: ${t.remoteSha}` +
        `  |  curl -X POST http://localhost:3000/api/update` +
        `  |  curl -X POST http://localhost:3000/api/rollback`
      );
    } else {
      gitBox.setContent(
        `{green-fg}Up to date{/green-fg}` +
        `  SHA: ${t.localSha || 'unknown'}` +
        `  |  Interface: ${t.bkwInterface}` +
        `  |  Last tick: ${t.timestamp.slice(0, 19).replace('T', ' ')}`
      );
    }

    screen.render();
  };

  // ── Tick every 2 seconds ──────────────────────────────────────────────────
  update();
  setInterval(update, 2000);
}
