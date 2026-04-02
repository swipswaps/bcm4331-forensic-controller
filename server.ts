// PATH: server.ts
import express   from "express";
import { createServer as createViteServer } from "vite";
import { execSync, spawn } from "child_process";
import fs        from "fs";
import path      from "path";
import { startDashboard } from "./dashboard.js";

const app           = express();
const PORT          = 3000;
const WORKSPACE_DIR = process.cwd();
const LOG_FILE      = path.join(WORKSPACE_DIR, "verbatim_handshake.log");
const DB_FILE       = path.join(WORKSPACE_DIR, "recovery_state.db");

// ── fileOnly: all writes during tick go to log file — never stdout ────────────
// stdout is owned by blessed after startDashboard() is called.
const fileOnly = (msg: string) => {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `[SERVER ${ts}] ${msg}\n`); } catch { /* ignore */ }
};

// ── Startup messages go to stderr — visible before blessed takes screen ───────
const log = (msg: string) => {
  const ts  = new Date().toISOString();
  const line = `[SERVER ${ts}] ${msg}`;
  process.stderr.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
};

process.on('unhandledRejection', (r) => fileOnly(`UNHANDLED REJECTION: ${r}`));
process.on('uncaughtException',  (e) => fileOnly(`UNCAUGHT EXCEPTION: ${(e as Error).message}`));

log(`Initializing Broadcom Control Center...`);
log(`WORKSPACE_DIR: ${WORKSPACE_DIR}`);
log(`LOG_FILE: ${LOG_FILE}`);
log(`DB_FILE:  ${DB_FILE}`);

const FIX_SCRIPT = fs.existsSync("/usr/local/bin/fix-wifi")
  ? "/usr/local/bin/fix-wifi"
  : path.join(WORKSPACE_DIR, "fix-wifi.sh");
log(`FIX_SCRIPT: ${FIX_SCRIPT}`);

app.use(express.json());

// ── Shared state — all fields needed by dashboard ─────────────────────────────
let isFixing          = false;
let isSimulatingFault = false;
let lastFixError: string | null = null;
const metricsHistory: { timestamp: string; signal: number; rx: number; tx: number }[] = [];

let currentTelemetry = {
  signal:       0,
  traffic:      { rx: 0, tx: 0 },
  connectivity: false,
  bkwInterface: "Unknown",
  // Health — overall + per-component matching fix-wifi.sh calculate_health()
  // ping=40pts, DNS=30pts, default_route=30pts (confirmed from source)
  health:       0,
  healthPing:   0,
  healthDns:    0,
  healthRoute:  0,
  timestamp:    new Date().toISOString(),
  // PID state — keys confirmed from fix-wifi.sh DB writes
  pidKp:        800,
  pidKi:        50,
  pidKd:        300,
  pidSignal:    0,
  pidIError:    0,
  pidPrevError: 0,
};

let gitUpdateAvailable = false;
let localSha  = "";
let remoteSha = "";

// ── DB helper ─────────────────────────────────────────────────────────────────
const dbGet = (key: string, fallback: string): string => {
  if (!fs.existsSync(DB_FILE)) return fallback;
  try {
    return execSync(`sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='${key}';"`,
      { timeout: 1000, encoding: 'utf8' }).trim() || fallback;
  } catch { return fallback; }
};

const dbSet = (key: string, value: string) => {
  const ts = new Date().toISOString();
  execSync(`sqlite3 "${DB_FILE}" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('${key}', '${value}', '${ts}');"`);
};

// ── runCommand — stdout/stderr → log file only ────────────────────────────────
const runCommand = (cmd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [], { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout?.on('data', d => d.toString().split('\n')
      .forEach((l: string) => { if (l.trim()) fileOnly(`[OUT] ${l}`); }));
    child.stderr?.on('data', d => d.toString().split('\n')
      .forEach((l: string) => { if (l.trim()) fileOnly(`[ERR] ${l}`); }));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });

// ── startMonitor — child output → log file fd, never console ─────────────────
const startMonitor = () => {
  fileOnly('Starting background monitor');
  let fd: number;
  try { fd = fs.openSync(LOG_FILE, 'a'); } catch { fd = 2; }
  const child = spawn(
    `sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --monitor --workspace "${WORKSPACE_DIR}"`,
    [], { shell: true, stdio: ['inherit', fd, fd] }
  );
  child.on('close', code => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    fileOnly(`Monitor exited (${code}) — restarting in 5s`);
    setTimeout(startMonitor, 5000);
  });
};

