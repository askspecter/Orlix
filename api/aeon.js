// Orlix — Aeon fleet bridge
// Reads a live Aeon repo's real state (aeon.yml skill registry + memory/cron-state.json
// heartbeat/dispatch log) and returns a normalized fleet snapshot for Mission Control.
//
// Config (Vercel env):
//   AEON_REPO          "owner/name"  (default: aaronjmars/aeon)
//   AEON_BRANCH        branch        (default: main)
//   AEON_GITHUB_TOKEN  optional      (private repos / higher rate limit)
//
// GET /api/aeon -> { configured, repo, branch, heartbeat, stats, agents:[...] }

const REPO_DEFAULT = 'aaronjmars/aeon';

// skill -> pack (the 68-skill catalog groups; used for coloring/labels)
const PACK = {
  autoresearch:'core', 'cost-report':'core', 'create-skill':'core', digest:'research', heartbeat:'core',
  'install-skill':'core', 'self-improve':'core', 'skill-health':'core', 'skill-repair':'core',
  'deploy-prototype':'fleet', 'distribute-tokens':'fleet', 'fleet-control':'fleet', 'spawn-instance':'fleet', 'vuln-scanner':'security',
  article:'research', 'bd-radar':'research', 'fetch-tweets':'research', 'idea-forge':'research', last30:'research', 'narrative-convergence':'research',
  'auto-merge':'dev', 'auto-workflow':'dev', changelog:'dev', 'code-health':'dev', 'ecosystem-pulse':'dev', feature:'dev',
  'fork-fleet':'dev', 'github-monitor':'dev', 'github-trending':'dev', 'inbox-triage':'dev', 'issue-triage':'dev', 'pr-review':'dev',
  'pr-triage':'dev', 'repo-scanner':'dev', 'search-skill':'dev', 'star-milestone':'dev', 'vuln-tracker':'dev', 'workflow-audit':'dev',
  'investigation-report':'security', 'investigate-report':'security', 'tx-explain':'security',
  'mention-radar':'social', 'reply-maker':'social', 'schedule-ads':'social', 'soul-builder':'social', 'write-tweet':'social',
  'action-converter':'prod', 'idea-pipeline':'prod', 'send-email':'prod', shiplog:'prod', 'strategy-builder':'prod',
  'memory-flush':'agentops', 'operator-scorecard':'agentops',
  'base-mcp':'markets', ctrl:'markets', 'defi-overview':'markets', 'fear-divergence':'markets', 'monitor-polymarket':'markets',
  'narrative-tracker':'markets', 'onchain-monitor':'markets', 'picks-tracker':'markets', 'pm-manipulation':'markets', 'pm-pulse':'markets',
  'price-alert':'markets', 'token-movers':'markets', 'token-pick':'markets', 'treasury-info':'markets', 'unlock-monitor':'markets', 'x402-monitor':'markets',
};
const packOf = n => PACK[n] || 'skill';

async function ghRaw(repo, branch, path, token) {
  // Try raw.githubusercontent first (public, no rate limit worries)
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  let r = await fetch(rawUrl, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (r && r.ok) return r.text();
  // Fallback to contents API (works for private repos with a token)
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
  r = await fetch(apiUrl, {
    headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'orlix-aeon',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (r && r.ok) return r.text();
  return null;
}

// Minimal YAML parser for the aeon.yml `skills:` block. Handles both inline flow
// maps ( name: { enabled: false, schedule: "..." } ) and nested indented maps.
function parseSkills(yml) {
  const lines = yml.split('\n');
  const skills = {};
  let inSkills = false, cur = null, curIndent = 0;
  for (const raw of lines) {
    if (/^skills:\s*$/.test(raw)) { inSkills = true; continue; }
    if (!inSkills) continue;
    if (/^\S/.test(raw) && !/^\s/.test(raw)) break;            // left the skills block
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;

    // "name: { ...inline... }"  or  "name:"  (start of nested)
    const m = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      cur = m[1]; curIndent = indent;
      const rest = m[2].trim();
      skills[cur] = { enabled: false, schedule: '', model: '', var: '' };
      if (rest.startsWith('{')) {
        // inline flow map
        const body = rest.replace(/^\{|\}$/g, '');
        body.split(',').forEach(pair => {
          const km = pair.match(/\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*/);
          if (km) skills[cur][km[1]] = clean(km[2]);
        });
      }
      continue;
    }
    // nested "    key: value" under current skill
    if (cur && indent > curIndent) {
      const km = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (km) skills[cur][km[1]] = clean(km[2]);
    }
  }
  return skills;
}
function clean(v) {
  v = (v || '').trim().replace(/^["']|["']$/g, '');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

// crude "is this cron due within the last N minutes / how stale" helper for liveness
function cronLabel(sched) {
  if (!sched || sched === 'reactive') return 'reactive';
  if (sched === 'workflow_dispatch') return 'manual';
  return sched;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  const repo = (req.query && req.query.repo) || process.env.AEON_REPO || REPO_DEFAULT;
  const branch = (req.query && req.query.branch) || process.env.AEON_BRANCH || 'main';
  const token = process.env.AEON_GITHUB_TOKEN || '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ configured: false, error: 'bad repo' });

  try {
    const [yml, stateTxt] = await Promise.all([
      ghRaw(repo, branch, 'aeon.yml', token),
      ghRaw(repo, branch, 'memory/cron-state.json', token),
    ]);
    if (!yml) return res.status(200).json({ configured: false, repo, reason: 'aeon.yml not found' });

    const skills = parseSkills(yml);
    let state = {};
    try { state = stateTxt ? JSON.parse(stateTxt) : {}; } catch { state = {}; }
    const heartbeat = state.heartbeat || null;

    const agents = Object.entries(skills).map(([name, s]) => {
      const st = state[name] || {};
      return {
        name,
        pack: packOf(name),
        enabled: s.enabled === true,
        cron: cronLabel(s.schedule),
        model: s.model || null,
        lastRun: st.last_dispatch || st.last_run || null,
        lastStatus: st.last_status || null,
        score: typeof st.last_score === 'number' ? st.last_score : null,
        history: Array.isArray(st.history) ? st.history.slice(-14) : [],
      };
    });

    const enabled = agents.filter(a => a.enabled);
    const stats = {
      total: agents.length,
      enabled: enabled.length,
      scheduled: enabled.filter(a => a.cron !== 'manual' && a.cron !== 'reactive').length,
      reactive: agents.filter(a => a.cron === 'reactive').length,
    };

    return res.status(200).json({
      configured: true, repo, branch,
      heartbeat, stats,
      // enabled first, then the rest — Mission Control shows the live fleet on top
      agents: agents.sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name)),
    });
  } catch (e) {
    return res.status(200).json({ configured: false, repo, error: e.message });
  }
};
