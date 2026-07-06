// Orlix — Onchain Reputation Graph (module, not a routed function)
// A compounding trust layer for Base. Every investigation the bot runs writes
// facts here (deployer rug history, funding edges, sybil clusters, token risk),
// so Orlix REMEMBERS and cross-references instead of recomputing from scratch.
// Backed by Upstash Redis. Read via getReputation() / isKnownBad(); the Group
// Guardian and /rep command sit on top of it.

const INV = require('./_investigate.js');
const redis = INV.redis;

const now = () => Date.now();
const lc = a => (a || '').toLowerCase();

async function getW(addr) { const v = await redis('GET', 'rep:w:' + lc(addr)); try { return v ? JSON.parse(v) : null; } catch { return null; } }
async function setW(addr, obj) { await redis('SET', 'rep:w:' + lc(addr), JSON.stringify(obj)); }
async function getT(addr) { const v = await redis('GET', 'rep:t:' + lc(addr)); try { return v ? JSON.parse(v) : null; } catch { return null; } }

// Merge new facts into a wallet's record (create if new).
async function merge(addr, patch) {
  addr = lc(addr); if (!addr) return;
  const w = (await getW(addr)) || { firstSeen: now(), flags: [] };
  for (const k of ['deploys', 'dead', 'fundedBy', 'funder', 'label']) if (patch[k] != null) w[k] = patch[k];
  if (patch.clusters) w.clusters = [...new Set([...(w.clusters || []), ...patch.clusters.map(lc)])].slice(0, 30);
  w.lastSeen = now();
  await setW(addr, w);
}

// Flag a wallet (idempotent) and add it to the fast-lookup flagged set.
async function flag(addr, type, note) {
  addr = lc(addr); if (!addr || INV.isSystem(addr)) return;
  await redis('SADD', 'rep:flagged', addr);
  const w = (await getW(addr)) || { firstSeen: now() };
  w.flags = w.flags || [];
  if (!w.flags.some(f => f.type === type)) w.flags.push({ type, note, ts: now() });
  w.lastSeen = now();
  await setW(addr, w);
}
async function isFlagged(addr) { return (await redis('SISMEMBER', 'rep:flagged', lc(addr))) == 1; }

// ── Recorders: called after each investigation so the graph compounds ────────
async function recordDeployer(rap) {
  if (!rap || !rap.creator) return;
  const recent = rap.deploys || [];
  const dead = recent.filter(d => d.dead).length;
  await merge(rap.creator, { deploys: rap.totalDeploys, dead });
  const rate = recent.length ? dead / recent.length : 0;
  if (rap.totalDeploys > 3 && rate >= 0.5) await flag(rap.creator, 'serial-rugger', `${dead}/${recent.length} recent tokens dead`);
}
async function recordDossier(d) {
  if (!d || !d.token) return;
  await redis('SET', 'rep:t:' + lc(d.token), JSON.stringify({
    symbol: d.symbol, deployer: lc(d.dev?.addr), score: d.score, verdict: d.verdict,
    flags: (d.flags || []).slice(0, 6), ts: now(),
  }));
  if (d.dev?.addr) { await merge(d.dev.addr, {}); if (d.score < 45) await flag(d.dev.addr, 'risky-launch', `${d.symbol || 'token'} scored ${d.score}/100 (${d.verdict})`); }
}
async function recordTrace(res) {
  if (!res || !res.wallet) return;
  const first = (res.hops || []).find(h => h.from);
  if (first) await merge(res.wallet, { fundedBy: first.label || lc(first.from) });
}
async function recordCluster(res) {
  if (!res || !res.funder) return;
  await merge(res.wallet, { funder: lc(res.funder.addr), clusters: (res.siblings || []).map(s => s.addr) });
}

// ── Read: reputation + cross-reference against the flagged set ────────────────
async function getReputation(addr) {
  addr = lc(addr);
  const [w, t, flagged, lbl] = await Promise.all([getW(addr), getT(addr), isFlagged(addr), Promise.resolve(INV.label(addr))]);
  // count how many of this wallet's known connections are themselves flagged
  let flaggedConns = 0;
  const conns = w ? [...(w.clusters || []), w.funder].filter(Boolean) : [];
  for (const c of conns) if (await isFlagged(c)) flaggedConns++;

  if (!w && !t && !flagged && !lbl) return { addr, known: false, level: 'unrated', score: null };

  let score = 65;
  const reasons = [];
  const flags = (w?.flags) || [];
  if (lbl) { score = 90; reasons.push(`known entity: ${lbl}`); }
  if (flags.some(f => f.type === 'serial-rugger')) { score = Math.min(score, 15); reasons.push('serial rugger'); }
  if (flags.some(f => f.type === 'risky-launch')) { score -= 25; reasons.push('deployed a risky token'); }
  if (w?.dead > 0) { score -= Math.min(40, w.dead * 8); reasons.push(`${w.dead} dead token(s) deployed`); }
  if (flaggedConns > 0) { score -= Math.min(40, flaggedConns * 15); reasons.push(`${flaggedConns} flagged connection(s)`); }
  score = Math.max(0, Math.min(100, score));
  const level = lbl ? 'entity' : score >= 70 ? 'trusted' : score >= 45 ? 'neutral' : score >= 25 ? 'caution' : 'high-risk';
  return { addr, known: true, level, score, label: lbl, flags, flaggedConns, w, t };
}

// Fast check for the Group Guardian: is this token / its deployer known-bad?
async function isKnownBad(tokenOrWallet) {
  const a = lc(tokenOrWallet);
  const t = await getT(a);
  if (t && t.deployer) { const rep = await getReputation(t.deployer); if (rep.level === 'high-risk' || rep.level === 'caution') return { bad: true, reason: rep.flags?.[0]?.note || rep.level, score: rep.score, deployer: t.deployer }; }
  const rep = await getReputation(a);
  if (rep.known && (rep.level === 'high-risk' || rep.level === 'caution')) return { bad: true, reason: rep.flags?.[0]?.note || rep.level, score: rep.score };
  return { bad: false };
}

async function stats() {
  const [flagged, ] = await Promise.all([redis('SCARD', 'rep:flagged').catch(() => 0)]);
  return { flagged: Number(flagged) || 0 };
}

module.exports = {
  merge, flag, isFlagged, getReputation, isKnownBad, stats,
  recordDeployer, recordDossier, recordTrace, recordCluster,
};
