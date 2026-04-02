// PATH: server.ts
import express from "express";
import { createServer as createViteServer } from "vite";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3000;
const WORKSPACE_DIR = process.cwd();
const LOG_FILE = path.join(WORKSPACE_DIR, "verbatim_handshake.log");
const DB_FILE = path.join(WORKSPACE_DIR, "recovery_state.db");

// CRITICAL: Centralized logTee helper for server-side transparency
// This ensures that every backend decision is mirrored in the telemetry log.
const logTee = (msg: string) => {
  const ts = new Date().toISOString();
  const formatted = `[SERVER ${ts}] ${msg}`;
  console.log(formatted);
  try {
    fs.appendFileSync(LOG_FILE, formatted + "\n");
  } catch (e) {
    console.error(`[CRITICAL] Failed to write to log file: ${e}`);
  }
};

process.on('unhandledRejection', (reason, promise) => {
  logTee(`🚨 UNHANDLED REJECTION: ${reason} at ${promise}`);
});
process.on('uncaughtException', (err) => {
  logTee(`🚨 UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});

// POINTS 1-4: Environment Resolution
logTee(`Initializing Broadcom Control Center...`);
logTee(`WORKSPACE_DIR: ${WORKSPACE_DIR}`);
logTee(`LOG_FILE: ${LOG_FILE}`);
logTee(`DB_FILE: ${DB_FILE}`);

const FIX_SCRIPT = fs.existsSync("/usr/local/bin/fix-wifi")
  ? "/usr/local/bin/fix-wifi"
  : path.join(WORKSPACE_DIR, "fix-wifi.sh");
logTee(`FIX_SCRIPT_PATH: ${FIX_SCRIPT}`);

app.use(express.json());

let isFixing = false;
let isSimulatingFault = false;
let lastFixError: string | null = null;
const metricsHistory: { timestamp: string; signal: number; rx: number; tx: number }[] = [];

// Shared telemetry state
let currentTelemetry = {
  signal: 0,
  traffic: { rx: 0, tx: 0 },
  connectivity: false,
  bkwInterface: "Unknown",
  health: 100,
  timestamp: new Date().toISOString()
};

// ─── TERMINAL DASHBOARD ───────────────────────────────────────────────────────
// FIX: previous version used padEnd/padStart on strings that already contained
// ANSI escape codes. ANSI codes have zero visible width but non-zero string
// length, so padding was measured against raw bytes not visible chars, causing
// all columns to misalign. Fix: strip ANSI before measuring, then pad with
// spaces calculated from the visible length only.
//
// FIX: previous version called logTee() between console.log("\x1b[2J\x1b[H")
// and renderTerminalDashboard(), so log lines appeared inside the cleared frame.
// Fix: renderTerminalDashboard() now emits its own clear+render atomically and
// is the only console write in the tick — logTee calls in the loop now go to
// the log file only (not stdout) during the dashboard render cycle.

const W = 78; // visible width including border chars

const visLen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, '').length;

const boxrow = (content: string): string => {
  const pad = Math.max(0, W - 2 - visLen(content));
  return '│' + content + ' '.repeat(pad) + '│';
};

const hline = (l: string, f: string, r: string): string => l + f.repeat(W - 2) + r;

const sechead = (title: string): string => {
  const t = ` ${title} `;
  const lp = Math.floor((W - 2 - t.length) / 2);
  const rp = W - 2 - t.length - lp;
  return '├' + '─'.repeat(lp) + '\x1b[1m\x1b[36m' + t + '\x1b[0m' + '─'.repeat(rp) + '┤';
};

const kv = (label: string, value: string, vc = '\x1b[0m'): string => {
  const lp = label.padEnd(20);
  return boxrow('  \x1b[90m' + lp + '\x1b[0m' + vc + value + '\x1b[0m');
};

const renderTerminalDashboard = (): string => {
  const { signal, traffic, connectivity, bkwInterface, health, timestamp } = currentTelemetry;

  const connColor  = connectivity ? '\x1b[32m' : '\x1b[31m';
  const hColor     = health >= 80 ? '\x1b[32m' : health >= 40 ? '\x1b[33m' : '\x1b[31m';
  const sColor     = signal >= -60 ? '\x1b[32m' : signal >= -75 ? '\x1b[33m' : '\x1b[31m';

  const lines: string[] = [];

  // Title
  lines.push(hline('╔', '═', '╗'));
  const title = 'BROADCOM BCM4331 FORENSIC CONTROLLER  v39.8';
  const tp = Math.floor((W - 2 - title.length) / 2);
  lines.push('║' + ' '.repeat(tp) + '\x1b[1m\x1b[36m' + title + '\x1b[0m' + ' '.repeat(W - 2 - tp - title.length) + '║');
  lines.push(hline('╠', '═', '╣'));

  // Status bar — padding computed from visLen, not raw string length
  const stBadge  = connColor + '\x1b[1m● ' + (connectivity ? 'ONLINE ' : 'OFFLINE') + '\x1b[0m';
  const hlBadge  = hColor   + '\x1b[1mHEALTH ' + String(health).padStart(3) + '/100\x1b[0m';
  const ifBadge  = '\x1b[90mIF: ' + bkwInterface + '\x1b[0m';
  lines.push(boxrow('  ' + stBadge + '  ' + hlBadge + '  ' + ifBadge));
  lines.push(hline('╠', '═', '╣'));

  // Telemetry panel
  lines.push(sechead('TELEMETRY'));
  lines.push(kv('Signal Strength',  signal + ' dBm',                    sColor));
  lines.push(kv('RX',               (traffic.rx / 1024).toFixed(2) + ' KB/s', '\x1b[32m'));
  lines.push(kv('TX',               (traffic.tx / 1024).toFixed(2) + ' KB/s', '\x1b[33m'));
  lines.push(kv('Connectivity',     connectivity ? 'ONLINE' : 'OFFLINE', connColor + '\x1b[1m'));
  lines.push(kv('Interface',        bkwInterface));
  lines.push(kv('Last tick',        timestamp, '\x1b[90m'));
  lines.push(hline('╚', '═', '╝'));

  // Atomic: clear screen + render in one write so no logTee output leaks between them
  return '\x1b[2J\x1b[H' + lines.join('\n') + '\n';
};
// ─────────────────────────────────────────────────────────────────────────────

const runCommand = (cmd: string, env: Record<string, string> = {}): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [], {
      env: { ...process.env, ...env },
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe']
    });

    child.stdout?.on('data', (data) => {
      data.toString().split('\n').forEach((line: string) => {
        if (line.trim()) console.log(`[STDOUT] ${line}`);
      });
    });

    child.stderr?.on('data', (data) => {
      data.toString().split('\n').forEach((line: string) => {
        if (line.trim()) console.error(`[STDERR] ${line}`);
      });
    });

    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
  });
};

// POINTS 5-8: Hardened Rapid Repair Logic
const startMonitor = () => {
  const cmd = `sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --monitor --workspace "${WORKSPACE_DIR}"`;
  logTee(`📡 Starting background monitor: ${cmd}`);
  runCommand(cmd).catch(err => {
    logTee(`⚠️ Monitor process ended: ${err.message}`);
    setTimeout(startMonitor, 5000);
  });
};

const rapidRepair = async () => {
  logTee("🔍 Starting rapid system health check...");
  try {
    const localSetupPath = path.join(WORKSPACE_DIR, "setup-system.sh");
    const localFixPath   = path.join(WORKSPACE_DIR, "fix-wifi.sh");
    execSync(`chmod +x "${localFixPath}" "${localSetupPath}"`);
    logTee("Deploying latest recovery script to system path...");
    await runCommand(`sudo -n cp "${localFixPath}" "${FIX_SCRIPT}"`);
    await runCommand(`sudo -n chmod +x "${FIX_SCRIPT}"`);
    logTee("Executing health check: fix-wifi --check-only");
    await runCommand(`sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --check-only --workspace "${WORKSPACE_DIR}"`);
    logTee("✅ System health verified. Sudoers and dependencies are intact.");
    startMonitor();
  } catch (err: unknown) {
    const error = err as { message?: string };
    logTee(`❌ Rapid repair failed: ${error.message || String(error)}. Triggering full setup recovery...`);
    try {
      const localSetupPath = path.join(WORKSPACE_DIR, "setup-system.sh");
      await runCommand(`PROJECT_ROOT="${WORKSPACE_DIR}" bash "${localSetupPath}"`);
      logTee("✅ Full setup recovery completed.");
      startMonitor();
    } catch (setupErr) {
      logTee(`🚨 CRITICAL: System recovery failed. Manual intervention required: ${setupErr}`);
    }
  }
};

// POINT 9: API Routes - Status
app.get("/api/status", async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({ isFixing, lastFixError, ...currentTelemetry, metricsHistory });
});

// POINT 10: API Routes - Audit
app.get('/api/audit', async (req, res) => {
  logTee("GET /api/audit - Fetching forensic evidence");
  try {
    const log = fs.existsSync(LOG_FILE) ? await fs.promises.readFile(LOG_FILE, 'utf8') : "No logs found.";
    let dbMilestones = "No database found.";
    if (fs.existsSync(DB_FILE)) {
      try {
        dbMilestones = execSync(`sqlite3 -separator "|" "${DB_FILE}" "SELECT timestamp, name, details FROM milestones ORDER BY timestamp ASC;"`).toString();
      } catch (dbErr) {
        dbMilestones = `Error reading database: ${dbErr}`;
      }
    }
    res.json({
      status: 'RECOVERY_COMPLETE',
      verbatimLogSnippet: log.slice(-8000),
      dbMilestones,
      message: "Full telemetry log + forensic evidence loaded"
    });
  } catch (e) {
    logTee(`Error during audit fetch: ${e}`);
    res.status(200).json({ status: 'READY', message: 'Run cold-start for full recovery' });
  }
});

// POINTS 11-14: API Routes - Fix
app.post("/api/fix", async (req, res) => {
  logTee("POST /api/fix - Recovery request received");
  if (isFixing) {
    logTee("⚠️ Fix requested while already in progress. Ignoring.");
    return res.status(400).json({ error: "Fix already in progress" });
  }
  isFixing = true;
  isSimulatingFault = false;
  lastFixError = null;
  res.json({ message: "Recovery initiated" });
  const cmd = `sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --workspace "${WORKSPACE_DIR}" --force`;
  logTee(`🚀 Spawning recovery process: ${cmd}`);
  try {
    await runCommand(cmd);
    logTee("✅ Recovery process completed successfully.");
    startMonitor();
  } catch (err: unknown) {
    lastFixError = err instanceof Error ? err.message : String(err);
    logTee(`❌ Recovery process failed: ${lastFixError}`);
  } finally {
    isFixing = false;
  }
});

// POINT 15: API Routes - Test Fault
app.post('/api/test/fault', (req, res) => {
  isSimulatingFault = !isSimulatingFault;
  logTee(`⚠️ FAULT SIMULATION: ${isSimulatingFault ? "ENABLED" : "DISABLED"}`);
  res.json({ isSimulatingFault });
});

// POINT 16: API Routes - Config
app.get("/api/config", (req, res) => {
  try {
    const kp = execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='pid_kp';"`, { encoding: 'utf8' }).trim() || "800";
    const ki = execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='pid_ki';"`, { encoding: 'utf8' }).trim() || "50";
    const kd = execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='pid_kd';"`, { encoding: 'utf8' }).trim() || "300";
    res.json({ kp: parseInt(kp), ki: parseInt(ki), kd: parseInt(kd) });
  } catch {
    res.json({ kp: 800, ki: 50, kd: 300 });
  }
});