// ── rapidRepair ───────────────────────────────────────────────────────────────
const rapidRepair = async () => {
  fileOnly('Starting rapid repair...');
  try {
    const setup = path.join(WORKSPACE_DIR, "setup-system.sh");
    const fix   = path.join(WORKSPACE_DIR, "fix-wifi.sh");
    execSync(`chmod +x "${fix}" "${setup}"`);
    await runCommand(`sudo -n cp "${fix}" "${FIX_SCRIPT}"`);
    await runCommand(`sudo -n chmod +x "${FIX_SCRIPT}"`);
    await runCommand(`sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --check-only --workspace "${WORKSPACE_DIR}"`);
    fileOnly('System health verified.');
    startMonitor();
  } catch (err: any) {
    fileOnly(`Rapid repair failed: ${err.message}`);
    try {
      await runCommand(`PROJECT_ROOT="${WORKSPACE_DIR}" bash "${path.join(WORKSPACE_DIR, 'setup-system.sh')}"`);
      fileOnly('Full setup recovery completed.');
      startMonitor();
    } catch (e) { fileOnly(`CRITICAL: recovery failed: ${e}`); }
  }
};

// ── Git update detection ──────────────────────────────────────────────────────
const checkForUpdates = () => {
  try {
    execSync('git fetch origin', { cwd: WORKSPACE_DIR, timeout: 10000, stdio: 'ignore' });
    localSha  = execSync('git rev-parse HEAD',          { cwd: WORKSPACE_DIR, encoding: 'utf8' }).trim().slice(0, 7);
    remoteSha = execSync('git rev-parse origin/master', { cwd: WORKSPACE_DIR, encoding: 'utf8' }).trim().slice(0, 7);
    gitUpdateAvailable = localSha !== remoteSha;
    if (gitUpdateAvailable) fileOnly(`Update available: local=${localSha} remote=${remoteSha}`);
  } catch { /* no network — skip */ }
};

// ── API Routes ────────────────────────────────────────────────────────────────
app.get("/api/status", (_req, res) =>
  res.json({ isFixing, lastFixError, ...currentTelemetry, metricsHistory, gitUpdateAvailable, localSha, remoteSha })
);

app.get('/api/audit', async (_req, res) => {
  try {
    const logContent = fs.existsSync(LOG_FILE) ? await fs.promises.readFile(LOG_FILE, 'utf8') : "No logs.";
    let dbMilestones = "No database.";
    if (fs.existsSync(DB_FILE)) {
      try {
        dbMilestones = execSync(
          `sqlite3 -separator "|" "${DB_FILE}" "SELECT timestamp, name, details FROM milestones ORDER BY timestamp ASC;"`)
          .toString();
      } catch (e) { dbMilestones = `Error: ${e}`; }
    }
    res.json({ status: 'RECOVERY_COMPLETE', verbatimLogSnippet: logContent.slice(-8000), dbMilestones });
  } catch { res.status(200).json({ status: 'READY' }); }
});

app.post("/api/fix", async (_req, res) => {
  if (isFixing) return res.status(400).json({ error: "Fix already in progress" });
  isFixing = true; isSimulatingFault = false; lastFixError = null;
  res.json({ message: "Recovery initiated" });
  try {
    await runCommand(`sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --workspace "${WORKSPACE_DIR}" --force`);
    fileOnly('Recovery completed.');
    startMonitor();
  } catch (err: any) {
    lastFixError = err.message;
    fileOnly(`Recovery failed: ${lastFixError}`);
  } finally { isFixing = false; }
});

app.post('/api/test/fault', (_req, res) => {
  isSimulatingFault = !isSimulatingFault;
  res.json({ isSimulatingFault });
});

app.get("/api/config", (_req, res) => {
  res.json({
    kp: parseInt(dbGet('pid_kp', '800')),
    ki: parseInt(dbGet('pid_ki', '50')),
    kd: parseInt(dbGet('pid_kd', '300')),
  });
});

