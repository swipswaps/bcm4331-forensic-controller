// PATH: dashboard.ts
// blessed-contrib (github.com/yaronn/blessed-contrib, 15.7k stars)
//
// ALL widget APIs verified from source before use:
//   line.setData([{ title, x[], y[] }])                         — charts/line.js
//   gaugeList.setGauges([{ stack:[{percent,stroke}], label }])  — gauge-list.js
//   gauge.setPercent(N)                                          — gauge.js
//   bar.setData({ titles[], data[] })                           — charts/bar.js
//   log.log(str)                                                 — log.js
//   table.setData({ headers[], data[][] })                       — table.js
//
// Data schema confirmed from fix-wifi.sh source (475 lines, GitHub):
//   health: ping=40pts, DNS=30pts, default_route=30pts
//   DB tables: milestones(timestamp,name,details), commands(timestamp,command,exit_code), config
//   PID: MAX_OUTPUT=1000, SCALE=1000

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

export type TelemetryFn = () => TelemetrySnapshot;

function dbQuery(dbFile: string, sql: string): string[][] {
  if (!fs.existsSync(dbFile)) return [];
  try {
    const raw = execSync(`sqlite3 -separator "|||" "${dbFile}" "${sql}"`,
      { timeout: 2000, encoding: 'utf8' }).trim();
    if (!raw) return [];
    return raw.split('\n').map(r => r.split('|||'));
  } catch { return []; }
}