app.post("/api/config", (req, res) => {
  const { kp, ki, kd } = req.body;
  logTee(`Updating PID Config: Kp=${kp}, Ki=${ki}, Kd=${kd}`);
  try {
    const ts = new Date().toISOString();
    execSync(`sqlite3 "${DB_FILE}" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('pid_kp', '${kp}', '${ts}');"`);
    execSync(`sqlite3 "${DB_FILE}" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('pid_ki', '${ki}', '${ts}');"`);
    execSync(`sqlite3 "${DB_FILE}" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('pid_kd', '${kd}', '${ts}');"`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POINTS 17-18: SSE for real-time logs
app.get("/api/events", (req, res) => {
  logTee("SSE /api/events - Client connected for real-time telemetry");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let clientOffset = 0;
  try {
    if (fs.existsSync(LOG_FILE)) clientOffset = fs.statSync(LOG_FILE).size;
  } catch {
    clientOffset = 0;
  }

  const sendEvent = (data: { type: string; content: string }) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(async () => {
    if (!fs.existsSync(LOG_FILE)) return;
    try {
      const stat = fs.statSync(LOG_FILE);
      if (clientOffset > stat.size) clientOffset = 0;
      if (stat.size <= clientOffset) return;
      const fd = fs.openSync(LOG_FILE, 'r');
      const deltaSize = stat.size - clientOffset;
      const buf = Buffer.alloc(deltaSize);
      fs.readSync(fd, buf, 0, deltaSize, clientOffset);
      fs.closeSync(fd);
      clientOffset = stat.size;
      const delta = buf.toString('utf8');
      if (delta.trim()) sendEvent({ type: "log", content: delta });
    } catch {
      // Silent fail for SSE
    }
  }, 2000);

  req.on("close", () => {
    logTee("SSE /api/events - Client disconnected");
    clearInterval(interval);
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    logTee("Starting server in DEVELOPMENT mode (Vite middleware enabled)");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    logTee("Starting server in PRODUCTION mode (Static serving enabled)");
    const distPath = path.join(WORKSPACE_DIR, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // POINT 17: Port Binding
  app.listen(PORT, "0.0.0.0", () => {
    logTee(`📡 Broadcom Control Center listening on http://localhost:${PORT}`);
    rapidRepair();

    // Heartbeat and Telemetry background loop
    setInterval(async () => {
      const ts = new Date().toISOString();
      let signal = 0;
      let traffic = { rx: 0, tx: 0 };
      let connectivity = false;
      let bkwInterface = "Unknown";
      let health = 100;

      try {
        // 1. BKW Interface and Health from DB
        if (fs.existsSync(DB_FILE)) {
          try {
            bkwInterface = execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='bkw_interface';"`, { timeout: 1000, encoding: 'utf8' }).trim() || "Unknown";
            const healthStr = execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='health_score';"`, { timeout: 1000, encoding: 'utf8' }).trim();
            if (healthStr) health = parseInt(healthStr);
          } catch {
            // Silent fail for background
          }
        }

        // 2. Signal Strength
        try {
          const iwOutput = execSync("iw dev | grep Interface | awk '{print $2}' | xargs -I {} iw dev {} link", { timeout: 2000, encoding: 'utf8' }).toString();
          const signalMatch = iwOutput.match(/signal:\s+(-?\d+)\s+dBm/);
          if (signalMatch) signal = parseInt(signalMatch[1]);
        } catch {
          // Silent fail
        }

        // 3. Traffic Stats
        try {
          const statsOutput = execSync("cat /proc/net/dev | grep -E 'wl|wlan' || true", { timeout: 1000, encoding: 'utf8' }).toString();
          if (statsOutput.trim()) {
            const stats = statsOutput.trim().split(/\s+/);
            if (stats.length > 10) traffic = { rx: parseInt(stats[1]), tx: parseInt(stats[9]) };
          }
        } catch {
          // Silent fail
        }

        // 4. Connectivity
        try {
          if (isSimulatingFault) {
            connectivity = false;
            signal = -99;
            traffic = { rx: 0, tx: 0 };
          } else {
            execSync("ping -c 1 -W 1 8.8.8.8", { timeout: 1500 });
            connectivity = true;
          }
        } catch {
          connectivity = false;
        }
      } catch {
        // Global catch for the loop
      }

      // Update shared state
      currentTelemetry = { signal, traffic, connectivity, bkwInterface, health, timestamp: ts };

      // Update history
      metricsHistory.push({ timestamp: new Date().toLocaleTimeString(), signal, ...traffic });
      if (metricsHistory.length > 50) metricsHistory.shift();

      // FIX: write telemetry to log file only (not stdout) during dashboard tick.
      // Previous code called logTee() here which wrote to both console.log AND
      // the log file, so those lines appeared inside the cleared terminal frame
      // between \x1b[2J\x1b[H and renderTerminalDashboard(), breaking layout.
      // logTee is file-only here; renderTerminalDashboard() owns the terminal.
      const fileOnly = (msg: string) => {
        const formatted = `[SERVER ${ts}] ${msg}`;
        try { fs.appendFileSync(LOG_FILE, formatted + "\n"); } catch { /* ignore */ }
      };
      fileOnly(`📡 Telemetry Tick [${ts}]:`);
      fileOnly(`  Signal: ${signal} dBm`);
      fileOnly(`  RX Bytes: ${traffic.rx}`);
      fileOnly(`  TX Bytes: ${traffic.tx}`);
      fileOnly(`  Connectivity: ${connectivity ? "ONLINE" : "OFFLINE"}`);
      fileOnly(`  BKW Interface: ${bkwInterface}`);

      // Single atomic terminal write: clear + structured dashboard
      process.stdout.write(renderTerminalDashboard());

    }, 10000);
  });
}

startServer();
