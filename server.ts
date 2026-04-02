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
const DB_FILE  = path.join(WORKSPACE_DIR, "recovery_state.db");

// ─── logTee: file + console (startup/errors only — NOT in the tick loop) ──────
const logTee = (msg: string) => {
  const ts = new Date().toISOString();
  const formatted = `[SERVER ${ts}] ${msg}`;
  console.log(formatted);
  try { fs.appendFileSync(LOG_FILE, formatted + "\n"); } catch { /* ignore */ }
};

// ─── fileOnly: tick-loop writes — file only, never stdout ────────────────────
// FIX 1+2: previous code used logTee() in the tick loop and piped monitor
// stdout through console.log('[STDOUT] ...'), both of which wrote to stdout
// between dashboard repaints, staggering box lines by 9+ chars per line.
// fileOnly() ensures the tick loop never touches stdout; the monitor child
// process is redirected to the log file directly (see startMonitor below).
const fileOnly = (msg: string) => {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `[SERVER ${ts}] ${msg}\n`); } catch { /* ignore */ }
};

process.on('unhandledRejection', (reason, promise) => {
  logTee(`UNHANDLED REJECTION: ${reason} at ${promise}`);
});
process.on('uncaughtException', (err) => {
  logTee(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});

logTee(`Initializing Broadcom Control Center...`);
logTee(`WORKSPACE_DIR: ${WORKSPACE_DIR}`);
logTee(`LOG_FILE: ${LOG_FILE}`);
logTee(`DB_FILE: ${DB_FILE}`);

const FIX_SCRIPT = fs.existsSync("/usr/local/bin/fix-wifi")
  ? "/usr/local/bin/fix-wifi"
  : path.join(WORKSPACE_DIR, "fix-wifi.sh");
logTee(`FIX_SCRIPT_PATH: ${FIX_SCRIPT}`);

app.use(express.json());

let isFixing          = false;
let isSimulatingFault = false;
let lastFixError: string | null = null;
const metricsHistory: { timestamp: string; signal: number; rx: number; tx: number }[] = [];

let currentTelemetry = {
  signal: 0,
  traffic: { rx: 0, tx: 0 },
  connectivity: false,
  bkwInterface: "Unknown",
  health: 100,
  timestamp: new Date().toISOString()
};

// ─── Git update state ─────────────────────────────────────────────────────────
let gitUpdateAvailable = false;
let localSha  = "";
let remoteSha = "";

// ─── TERMINAL DASHBOARD ───────────────────────────────────────────────────────
// FIX 1+2: dashboard owns stdout exclusively.
// No other code may write to stdout during normal operation.
const W = 78;
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const boxrow = (content: string) => {
  const pad = Math.max(0, W - 2 - visLen(content));
  return '│' + content + ' '.repeat(pad) + '│';
};
const hline = (l: string, f: string, r: string) => l + f.repeat(W - 2) + r;
const sechead = (title: string) => {
  const t = ` ${title} `;
  const lp = Math.floor((W - 2 - t.length) / 2);
  const rp = W - 2 - t.length - lp;
  return '├' + '─'.repeat(lp) + '\x1b[1m\x1b[36m' + t + '\x1b[0m' + '─'.repeat(rp) + '┤';
};
const kv = (label: string, value: string, vc = '\x1b[0m') =>
  boxrow('  \x1b[90m' + label.padEnd(20) + '\x1b[0m' + vc + value + '\x1b[0m');

const renderTerminalDashboard = (): string => {
  const { signal, traffic, connectivity, bkwInterface, health, timestamp } = currentTelemetry;
  const connColor = connectivity ? '\x1b[32m' : '\x1b[31m';
  const hColor    = health >= 80 ? '\x1b[32m' : health >= 40 ? '\x1b[33m' : '\x1b[31m';
  const sColor    = signal >= -60 ? '\x1b[32m' : signal >= -75 ? '\x1b[33m' : '\x1b[31m';

  const out: string[] = [];

  out.push(hline('╔', '═', '╗'));
  const title = 'BROADCOM BCM4331 FORENSIC CONTROLLER  v39.8';
  const tp = Math.floor((W - 2 - title.length) / 2);
  out.push('║' + ' '.repeat(tp) + '\x1b[1m\x1b[36m' + title + '\x1b[0m' + ' '.repeat(W - 2 - tp - title.length) + '║');
  out.push(hline('╠', '═', '╣'));

  const st = connColor + '\x1b[1m● ' + (connectivity ? 'ONLINE ' : 'OFFLINE') + '\x1b[0m';
  const hl = hColor   + '\x1b[1mHEALTH ' + String(health).padStart(3) + '/100\x1b[0m';
  const il = '\x1b[90mIF: ' + bkwInterface + '\x1b[0m';
  out.push(boxrow('  ' + st + '  ' + hl + '  ' + il));
  out.push(hline('╠', '═', '╣'));

  out.push(sechead('TELEMETRY'));
  out.push(kv('Signal',       signal + ' dBm',                           sColor));
  out.push(kv('RX',           (traffic.rx  / 1024).toFixed(2) + ' KB/s', '\x1b[32m'));
  out.push(kv('TX',           (traffic.tx  / 1024).toFixed(2) + ' KB/s', '\x1b[33m'));
  out.push(kv('Connectivity', connectivity ? 'ONLINE' : 'OFFLINE',       connColor + '\x1b[1m'));
  out.push(kv('Interface',    bkwInterface));
  out.push(kv('Last tick',    timestamp,                                  '\x1b[90m'));

  // FIX 5: git update banner — appears only when update detected
  if (gitUpdateAvailable) {
    out.push(hline('╠', '═', '╣'));
    out.push(sechead('UPDATE AVAILABLE'));
    out.push(boxrow('  \x1b[33m\x1b[1mNew commits on origin/master\x1b[0m'));
    out.push(boxrow('  \x1b[90mLocal:  ' + localSha + '  Remote: ' + remoteSha + '\x1b[0m'));
    out.push(boxrow('  \x1b[90mUpdate:   POST http://localhost:3000/api/update\x1b[0m'));
    out.push(boxrow('  \x1b[90mRollback: POST http://localhost:3000/api/rollback\x1b[0m'));
  }

  out.push(hline('╚', '═', '╝'));
  return '\x1b[2J\x1b[H' + out.join('\n') + '\n';
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── runCommand: pipes stdout/stderr to log file only — never stdout ──────────
// FIX 1+2: was console.log('[STDOUT] '+line) — now fileOnly()
const runCommand = (cmd: string, env: Record<string, string> = {}): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [], {
      env: { ...process.env, ...env },
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (data) => {
      data.toString().split('\n').forEach((line: string) => {
        if (line.trim()) fileOnly(`[STDOUT] ${line}`);
      });
    });
    child.stderr?.on('data', (data) => {
      data.toString().split('\n').forEach((line: string) => {
        if (line.trim()) fileOnly(`[STDERR] ${line}`);
      });
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
  });
};

// ─── startMonitor: child stdout/stderr → log file fd, never console ──────────
// FIX 1+2: previous version called runCommand() which piped through console.log.
// Now child inherits a direct file descriptor — output never reaches stdout.
const startMonitor = () => {
  const cmd = `sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --monitor --workspace "${WORKSPACE_DIR}"`;
  fileOnly(`Starting background monitor`);

  let logFd: number;
  try { logFd = fs.openSync(LOG_FILE, 'a'); } catch { logFd = 2; }

  const child = spawn(cmd, [], {
    env: { ...process.env },
    shell: true,
    stdio: ['inherit', logFd, logFd]  // stdout+stderr → log file, not console
  });

  child.on('close', (code) => {
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    fileOnly(`Monitor exited (code ${code}) — restarting in 5s`);
    setTimeout(startMonitor, 5000);
  });
};

const rapidRepair = async () => {
  logTee("Starting rapid system health check...");
  try {
    const localSetupPath = path.join(WORKSPACE_DIR, "setup-system.sh");
    const localFixPath   = path.join(WORKSPACE_DIR, "fix-wifi.sh");
    execSync(`chmod +x "${localFixPath}" "${localSetupPath}"`);
    logTee("Deploying latest recovery script...");
    await runCommand(`sudo -n cp "${localFixPath}" "${FIX_SCRIPT}"`);
    await runCommand(`sudo -n chmod +x "${FIX_SCRIPT}"`);
    logTee("Executing health check...");
    await runCommand(`sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --check-only --workspace "${WORKSPACE_DIR}"`);
    logTee("System health verified.");
    startMonitor();
  } catch (err: unknown) {
    const error = err as { message?: string };
    logTee(`Rapid repair failed: ${error.message || String(error)}`);
    try {
      await runCommand(`PROJECT_ROOT="${WORKSPACE_DIR}" bash "${path.join(WORKSPACE_DIR, 'setup-system.sh')}"`);
      logTee("Full setup recovery completed.");
      startMonitor();
    } catch (setupErr) {
      logTee(`CRITICAL: System recovery failed: ${setupErr}`);
    }
  }
};

// ─── FIX 5: Git update detection — polls every 60s ───────────────────────────
const checkForUpdates = () => {
  try {
    execSync('git fetch origin', { cwd: WORKSPACE_DIR, timeout: 10000, stdio: 'ignore' });
    localSha  = execSync('git rev-parse HEAD',          { cwd: WORKSPACE_DIR, encoding: 'utf8' }).trim().slice(0, 7);
    remoteSha = execSync('git rev-parse origin/master', { cwd: WORKSPACE_DIR, encoding: 'utf8' }).trim().slice(0, 7);
    gitUpdateAvailable = localSha !== remoteSha;
    if (gitUpdateAvailable) fileOnly(`Update available: local=${localSha} remote=${remoteSha}`);
  } catch { /* no network or not a git repo — skip silently */ }
};

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) => {
  res.json({ isFixing, lastFixError, ...currentTelemetry, metricsHistory, gitUpdateAvailable, localSha, remoteSha });
});