export function startDashboard(getTelemetry: TelemetryFn): void {

  const screen = blessed.screen({ smartCSR: true, title: 'BCM4331 Forensic Controller v39.8' });
  screen.key(['q', 'C-c'], () => process.exit(0));

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  // ── Row 0-3 left: Signal history ──────────────────────────────────────────
  const signalLine = grid.set(0, 0, 4, 6, contrib.line, {
    label:      ' Signal Strength (dBm) ',
    showLegend: true,
    legend:     { width: 10 },
    xLabelPadding: 3,
    xPadding:   5,
  });

  // ── Row 0-3 right: RX/TX throughput ───────────────────────────────────────
  const trafficLine = grid.set(0, 6, 4, 6, contrib.line, {
    label:      ' Throughput KB/s ',
    showLegend: true,
    legend:     { width: 10 },
  });

  // ── Row 4-5 left: Health components — gaugeList with stack API ────────────
  // gaugeList expects: { stack: [{ percent: N, stroke: 'color' }], label: '' }
  // setGauges() is the only update method — no setGauge() exists
  const healthGauges = grid.set(4, 0, 2, 4, contrib.gaugeList, {
    label:        ' Health Components ',
    gauges: [
      { stack: [{ percent: 0, stroke: 'green'  }], label: 'Ping  40pt' },
      { stack: [{ percent: 0, stroke: 'cyan'   }], label: 'DNS   30pt' },
      { stack: [{ percent: 0, stroke: 'yellow' }], label: 'Route 30pt' },
      { stack: [{ percent: 0, stroke: 'white'  }], label: 'Overall   ' },
    ],
    gaugeSpacing: 0,
    gaugeHeight:  1,
  });

  // ── Row 4-5 mid: Overall health gauge ─────────────────────────────────────
  const healthGauge = grid.set(4, 4, 2, 2, contrib.gauge, {
    label:  ' Health ',
    stroke: 'green',
    fill:   'white',
  });

  // ── Row 4-5 mid-right: PID bar chart ──────────────────────────────────────
  // bar.setData({ titles: string[], data: number[] }) — confirmed from source
  const pidBar = grid.set(4, 6, 2, 3, contrib.bar, {
    label:      ' PID Params ',
    barWidth:   4,
    barSpacing: 3,
    xOffset:    0,
    maxHeight:  1000,
  });

  // ── Row 4-5 right: Recovery commands ──────────────────────────────────────
  const cmdTable = grid.set(4, 9, 2, 3, contrib.table, {
    label:         ' Last Commands ',
    keys:          false,
    interactive:   false,
    columnSpacing: 1,
    columnWidth:   [2, 20],
  });

  // ── Row 6-8 left: Verbatim log ────────────────────────────────────────────
  const logBox = grid.set(6, 0, 3, 6, contrib.log, {
    label:        ' Verbatim Log ',
    fg:           'green',
    selectedFg:   'green',
    bufferLength: 100,
  });

  // ── Row 6-8 right: All telemetry ──────────────────────────────────────────
  const telTable = grid.set(6, 6, 3, 6, contrib.table, {
    label:         ' Telemetry ',
    keys:          false,
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [16, 22],
  });

  // ── Row 9-11: Forensic milestones ─────────────────────────────────────────
  const milestoneTable = grid.set(9, 0, 3, 12, contrib.table, {
    label:         ' Forensic Milestones ',
    keys:          false,
    interactive:   false,
    columnSpacing: 2,
    columnWidth:   [20, 18, 52],
  });

  // ── History ring buffers — index labels prevent nullnull ──────────────────
  const MAX_HIST  = 30;
  const sigHist:  number[] = Array(MAX_HIST).fill(0);
  const rxHist:   number[] = Array(MAX_HIST).fill(0);
  const txHist:   number[] = Array(MAX_HIST).fill(0);
  const timeLabels: string[] = Array.from({ length: MAX_HIST }, (_, i) => `-${MAX_HIST - i}s`);

  // ── Log offset — start at EOF so only new lines appear ────────────────────
  let logOffset = 0;
  const t0 = getTelemetry();
  if (t0.logFile && fs.existsSync(t0.logFile)) {
    try { logOffset = fs.statSync(t0.logFile).size; } catch { logOffset = 0; }
  }

  // ── Update — called every 2s ──────────────────────────────────────────────
  const update = () => {
    const t   = getTelemetry();
    const rx  = t.traffic.rx / 1024;
    const tx  = t.traffic.tx / 1024;
    const now = new Date().toLocaleTimeString();

    sigHist.push(t.signal); sigHist.shift();
    rxHist.push(rx);        rxHist.shift();
    txHist.push(tx);        txHist.shift();
    timeLabels.push(now);   timeLabels.shift();

    // Line charts
    const sigColor = t.signal >= -60 ? 'green' : t.signal >= -75 ? 'yellow' : 'red';
    signalLine.setData([{ title: 'dBm', x: timeLabels, y: sigHist, style: { line: sigColor } }]);
    trafficLine.setData([
      { title: 'RX', x: timeLabels, y: rxHist, style: { line: 'green'  } },
      { title: 'TX', x: timeLabels, y: txHist, style: { line: 'yellow' } },
    ]);

    // gaugeList — setGauges() with stack array (verified from gauge-list.js source)
    // Each component normalised to 0-100: ping max=40, dns max=30, route max=30
    healthGauges.setGauges([
      { stack: [{ percent: t.healthPing  >= 40 ? 100 : 0, stroke: 'green'  }], label: 'Ping  40pt' },
      { stack: [{ percent: t.healthDns   >= 30 ? 100 : 0, stroke: 'cyan'   }], label: 'DNS   30pt' },
      { stack: [{ percent: t.healthRoute >= 30 ? 100 : 0, stroke: 'yellow' }], label: 'Route 30pt' },
      { stack: [{ percent: t.health,                       stroke: t.health >= 80 ? 'green' : t.health >= 40 ? 'yellow' : 'red' }], label: 'Overall   ' },
    ]);

    // Overall gauge
    healthGauge.setPercent(t.health);

    // PID bar — titles+data shape verified from charts/bar.js source
    pidBar.setData({
      titles: ['Kp', 'Ki', 'Kd'],
      data:   [t.pidKp, t.pidKi, t.pidKd],
    });

    // Commands from DB
    const cmds = dbQuery(t.dbFile,
      'SELECT exit_code, command FROM commands ORDER BY rowid DESC LIMIT 5;');
    cmdTable.setData({
      headers: ['RC', 'Command'],
      data: cmds.length
        ? cmds.map(r => [r[0] === '0' ? '✓' : '✗', (r[1] || '').slice(0, 20)])
        : [['—', 'No commands yet']],
    });

    // Verbatim log — new bytes only from logFile
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
      } catch { /* unreadable — skip */ }
    }

    // Full telemetry table
    telTable.setData({
      headers: ['Metric', 'Value'],
      data: [
        ['Signal',      t.signal + ' dBm'],
        ['RX',          rx.toFixed(2) + ' KB/s'],
        ['TX',          tx.toFixed(2) + ' KB/s'],
        ['Online',      t.connectivity ? '● YES' : '○ NO'],
        ['Interface',   t.bkwInterface],
        ['Health',      t.health + '/100'],
        ['Ping',        t.healthPing  + '/40'],
        ['DNS',         t.healthDns   + '/30'],
        ['Route',       t.healthRoute + '/30'],
        ['PID Kp',      String(t.pidKp)],
        ['PID Ki',      String(t.pidKi)],
        ['PID Kd',      String(t.pidKd)],
        ['PID out',     String(t.pidSignal)],
        ['I_error',     String(t.pidIError)],
        ['prev_error',  String(t.pidPrevError)],
        ['Fixing',      t.isFixing ? 'YES' : 'no'],
        ['Git',         t.gitUpdateAvailable ? `${t.localSha}→${t.remoteSha}` : 'current'],
        ['Tick',        t.timestamp.slice(11, 19)],
      ],
    });

    // Milestones from DB
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
        : [['—', '—', 'No milestones recorded yet']],
    });

    screen.render();
  };

  update();
  setInterval(update, 2000);
}
