// PATH: dashboard.ts
// blessed-contrib (github.com/yaronn/blessed-contrib 15.7k stars)
//
// Changes in this version:
// - startDashboard() accepts a second arg: onScreen(screen) callback
//   so server.ts can hold the screen ref for clean SIGINT shutdown
// - screen.destroy() restores terminal on exit
// - ctx guard on all canvas widgets (gaugeList, gauge, bar)
// - stdio:'ignore' on all execSync health checks in server.ts (ping leak fixed)
// - predev script in package.json kills stale processes before start

import blessed    from 'blessed';
import contrib    from 'blessed-contrib';
import fs         from 'fs';
import { execSync } from 'child_process';

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

export type TelemetryFn  = () => TelemetrySnapshot;
export type OnScreenFn   = (screen: any) => void;

function dbQuery(dbFile: string, sql: string): string[][] {
  if (!fs.existsSync(dbFile)) return [];
  try {
    const raw = execSync(
      `sqlite3 -separator "|||" "${dbFile}" "${sql}"`,
      { timeout: 2000, encoding: 'utf8' }
    ).trim();
    if (!raw) return [];
    return raw.split('\n').map(r => r.split('|||'));
  } catch { return []; }
}

function hasCtx(w: any): boolean { return !!(w && w.ctx); }