app.get('/api/audit', async (_req, res) => {
  try {
    const log = fs.existsSync(LOG_FILE) ? await fs.promises.readFile(LOG_FILE, 'utf8') : "No logs found.";
    let dbMilestones = "No database found.";
    if (fs.existsSync(DB_FILE)) {
      try { dbMilestones = execSync(`sqlite3 -separator "|" "${DB_FILE}" "SELECT timestamp, name, details FROM milestones ORDER BY timestamp ASC;"`).toString(); }
      catch (e) { dbMilestones = `Error: ${e}`; }
    }
    res.json({ status: 'RECOVERY_COMPLETE', verbatimLogSnippet: log.slice(-8000), dbMilestones });
  } catch {
    res.status(200).json({ status: 'READY', message: 'Run cold-start for full recovery' });
  }
});

app.post("/api/fix", async (_req, res) => {
  if (isFixing) return res.status(400).json({ error: "Fix already in progress" });
  isFixing = true; isSimulatingFault = false; lastFixError = null;
  res.json({ message: "Recovery initiated" });
  const cmd = `sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --workspace "${WORKSPACE_DIR}" --force`;
  try {
    await runCommand(cmd);
    logTee("Recovery completed.");
    startMonitor();
  } catch (err: unknown) {
    lastFixError = err instanceof Error ? err.message : String(err);
    logTee(`Recovery failed: ${lastFixError}`);
  } finally { isFixing = false; }
});

