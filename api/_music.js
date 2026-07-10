// /api/music.js — generate music via Mubert TTM API (free tier)
const { checkLimits, allowedOrigin } = require('./_guard');
const CORS = {
  'Access-Control-Allow-Origin': 'https://orlixai.xyz',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

const GENRE_PROMPTS = {
  trap:   'aggressive trap beat, heavy 808 bass, trap hi-hats, dark atmospheric synths, 140 BPM',
  phonk:  'dark phonk music, Memphis rap beat, deep cowbell, distorted 808, drifting vibes',
  pop:    'upbeat pop instrumental, catchy melody, bright synths, clapping, 120 BPM',
  drill:  'UK drill beat, dark piano, rolling hi-hats, heavy bass, 140 BPM',
  hype:   'high energy hype beat, stadium anthem, heavy bass drops, fast tempo, adrenaline',
  ballad: 'emotional piano ballad, orchestral strings, melancholic melody, slow tempo, cinematic',
};

const MUBERT_API = 'https://api.mubert.com/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mubertPost(path, params, apiKey) {
  const r = await fetch(`${MUBERT_API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: path, params: { pat: apiKey, ...params } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Mubert HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 1) throw new Error(`Mubert: ${data.error?.text || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

module.exports = async (req, res) => {
  CORS['Access-Control-Allow-Origin'] = allowedOrigin(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'POST only' })); }

  // Abuse guard — paid Mubert call + up to 50s polling per request
  const _lim = await checkLimits(req, { bucket: 'music', perMin: 4, perDay: 20, globalDay: 300 });
  if (_lim.blocked) { res.writeHead(_lim.status, CORS); return res.end(JSON.stringify({ error: _lim.reason })); }

  const apiKey = process.env.MUBERT_API_KEY;
  if (!apiKey) {
    res.writeHead(503, CORS);
    return res.end(JSON.stringify({ error: 'no_key', message: 'MUBERT_API_KEY not set' }));
  }

  let body = '';
  await new Promise((resolve, reject) => { req.on('data', d => { body += d }); req.on('end', resolve); req.on('error', reject); });

  let genre, symbol;
  try { ({ genre, symbol } = JSON.parse(body)); } catch {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }

  genre = (genre || 'trap').toLowerCase();
  const prompt = (GENRE_PROMPTS[genre] || GENRE_PROMPTS.trap) + (symbol ? `, ${symbol} anthem` : '');

  try {
    // Start generation
    const startData = await mubertPost('RecordTrackTTM', {
      text: prompt,
      duration: 30,
      format: 'mp3',
      intensity: 'medium',
    }, apiKey);

    const taskId = startData.data?.tasks?.[0]?.task_id;
    if (!taskId) throw new Error('No task ID returned from Mubert');

    // Poll every 3.5s, up to 50s total
    for (let i = 0; i < 14; i++) {
      await sleep(3500);
      const pollData = await mubertPost('GetTrackTTM', { task_id: taskId }, apiKey);
      const task = pollData.data?.tasks?.[0];
      if (!task) continue;

      if (task.task_activation_status === 'Done' && task.download_link) {
        res.writeHead(200, CORS);
        return res.end(JSON.stringify({ audioUrl: task.download_link, genre }));
      }
      if (task.task_activation_status === 'Error') {
        throw new Error('Mubert task failed');
      }
    }

    throw new Error('Music generation timed out (>50s)');
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