export function startDashboard(getTelemetry: TelemetryFn, onScreen?: OnScreenFn): void {

  const screen = blessed.screen({ smartCSR: true, title: 'BCM4331 Forensic Controller v39.8' });

  // Pass screen back to server.ts for clean SIGINT/SIGTERM shutdown
  if (onScreen) onScreen(screen);

  // q and Ctrl-C both restore terminal and exit cleanly
  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // ── Row 0-3: Charts ───────────────────────────────────────────────────────
  const signalLine = grid.set(0, 0, 4, 6, contrib.line, {
    label: ' Signal Strength (dBm) ',
    showLegend: true,
    legend: { width: 10 },
    xLabelPadding: 3,
    xPadding: 5,
  });

  const trafficLine = grid.set(0, 6, 4, 6, contrib.line, {
    label: ' Throughput KB/s ',
    showLegend: true,
    legend: { width: 10 },
  });

  // ── Row 4-5: Status panels ────────────────────────────────────────────────
  const healthGauges = grid.set(4, 0, 2, 4, contrib.gaugeList, {
    label: ' Health Components ',
    gauges: [
      { stack: [{ percent: 0, stroke: 'green'  }], label: 'Ping  40pt' },
      { stack: [{ percent: 0, stroke: 'cyan'   }], label: 'DNS   30pt' },
      { stack: [{ percent: 0, stroke: 'yellow' }], label: 'Route 30pt' },
      { stack: [{ percent: 0, stroke: 'white'  }], label: 'Overall   ' },
    ],
    gaugeSpacing: 0,
    gaugeHeight:  1,
  });

  const healthGauge = grid.set(4, 4, 2, 2, contrib.gauge, {
    label:  ' Health ',
    stroke: 'green',
    fill:   'white',
  });

  const pidBar = grid.set(4, 6, 2, 3, contrib.bar, {
    label:      ' PID Params ',
    barWidth:   4,
    barSpacing: 3,
    xOffset:    0,
    maxHeight:  1000,
  });

  const cmdTable = grid.set(4, 9, 2, 3, contrib.table, {
    label:         ' Last Commands ',
    keys:          false,
    interactive:   false,
    columnSpacing: 1,
    columnWidth:   [2, 20],
  });

  // ── Row 6-8: Log + Telemetry ──────────────────────────────────────────────
  const logBox = grid.set(6, 0, 3, 6, contrib.log, {
    label:        ' Verbatim Log ',
    fg:           'green',
    selectedFg:   'green',
    bufferLength: 100,
  });

  const telTable = grid.set(6, 6, 3, 6, contrib.table, {
    label:         ' Telemetry ',
    keys:          false,
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [16, 22],
  });

  // ── Row 9-11: Milestones ──────────────────────────────────────────────────
  const milestoneTable = grid.set(9, 0, 3, 12, contrib.table, {
    label:         ' Forensic Milestones ',
    keys:          false,
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [20, 18, 52],
  });

  // ── History buffers ───────────────────────────────────────────────────────
  const MAX_HIST    = 30;
  const sigHist:    number[] = Array(MAX_HIST).fill(0);
  const rxHist:     number[] = Array(MAX_HIST).fill(0);
  const txHist:     number[] = Array(MAX_HIST).fill(0);
  const timeLabels: string[] = Array.from({ length: MAX_HIST }, (_, i) => `-${MAX_HIST - i}s`);

  // ── Log offset: start at EOF ──────────────────────────────────────────────
  let logOffset = 0;
  const t0 = getTelemetry();
  if (t0.logFile && fs.existsSync(t0.logFile)) {
    try { logOffset = fs.statSync(t0.logFile).size; } catch { logOffset = 0; }
  }

  // ── Initial render — required before setGauges/setPercent/setData ─────────
  // canvas.js assigns ctx inside the 'attach' event which fires on render()
  screen.render();

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

    if (hasCtx(healthGauges)) {
      healthGauges.setGauges([
        { stack: [{ percent: t.healthPing  >= 40 ? 100 : 0, stroke: 'green'  }], label: 'Ping  40pt' },
        { stack: [{ percent: t.healthDns   >= 30 ? 100 : 0, stroke: 'cyan'   }], label: 'DNS   30pt' },
        { stack: [{ percent: t.healthRoute >= 30 ? 100 : 0, stroke: 'yellow' }], label: 'Route 30pt' },
        { stack: [{ percent: t.health,                       stroke: t.health >= 80 ? 'green' : t.health >= 40 ? 'yellow' : 'red' }], label: 'Overall   ' },
      ]);
    }

    if (hasCtx(healthGauge)) healthGauge.setPercent(t.health);

    if (hasCtx(pidBar)) {
      pidBar.setData({ titles: ['Kp', 'Ki', 'Kd'], data: [t.pidKp, t.pidKi, t.pidKd] });
    }

    const cmds = dbQuery(t.dbFile,
      'SELECT exit_code, command FROM commands ORDER BY rowid DESC LIMIT 5;');
    cmdTable.setData({
      headers: ['RC', 'Command'],
      data: cmds.length
        ? cmds.map(r => [r[0] === '0' ? '✓' : '✗', (r[1] || '').slice(0, 20)])
        : [['—', 'No commands yet']],
    });

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
            .split('\n')
            .filter(l => l.trim())
            .forEach(l => logBox.log(l.replace(/\x1b\[[0-9;]*m/g, '')));
        }
      } catch { /* unreadable */ }
    }

    telTable.setData({
      headers: ['Metric', 'Value'],
      data: [
        ['Signal',     t.signal + ' dBm'],
        ['RX',         rx.toFixed(2) + ' KB/s'],
        ['TX',         tx.toFixed(2) + ' KB/s'],
        ['Online',     t.connectivity ? '● YES' : '○ NO'],
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
        ['prev_error', String(t.pidPrevError)],
        ['Fixing',     t.isFixing ? 'YES' : 'no'],
        ['Git',        t.gitUpdateAvailable ? `${t.localSha}→${t.remoteSha}` : 'current'],
        ['Tick',       t.timestamp.slice(11, 19)],
      ],
    });

    const ms = dbQuery(t.dbFile,
      'SELECT timestamp, name, details FROM milestones ORDER BY rowid DESC LIMIT 8;');
    milestoneTable.setData({
      headers: ['Timestamp', 'Milestone', 'Details'],
      data: ms.length
        ? ms.map(r => [
            (r[0] || '').slice(0, 19),
            (r[1] || '').slice(0, 18),
            (r[2] || '').slice(0, 52),
          ])
        : [['—', '—', 'No milestones yet']],
    });

    screen.render();
  };

  update();
  setInterval(update, 2000);
}
