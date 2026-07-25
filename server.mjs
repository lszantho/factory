#!/usr/bin/env node
// factory serve — localhost-only HTTP server for the Factory Control UI.
// Usage: node server.mjs [port]   (default port: 3141)
// Serves the static ui/ dashboard and a handful of JSON API endpoints.
// The orchestrator stays the single brain — this file only shells out to it and reads files.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FACTORY_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(FACTORY_DIR, 'ui');
const PORT = Number(process.argv[2]) || 3141;
const HOST = '127.0.0.1'; // localhost-only — never expose this port

// ── Tick serialisation ────────────────────────────────────────────────────────
// Prevent a manual button-click and a launchd-fired tick from overlapping on state.json.
// A simple boolean is enough: ticks are short-lived and only one is meaningful at a time.
let tickInProgress = false;

// ── Config helpers ────────────────────────────────────────────────────────────

function listRepos() {
  const configDir = path.join(FACTORY_DIR, 'configs');
  return fs.readdirSync(configDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));
}

function loadConfig(repo) {
  const p = path.join(FACTORY_DIR, 'configs', `${repo}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ── MIME types for static serving ────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

// ── Response helpers ──────────────────────────────────────────────────────────

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function error(res, statusCode, message) {
  json(res, statusCode, { error: message });
}

// ── Route handlers ────────────────────────────────────────────────────────────

/** GET /api/repos — list configured repos */
function handleRepos(res) {
  try {
    json(res, 200, { repos: listRepos() });
  } catch (err) {
    error(res, 500, String(err.message));
  }
}

/** GET /api/portfolio — aggregate cross-repo portfolio status for all configured repos */
function handlePortfolio(res) {
  try {
    const repos = listRepos();
    const portfolio = repos.map((repo) => {
      const config = loadConfig(repo);
      if (!config) return null;

      let status = null;
      try {
        const raw = execFileSync(config.paths.node, [
          path.join(FACTORY_DIR, 'orchestrator.mjs'), repo, '--status', '--json'
        ], { cwd: FACTORY_DIR, encoding: 'utf-8', timeout: 60_000 });
        const jsonStart = raw.indexOf('{');
        if (jsonStart !== -1) status = JSON.parse(raw.slice(jsonStart));
      } catch (err) {
        console.error(`Status failed for ${repo}:`, err);
      }

      let dabStatus = { activeSprints: [], activeTasks: [] };
      try {
        const dabRaw = execFileSync(config.paths.node, [config.paths.dabEntry, 'status'], {
          cwd: config.repoDir, encoding: 'utf-8'
        });
        dabStatus = JSON.parse(dabRaw);
      } catch (err) {
        console.error(`Dab status failed for ${repo}:`, err);
      }

      const activeSprint = dabStatus.activeSprints?.[0] ?? null;
      const sprintTasks = dabStatus.activeTasks?.filter(t => activeSprint && t.sprint === activeSprint.id) ?? [];
      const inFlightTasks = status?.tasks ? Object.keys(status.tasks) : [];
      const currentTaskId = status?.nextTick?.taskId || inFlightTasks[0] || (sprintTasks[0]?.id ?? null);
      const currentTaskDetail = status?.tasks?.[currentTaskId] || null;

      const nextTasks = sprintTasks
        .filter(t => t.id !== currentTaskId)
        .map(t => ({ id: t.id, title: t.title }));

      return {
        repo,
        activeSprint: activeSprint ? { id: activeSprint.id, title: activeSprint.title } : null,
        progress: {
          remaining: sprintTasks.length,
          inFlight: inFlightTasks.length,
        },
        now: currentTaskId ? {
          id: currentTaskId,
          role: currentTaskDetail?.lastRole || status?.nextTick?.role || 'developer',
          sessionRunning: currentTaskDetail?.sessionRunning ?? false,
          pr: currentTaskDetail?.pr ?? null,
          action: status?.nextTick?.action || 'wait'
        } : null,
        next: nextTasks,
        nextTickMarker: status?.nextTick?.marker || 'wait',
        nextTickDescription: status?.nextTick?.description || 'No active tick'
      };
    }).filter(Boolean);

    json(res, 200, { portfolio });
  } catch (err) {
    error(res, 500, String(err.message));
  }
}

/** GET /api/status/:repo — run `orchestrator.mjs <repo> --status --json` and return parsed output */
function handleStatus(res, repo) {
  const config = loadConfig(repo);
  if (!config) return error(res, 404, `Unknown repo: ${repo}`);
  try {
    const raw = execFileSync(config.paths.node, [
      path.join(FACTORY_DIR, 'orchestrator.mjs'), repo, '--status', '--json'
    ], { cwd: FACTORY_DIR, encoding: 'utf-8', timeout: 60_000 });
    // The orchestrator may print non-JSON prefixes (git output to stderr is separate),
    // so find the first `{` to isolate the JSON payload.
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) throw new Error('No JSON in orchestrator output');
    json(res, 200, JSON.parse(raw.slice(jsonStart)));
  } catch (err) {
    error(res, 500, String(err.message ?? err));
  }
}

/** GET /api/log/:repo?limit=N — tail the JSONL decision log */
function handleLog(res, repo, searchParams) {
  const logPath = path.join(FACTORY_DIR, 'logs', `${repo}.jsonl`);
  if (!fs.existsSync(logPath)) return json(res, 200, { entries: [] });
  try {
    const limit = Math.min(Number(searchParams.get('limit') || '50'), 200);
    const lines = fs.readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .reverse() // newest first
      .map((l) => JSON.parse(l));
    json(res, 200, { entries: lines });
  } catch (err) {
    error(res, 500, String(err.message));
  }
}

/**
 * POST /api/tick/:repo — spawn a real tick and stream output back as Server-Sent Events.
 * The client receives `data: <line>` events and a final `data: [done]` event.
 */
function handleTick(req, res, repo) {
  const config = loadConfig(repo);
  if (!config) return error(res, 404, `Unknown repo: ${repo}`);

  if (tickInProgress) {
    return error(res, 409, 'A tick is already in progress. Wait for it to finish before triggering another.');
  }
  tickInProgress = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if ever proxied
  });

  const sendLine = (line) => res.write(`data: ${line}\n\n`);
  sendLine(`[tick starting for ${repo}]`);

  const child = spawn(config.paths.node, [path.join(FACTORY_DIR, 'orchestrator.mjs'), repo], {
    cwd: FACTORY_DIR,
    env: { ...process.env },
  });

  child.stdout.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach(sendLine);
  });
  child.stderr.on('data', (chunk) => {
    chunk.toString().split('\n').filter(Boolean).forEach((l) => sendLine(`[stderr] ${l}`));
  });
  child.on('close', (code) => {
    sendLine(`[done — exit code ${code}]`);
    res.end();
    tickInProgress = false;
  });
  child.on('error', (err) => {
    sendLine(`[error: ${err.message}]`);
    res.end();
    tickInProgress = false;
  });

  // If the client disconnects, kill the child to avoid orphans.
  req.on('close', () => {
    if (!child.killed) child.kill();
    tickInProgress = false;
  });
}

/**
 * GET /api/agents/:repo — this repo's own factory-dispatched processes, live from
 * `claude agents --json` via `orchestrator.mjs --agents`. Powers the Processes view.
 */
function handleAgents(res, repo) {
  const config = loadConfig(repo);
  if (!config) return error(res, 404, `Unknown repo: ${repo}`);
  try {
    const raw = execFileSync(config.paths.node, [
      path.join(FACTORY_DIR, 'orchestrator.mjs'), repo, '--agents', '--json'
    ], { cwd: FACTORY_DIR, encoding: 'utf-8', timeout: 30_000 });
    json(res, 200, JSON.parse(raw));
  } catch (err) {
    error(res, 500, String(err.message ?? err));
  }
}

/**
 * POST /api/kill/:repo — terminate a stuck session's process(es). Body: either { taskId } (kill
 * via a factory-tracked task — the in-flight-tasks card's kill button) or { sessionId } (kill an
 * agents-tracked session directly, tracked task or not — the Processes view's kill button, the
 * only path that can reach an orphan whose dispatching task no longer exists to look it up
 * through). Exactly one of the two, not both. The orchestrator is the only place the actual
 * lookup/kill/audit logic lives — this handler just shells out and relays its JSON result.
 */
function handleKill(req, res, repo) {
  const config = loadConfig(repo);
  if (!config) return error(res, 404, `Unknown repo: ${repo}`);

  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return error(res, 400, 'Invalid JSON body');
    }
    const { taskId, sessionId } = payload;
    let killFlag;
    if (taskId && typeof taskId === 'string') {
      killFlag = `--kill-session=${taskId}`;
    } else if (sessionId && typeof sessionId === 'string') {
      killFlag = `--kill-agent=${sessionId}`;
    } else {
      return error(res, 400, 'Provide exactly one of taskId or sessionId');
    }

    try {
      const raw = execFileSync(config.paths.node, [
        path.join(FACTORY_DIR, 'orchestrator.mjs'), repo, killFlag, '--source=ui', '--json'
      ], { cwd: FACTORY_DIR, encoding: 'utf-8', timeout: 30_000 });
      // The kill actions print the audit-log line first (logDecision's own console.log), then
      // their own result line last — the result is always the final line, not the first `{`.
      const lines = raw.trim().split('\n').filter(Boolean);
      const result = JSON.parse(lines[lines.length - 1]);
      json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      // A non-zero exit (set when a target pid failed to die) makes execFileSync throw, but its
      // stdout — including the result line — is still on the error.
      const out = err.stdout ? String(err.stdout).trim().split('\n').filter(Boolean) : [];
      if (out.length > 0) {
        try {
          return json(res, 500, JSON.parse(out[out.length - 1]));
        } catch { /* fall through to generic error below */ }
      }
      error(res, 500, String(err.message ?? err));
    }
  });
}

/**
 * GET /api/autopilot/:repo — check whether a launchd schedule is loaded for this repo.
 * Convention: label = com.<user>.<repo>-factory, plist in ~/Library/LaunchAgents/.
 * Returns { scheduled, label, intervalSeconds, plistPath, nextRunEta }.
 * nextRunEta is a rough estimate: last decision timestamp + intervalSeconds.
 */
function handleAutopilot(res, repo) {
  try {
    // Find the first matching plist in LaunchAgents whose Label ends with `<repo>-factory`
    const launchAgentsDir = path.join(process.env.HOME, 'Library', 'LaunchAgents');
    const plistFiles = fs.readdirSync(launchAgentsDir).filter((f) =>
      f.endsWith('.plist') && f.toLowerCase().includes(repo.toLowerCase())
    );

    if (plistFiles.length === 0) {
      return json(res, 200, { scheduled: false, label: null, intervalSeconds: null, plistPath: null, nextRunEta: null });
    }

    const plistFile = plistFiles[0];
    const plistPath = path.join(launchAgentsDir, plistFile);
    const plistContent = fs.readFileSync(plistPath, 'utf-8');

    // Extract label and interval from the raw plist XML (no dep on plist parser)
    const labelMatch = plistContent.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
    const intervalMatch = plistContent.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    const label = labelMatch?.[1] ?? null;
    const intervalSeconds = intervalMatch ? Number(intervalMatch[1]) : null;

    // Check if it is actually loaded via launchctl list (label present = loaded)
    let loaded = false;
    try {
      const listing = execFileSync('launchctl', ['list'], { encoding: 'utf-8', timeout: 5_000 });
      loaded = label ? listing.includes(label) : false;
    } catch { /* launchctl unavailable — treat as unloaded */ }

    // Estimate next run: last decision time + interval
    let nextRunEta = null;
    if (loaded && intervalSeconds) {
      const logPath = path.join(FACTORY_DIR, 'logs', `${repo}.jsonl`);
      if (fs.existsSync(logPath)) {
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]);
          if (last.timestamp) {
            const eta = new Date(new Date(last.timestamp).getTime() + intervalSeconds * 1000);
            nextRunEta = eta.toISOString();
          }
        }
      }
    }

    json(res, 200, { scheduled: loaded, label, intervalSeconds, plistPath, nextRunEta });
  } catch (err) {
    // Non-fatal — return unscheduled rather than an error
    json(res, 200, { scheduled: false, label: null, intervalSeconds: null, plistPath: null, nextRunEta: null, error: String(err.message) });
  }
}

/** Serve static files from ui/ */
function handleStatic(res, urlPath) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  // Guard against path traversal
  const resolved = path.resolve(UI_DIR, '.' + safePath);
  if (!resolved.startsWith(UI_DIR)) {
    return error(res, 403, 'Forbidden');
  }
  if (!fs.existsSync(resolved)) {
    return error(res, 404, 'Not found');
  }
  const ext = path.extname(resolved);
  const mime = MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(resolved);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length });
  res.end(body);
}

/** POST /api/bugreport/:repo — create a snapshot of the system state */
function handleBugReport(req, res, repo) {
  const config = loadConfig(repo);
  if (!config) return error(res, 404, `Unknown repo: ${repo}`);

  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      return error(res, 400, 'Invalid JSON body');
    }

    try {
      // 1. dab status
      let dabStatus = null;
      try {
        const dabRaw = execFileSync(config.paths.node, [config.paths.dabEntry, 'status'], { cwd: config.repoDir, encoding: 'utf-8', timeout: 10_000 });
        dabStatus = JSON.parse(dabRaw);
      } catch (e) {
        dabStatus = { error: String(e.message) };
      }

      // 2. orchestrator status
      let orchStatus = null;
      try {
        const orchRaw = execFileSync(config.paths.node, [path.join(FACTORY_DIR, 'orchestrator.mjs'), repo, '--status', '--json'], { cwd: FACTORY_DIR, encoding: 'utf-8', timeout: 30_000 });
        const jsonStart = orchRaw.indexOf('{');
        orchStatus = jsonStart !== -1 ? JSON.parse(orchRaw.slice(jsonStart)) : { raw: orchRaw };
      } catch (e) {
        orchStatus = { error: String(e.message) };
      }

      // 3. claude agents
      let claudeStatus = null;
      try {
        const claudeRaw = execFileSync('claude', ['agents', '--json'], { encoding: 'utf-8', timeout: 10_000 });
        claudeStatus = JSON.parse(claudeRaw);
      } catch (e) {
        claudeStatus = { error: String(e.message) };
      }

      // 4. orchestrator state.json
      let stateJson = null;
      try {
        const statePath = path.join(FACTORY_DIR, 'logs', `${repo}_state.json`);
        if (fs.existsSync(statePath)) {
          stateJson = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        }
      } catch (e) {
        stateJson = { error: String(e.message) };
      }

      const report = {
        timestamp: new Date().toISOString(),
        repo,
        description: payload.description,
        uiState: payload.uiState,
        system: {
          dab: dabStatus,
          orchestrator: orchStatus,
          claude: claudeStatus,
          state: stateJson
        }
      };

      const reportDir = path.join(FACTORY_DIR, 'logs', 'bug_reports');
      if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
      const filename = `bug_report_${Date.now()}.json`;
      fs.writeFileSync(path.join(reportDir, filename), JSON.stringify(report, null, 2), 'utf-8');

      json(res, 200, { success: true, filename });
    } catch (err) {
      error(res, 500, String(err.message));
    }
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // API routes
  if (pathname === '/api/repos' && method === 'GET') {
    return handleRepos(res);
  }

  if (pathname === '/api/portfolio' && method === 'GET') {
    return handlePortfolio(res);
  }

  const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/);
  if (statusMatch && method === 'GET') {
    return handleStatus(res, statusMatch[1]);
  }

  const logMatch = pathname.match(/^\/api\/log\/([^/]+)$/);
  if (logMatch && method === 'GET') {
    return handleLog(res, logMatch[1], url.searchParams);
  }

  const tickMatch = pathname.match(/^\/api\/tick\/([^/]+)$/);
  if (tickMatch && method === 'POST') {
    return handleTick(req, res, tickMatch[1]);
  }

  const autopilotMatch = pathname.match(/^\/api\/autopilot\/([^/]+)$/);
  if (autopilotMatch && method === 'GET') {
    return handleAutopilot(res, autopilotMatch[1]);
  }

  const killMatch = pathname.match(/^\/api\/kill\/([^/]+)$/);
  if (killMatch && method === 'POST') {
    return handleKill(req, res, killMatch[1]);
  }

  const agentsMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentsMatch && method === 'GET') {
    return handleAgents(res, agentsMatch[1]);
  }

  const bugReportMatch = pathname.match(/^\/api\/bugreport\/([^/]+)$/);
  if (bugReportMatch && method === 'POST') {
    return handleBugReport(req, res, bugReportMatch[1]);
  }

  // Static files (dashboard)
  if (method === 'GET') {
    return handleStatic(res, pathname);
  }

  error(res, 405, 'Method not allowed');
});

server.listen(PORT, HOST, () => {
  console.log(`Factory UI serving at http://${HOST}:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log('Press Ctrl-C to stop.');
});