app.post('/api/test/fault', (_req, res) => {
  isSimulatingFault = !isSimulatingFault;
  res.json({ isSimulatingFault });
});

app.get("/api/config", (_req, res) => {
  try {
    const g = (k: string) => execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='${k}';"`, { encoding: 'utf8' }).trim();
    res.json({ kp: parseInt(g('pid_kp') || '800'), ki: parseInt(g('pid_ki') || '50'), kd: parseInt(g('pid_kd') || '300') });
  } catch { res.json({ kp: 800, ki: 50, kd: 300 }); }
});

app.post("/api/config", (req, res) => {
  const { kp, ki, kd } = req.body;
  try {
    const ts = new Date().toISOString();
    const s = (k: string, v: string) => execSync(`sqlite3 "${DB_FILE}" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('${k}', '${v}', '${ts}');"`);
    s('pid_kp', kp); s('pid_ki', ki); s('pid_kd', kd);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// FIX 5: update + rollback endpoints (also shown in web UI via /api/status)
app.post("/api/update", async (_req, res) => {
  logTee("Pulling latest from origin/master");
  try {
    execSync('git pull origin master', { cwd: WORKSPACE_DIR, encoding: 'utf8' });
    execSync('npm install',            { cwd: WORKSPACE_DIR, encoding: 'utf8' });
    gitUpdateAvailable = false;
    res.json({ success: true, message: "Updated. Restart the server to apply." });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/rollback", (req, res) => {
  const { sha } = req.body;
  const target = sha || 'HEAD~1';
  logTee(`Rolling back to ${target}`);
  try {
    const result = execSync(`git reset --hard ${target}`, { cwd: WORKSPACE_DIR, encoding: 'utf8' });
    res.json({ success: true, message: `Rolled back to ${target}. Restart to apply.`, result });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  let clientOffset = 0;
  try { if (fs.existsSync(LOG_FILE)) clientOffset = fs.statSync(LOG_FILE).size; } catch { /* ignore */ }
  const sendEvent = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const interval = setInterval(() => {
    if (!fs.existsSync(LOG_FILE)) return;
    try {
      const stat = fs.statSync(LOG_FILE);
      if (clientOffset > stat.size) clientOffset = 0;
      if (stat.size <= clientOffset) return;
      const buf = Buffer.alloc(stat.size - clientOffset);
      const fd  = fs.openSync(LOG_FILE, 'r');
      fs.readSync(fd, buf, 0, buf.length, clientOffset);
      fs.closeSync(fd);
      clientOffset = stat.size;
      const delta = buf.toString('utf8');
      if (delta.trim()) sendEvent({ type: "log", content: delta });
    } catch { /* ignore */ }
  }, 2000);
  req.on("close", () => clearInterval(interval));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(WORKSPACE_DIR, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => {
    logTee(`Broadcom Control Center listening on http://localhost:${PORT}`);
    rapidRepair();

    // FIX 5: git update check every 60s
    checkForUpdates();
    setInterval(checkForUpdates, 60000);

    // FIX 3: tick every 2s (was 10s)
    // FIX 1+2: only process.stdout.write() touches stdout in this loop
    // FIX 4: health computed live — no DB lag
    setInterval(async () => {
      const ts = new Date().toISOString();
      let signal = 0, traffic = { rx: 0, tx: 0 }, connectivity = false, bkwInterface = "Unknown";

      try {
        if (fs.existsSync(DB_FILE)) {
          try { bkwInterface = execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='bkw_interface';"`, { timeout: 1000, encoding: 'utf8' }).trim() || "Unknown"; }
          catch { /* ignore */ }
        }
        try {
          const m = execSync("iw dev | grep Interface | awk '{print $2}' | xargs -I {} iw dev {} link", { timeout: 2000, encoding: 'utf8' }).match(/signal:\s+(-?\d+)\s+dBm/);
          if (m) signal = parseInt(m[1]);
        } catch { /* ignore */ }
        try {
          const s = execSync("cat /proc/net/dev | grep -E 'wl|wlan' || true", { timeout: 1000, encoding: 'utf8' }).trim().split(/\s+/);
          if (s.length > 10) traffic = { rx: parseInt(s[1]), tx: parseInt(s[9]) };
        } catch { /* ignore */ }
        try {
          if (isSimulatingFault) { connectivity = false; signal = -99; traffic = { rx: 0, tx: 0 }; }
          else { execSync("ping -c 1 -W 1 8.8.8.8", { timeout: 1500 }); connectivity = true; }
        } catch { connectivity = false; }
      } catch { /* ignore */ }

      // FIX 4: live health — connectivity=50, good signal=30, traffic flowing=20
      const health = (connectivity ? 50 : 0) +
                     (signal >= -70 ? 30 : signal >= -85 ? 15 : 0) +
                     (traffic.rx > 0 ? 20 : 0);

      currentTelemetry = { signal, traffic, connectivity, bkwInterface, health, timestamp: ts };
      metricsHistory.push({ timestamp: new Date().toLocaleTimeString(), signal, ...traffic });
      if (metricsHistory.length > 50) metricsHistory.shift();

      fileOnly(`tick signal=${signal} conn=${connectivity} health=${health}`);
      process.stdout.write(renderTerminalDashboard());

    }, 2000); // FIX 3: was 10000
  });
}

startServer();