app.post("/api/config", (req, res) => {
  const { kp, ki, kd } = req.body;
  try {
    dbSet('pid_kp', String(kp));
    dbSet('pid_ki', String(ki));
    dbSet('pid_kd', String(kd));
    currentTelemetry.pidKp = parseInt(kp);
    currentTelemetry.pidKi = parseInt(ki);
    currentTelemetry.pidKd = parseInt(kd);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/update", async (_req, res) => {
  try {
    execSync('git pull origin master', { cwd: WORKSPACE_DIR, encoding: 'utf8' });
    execSync('npm install',            { cwd: WORKSPACE_DIR, encoding: 'utf8' });
    gitUpdateAvailable = false;
    res.json({ success: true, message: "Updated. Restart to apply." });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/rollback", (req, res) => {
  const target = req.body?.sha || 'HEAD~1';
  try {
    const result = execSync(`git reset --hard ${target}`, { cwd: WORKSPACE_DIR, encoding: 'utf8' });
    res.json({ success: true, message: `Rolled back to ${target}. Restart to apply.`, result });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  let offset = 0;
  try { if (fs.existsSync(LOG_FILE)) offset = fs.statSync(LOG_FILE).size; } catch { /* ignore */ }
  const iv = setInterval(() => {
    if (!fs.existsSync(LOG_FILE)) return;
    try {
      const stat = fs.statSync(LOG_FILE);
      if (offset > stat.size) offset = 0;
      if (stat.size <= offset) return;
      const buf = Buffer.alloc(stat.size - offset);
      const fd  = fs.openSync(LOG_FILE, 'r');
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = stat.size;
      const delta = buf.toString('utf8');
      if (delta.trim()) res.write(`data: ${JSON.stringify({ type: "log", content: delta })}\n\n`);
    } catch { /* ignore */ }
  }, 2000);
  req.on("close", () => clearInterval(iv));
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(WORKSPACE_DIR, 'dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => {
    fileOnly(`Listening on http://localhost:${PORT}`);
    rapidRepair();
    checkForUpdates();
    setInterval(checkForUpdates, 60000);

    // ── Telemetry tick ────────────────────────────────────────────────────────
    setInterval(() => {
      const ts  = new Date().toISOString();
      let signal = 0, traffic = { rx: 0, tx: 0 }, connectivity = false;
      let bkwInterface = "Unknown";
      // Per-component health matching fix-wifi.sh calculate_health() exactly:
      // ping=40, dns=30, route=30
      let healthPing = 0, healthDns = 0, healthRoute = 0;

      try {
        // Interface from DB
        bkwInterface = dbGet('bkw_interface', 'Unknown');

        // PID state from DB — fix-wifi.sh writes these during monitor loop
        currentTelemetry.pidKp      = parseInt(dbGet('pid_kp',      '800'));
        currentTelemetry.pidKi      = parseInt(dbGet('pid_ki',      '50'));
        currentTelemetry.pidKd      = parseInt(dbGet('pid_kd',      '300'));
        currentTelemetry.pidSignal  = parseInt(dbGet('pid_signal',  '0'));
        currentTelemetry.pidIError  = parseInt(dbGet('pid_i_error', '0'));
        currentTelemetry.pidPrevError = parseInt(dbGet('pid_prev_error', '0'));

        // Signal via iw
        try {
          const m = execSync(
            "iw dev | grep Interface | awk '{print $2}' | xargs -I {} iw dev {} link",
            { timeout: 2000, encoding: 'utf8' }
          ).match(/signal:\s+(-?\d+)\s+dBm/);
          if (m) signal = parseInt(m[1]);
        } catch { /* ignore */ }

        // Traffic from /proc/net/dev
        try {
          const s = execSync("cat /proc/net/dev | grep -E 'wl|wlan' || true",
            { timeout: 1000, encoding: 'utf8' }).trim().split(/\s+/);
          if (s.length > 10) traffic = { rx: parseInt(s[1]), tx: parseInt(s[9]) };
        } catch { /* ignore */ }

        // Per-component health — mirrors fix-wifi.sh calculate_health() exactly
        if (!isSimulatingFault) {
          try { execSync("ping -c 1 -W 1 8.8.8.8", { timeout: 1500 }); healthPing = 40; connectivity = true; }
          catch { healthPing = 0; connectivity = false; }
          try { execSync("getent hosts google.com", { timeout: 1500 }); healthDns = 30; }
          catch { healthDns = 0; }
          try { execSync("ip route | grep -q '^default'", { timeout: 1000 }); healthRoute = 30; }
          catch { healthRoute = 0; }
        } else {
          signal = -99; traffic = { rx: 0, tx: 0 };
        }
      } catch { /* ignore */ }

      const health = healthPing + healthDns + healthRoute;

      currentTelemetry = {
        ...currentTelemetry,
        signal, traffic, connectivity,
        bkwInterface,
        health, healthPing, healthDns, healthRoute,
        timestamp: ts,
      };

      metricsHistory.push({ timestamp: new Date().toLocaleTimeString(), signal, ...traffic });
      if (metricsHistory.length > 50) metricsHistory.shift();

      fileOnly(`tick signal=${signal} conn=${connectivity} health=${health} ping=${healthPing} dns=${healthDns} route=${healthRoute}`);

    }, 2000);

    // ── Start blessed-contrib dashboard after first tick (100ms delay) ────────
    // Gives the tick one cycle to populate currentTelemetry before rendering.
    setTimeout(() => {
      startDashboard(() => ({
        ...currentTelemetry,
        isFixing,
        gitUpdateAvailable,
        localSha,
        remoteSha,
        metricsHistory,
        logFile: LOG_FILE,
        dbFile:  DB_FILE,
      }));
    }, 100);
  });
}

startServer();
