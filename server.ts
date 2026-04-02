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

const fileOnly = (msg: string) => {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `[SERVER ${ts}] ${msg}\n`); } catch { /* ignore */ }
};

const log = (msg: string) => {
  const ts   = new Date().toISOString();
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

let isFixing          = false;
let isSimulatingFault = false;
let lastFixError: string | null = null;
const metricsHistory: { timestamp: string; signal: number; rx: number; tx: number }[] = [];

let currentTelemetry = {
  signal:       0,
  traffic:      { rx: 0, tx: 0 },
  connectivity: false,
  bkwInterface: "Unknown",
  health:       0,
  healthPing:   0,
  healthDns:    0,
  healthRoute:  0,
  timestamp:    new Date().toISOString(),
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

const dbGet = (key: string, fallback: string): string => {
  if (!fs.existsSync(DB_FILE)) return fallback;
  try {
    return execSync(
      `sqlite3 "${DB_FILE}" "SELECT value FROM config WHERE key='${key}';"`,
      { timeout: 1000, encoding: 'utf8' }
    ).trim() || fallback;
  } catch { return fallback; }
};

// runCommand: used for setup/repair — pipes to log file only
const runCommand = (cmd: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [], { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout?.on('data', d => d.toString().split('\n')
      .forEach((l: string) => { if (l.trim()) fileOnly(`[OUT] ${l}`); }));
    child.stderr?.on('data', d => d.toString().split('\n')
      .forEach((l: string) => { if (l.trim()) fileOnly(`[ERR] ${l}`); }));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });

// FIX 2: startMonitor uses stdio:'ignore' — fix-wifi.sh already tees all
// output to LOG_FILE via `tee -a "$LOG_FILE"` (confirmed from source line
// log_and_tee() function). Previous fd-redirect approach failed because
// sudo subprocesses (ping, nmcli, modprobe) spawned by fix-wifi.sh did not
// reliably inherit the parent's file descriptor, leaking to terminal and
// corrupting the blessed screen buffer during recovery.
const startMonitor = () => {
  fileOnly('Starting background monitor');
  const child = spawn(
    `sudo -n PROJECT_ROOT="${WORKSPACE_DIR}" "${FIX_SCRIPT}" --monitor --workspace "${WORKSPACE_DIR}"`,
    [], {
      shell: true,
      stdio: 'ignore',   // fix-wifi.sh tees its own output to LOG_FILE
      detached: false,
    }
  );
  child.on('close', code => {
    fileOnly(`Monitor exited (${code}) — restarting in 5s`);
    setTimeout(startMonitor, 5000);
  });
};

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

const checkForUpdates = () => {
  try {
    execSync('git fetch origin', { cwd: WORKSPACE_DIR, timeout: 10000, stdio: 'ignore' });
    localSha  = execSync('git rev-parse HEAD',          { cwd: WORKSPACE_DIR, encoding: 'utf8' }).trim().slice(0, 7);
    remoteSha = execSync('git rev-parse origin/master', { cwd: WORKSPACE_DIR, encoding: 'utf8' }).trim().slice(0, 7);
    gitUpdateAvailable = localSha !== remoteSha;
  } catch { /* no network */ }
};

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
          `sqlite3 -separator "|" "${DB_FILE}" "SELECT timestamp, name, details FROM milestones ORDER BY timestamp ASC;"`
        ).toString();
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
    const ts = new Date().toISOString();
    const s = (k: string, v: string) =>
      execSync(`sqlite3 "${DB_FILE}" "INSERT OR REPLACE INTO config (key, value, last_updated) VALUES ('${k}', '${v}', '${ts}');"`);
    s('pid_kp', kp); s('pid_ki', ki); s('pid_kd', kd);
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

    setInterval(() => {
      const ts = new Date().toISOString();
      let signal = 0, traffic = { rx: 0, tx: 0 }, connectivity = false;
      let bkwInterface = "Unknown";
      let healthPing = 0, healthDns = 0, healthRoute = 0;

      try {
        bkwInterface = dbGet('bkw_interface', 'Unknown');
        currentTelemetry.pidKp      = parseInt(dbGet('pid_kp',       '800'));
        currentTelemetry.pidKi      = parseInt(dbGet('pid_ki',       '50'));
        currentTelemetry.pidKd      = parseInt(dbGet('pid_kd',       '300'));
        currentTelemetry.pidSignal  = parseInt(dbGet('pid_signal',   '0'));
        currentTelemetry.pidIError  = parseInt(dbGet('pid_i_error',  '0'));
        currentTelemetry.pidPrevError = parseInt(dbGet('pid_prev_error', '0'));

        try {
          const m = execSync(
            "iw dev | grep Interface | awk '{print $2}' | xargs -I {} iw dev {} link",
            { timeout: 2000, encoding: 'utf8' }
          ).match(/signal:\s+(-?\d+)\s+dBm/);
          if (m) signal = parseInt(m[1]);
        } catch { /* ignore */ }

        try {
          const s = execSync("cat /proc/net/dev | grep -E 'wl|wlan' || true",
            { timeout: 1000, encoding: 'utf8' }).trim().split(/\s+/);
          if (s.length > 10) traffic = { rx: parseInt(s[1]), tx: parseInt(s[9]) };
        } catch { /* ignore */ }

        if (!isSimulatingFault) {
          try { execSync("ping -c 1 -W 1 8.8.8.8",       { timeout: 1500 }); healthPing  = 40; connectivity = true; } catch { }
          try { execSync("getent hosts google.com",        { timeout: 1500 }); healthDns   = 30; } catch { }
          try { execSync("ip route | grep -q '^default'", { timeout: 1000 }); healthRoute = 30; } catch { }
        } else {
          signal = -99; traffic = { rx: 0, tx: 0 };
        }
      } catch { /* ignore */ }

      const health = healthPing + healthDns + healthRoute;
      currentTelemetry = {
        ...currentTelemetry,
        signal, traffic, connectivity,
        bkwInterface, health, healthPing, healthDns, healthRoute,
        timestamp: ts,
      };

      metricsHistory.push({ timestamp: new Date().toLocaleTimeString(), signal, ...traffic });
      if (metricsHistory.length > 50) metricsHistory.shift();

      fileOnly(`tick signal=${signal} conn=${connectivity} health=${health} ping=${healthPing} dns=${healthDns} route=${healthRoute}`);
    }, 2000);

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
