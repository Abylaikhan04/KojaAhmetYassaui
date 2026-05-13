import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.PORT || process.env.TTS_PORT || 3001;
const CACHE_DIR = path.join(ROOT, '.tts-cache');
const MAX_TEXT_LENGTH = 2000;

// Yandex SpeechKit config
const YANDEX_API_KEY = (process.env.YANDEX_API_KEY || '').trim();
const YANDEX_STT_API_KEY = (process.env.YANDEX_STT_API_KEY || process.env.YANDEX_API_KEY || '').trim();
const YANDEX_FOLDER_ID = (process.env.YANDEX_FOLDER_ID || 'ao72hqptk7qndagdq96a').trim();
const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';
const YANDEX_STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
console.log(`[startup] YANDEX_API_KEY length=${YANDEX_API_KEY.length}, prefix=${YANDEX_API_KEY.slice(0,6)}, folder=${YANDEX_FOLDER_ID}`);
console.log(`[startup] YANDEX_STT_API_KEY length=${YANDEX_STT_API_KEY.length}, prefix=${YANDEX_STT_API_KEY.slice(0,6)}`);

// Vision provider config (Gemini by default)
const VISION_API_KEY = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'gemini-2.5-flash';

const STATIC_PHRASES = [
  // StartPage
  'Қожа Ахмет Яссауи кесенесінің инклюзивті гидіне қош келдіңіз. Бір рет басыңыз — көрмейтіндер режімі. Екі рет басыңыз — естімейтіндер режімі. Үш рет басыңыз — көмек режімі.',
  'Сіз таңдадыңыз: Көрмейтіндер режимі',
  'Сіз таңдадыңыз: Естімейтіндер режимі',
  'Сіз таңдадыңыз: Көмек режимі',
  'Өтінеміз, бір, екі немесе үш рет басыңыз.',
  // BlindMode
  'Көрмейтіндер режімі. Бір рет басыңыз — артқа. Екі рет — менеджермен байланыс. Үш рет — камераны ашу. Төрт рет — аудио гид.',
  'Артқа оралуда',
  'Менеджерге қоңырау шалынуда',
  'Камера ашылуда',
  'Аудио гид басталуда.',
  'Аудио гид аяқталды. Бір рет басыңыз — артқа.',
  'Аудио гид тоқтатылды.',
  // CameraRecognition
  'Камера ашылды. Бір рет басыңыз — артқа. Екі рет — суретке түсіру.',
  'Сурет түсірілуде. Күте жасаңыз.',
  'Суретті талдау мүмкін болмады. Қайталап көріңіз.',
  // TextToSpeechPanel — quick phrases
  'Дәретхана қайда?',
  'Қайда жүруім керек?',
  'Шығу қайда?',
  'Менеджерді шақырыңыз.',
  'Маған көмек керек.',
  'Рахмет!',
  'Күте жасаңыз.',
  'Мен сізді түсінбеймін.',
];

// Priority groups for sequential pre-generation (group by page)
// NOTE: Audio guide sections are NOT included — they use Web Speech API on client
const PHRASE_GROUPS = [
  // Group 1 — StartPage (most important, loaded first)
  [
    'Қожа Ахмет Яссауи кесенесінің инклюзивті гидіне қош келдіңіз. Бір рет басыңыз — көрмейтіндер режімі. Екі рет басыңыз — естімейтіндер режімі. Үш рет басыңыз — көмек режімі.',
    'Сіз таңдадыңыз: Көрмейтіндер режимі',
    'Сіз таңдадыңыз: Естімейтіндер режимі',
    'Сіз таңдадыңыз: Көмек режимі',
    'Өтінеміз, бір, екі немесе үш рет басыңыз.',
  ],
  // Group 2 — BlindMode UI + Camera + Quick phrases
  [
    'Көрмейтіндер режімі. Бір рет басыңыз — артқа. Екі рет — менеджермен байланыс. Үш рет — камераны ашу. Төрт рет — аудио гід.',
    'Артқа оралуда',
    'Менеджерге қоңырау шалынуда',
    'Камера ашылуда',
    'Аудио гид басталуда.',
    'Аудио гид аяқталды. Бір рет басыңыз — артқа.',
    'Аудио гид тоқтатылды.',
    'Камера ашылды. Бір рет басыңыз — артқа. Екі рет — суретке түсіру.',
    'Сурет түсірілуде. Күте жасаңыз.',
    'Суретті талдау мүмкін болмады. Қайталап көріңіз.',
    'Дәретхана қайда?',
    'Қайда жүруім керек?',
    'Шығу қайда?',
    'Менеджерді шақырыңыз.',
    'Маған көмек керек.',
    'Рахмет!',
    'Күте жасаңыз.',
    'Мен сізді түсінбеймін.',
  ],
];

fs.mkdirSync(CACHE_DIR, { recursive: true });

// Clean cache files older than 7 days on startup
try {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const fp = path.join(CACHE_DIR, f);
    // Remove old .wav cache files (migrated to .mp3)
    if (f.endsWith('.wav') || fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  }
} catch {}

function textHash(text) {
  return crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);
}

function getCachePath(text) {
  return path.join(CACHE_DIR, `${textHash(text)}.mp3`);
}

// ─── Yandex SpeechKit TTS v3 ───
async function synthesize(text) {
  if (!YANDEX_API_KEY) throw new Error('YANDEX_API_KEY not configured');
  const clean = text.trim().replace(/[\r\n]+/g, ' ');

  const body = {
    text: clean,
    hints: [
      { voice: 'amira' },
    ],
    outputAudioSpec: {
      containerAudio: { containerAudioType: 'MP3' },
    },
    folderId: YANDEX_FOLDER_ID,
  };

  const res = await fetch(YANDEX_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Api-Key ${YANDEX_API_KEY}`,
      'Content-Type': 'application/json',
      'x-folder-id': YANDEX_FOLDER_ID,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Yandex TTS ${res.status}: ${errText}`);
  }

  // TTS v3 returns newline-delimited JSON (NDJSON) — one chunk per line
  const raw = await res.text();
  const chunks = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const b64 = obj?.result?.audioChunk?.data;
      if (b64) chunks.push(b64);
    } catch {}
  }
  if (chunks.length === 0) throw new Error('No audio in Yandex response');

  return Buffer.concat(chunks.map(b => Buffer.from(b, 'base64')));
}

async function pregenerate() {
  let generated = 0;
  let cached = 0;
  const total = PHRASE_GROUPS.reduce((n, g) => n + g.length, 0);

  for (let gi = 0; gi < PHRASE_GROUPS.length; gi++) {
    const group = PHRASE_GROUPS[gi];
    const todo = [];
    for (const phrase of group) {
      const fp = getCachePath(phrase);
      if (fs.existsSync(fp)) { cached++; continue; }
      todo.push(phrase);
    }
    if (todo.length === 0) continue;
    console.log(`Pre-gen group ${gi + 1}/${PHRASE_GROUPS.length}: ${todo.length} phrases`);
    const results = await Promise.allSettled(
      todo.map(async (phrase) => {
        const wav = await synthesize(phrase);
        fs.writeFileSync(getCachePath(phrase), wav);
        return phrase;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') generated++;
      else console.error(`Pre-gen failed:`, r.reason?.message);
    }
  }
  console.log(`Pre-generation: ${generated} new, ${cached} cached, ${total} total`);
}

const ALLOWED_ORIGINS = [
  'https://koja-axmet-yassaui.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : []),
];

// Allow all Vercel preview deployments for this project
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/koja-a[^\s.]*\.vercel\.app$/,
  /^https:\/\/[a-z0-9-]+-abon-s-projects\.vercel\.app$/,
];

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    if (ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin))) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));

// Serve built frontend in production
const distPath = path.join(ROOT, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: YANDEX_API_KEY ? 'ok' : 'degraded',
    tts: YANDEX_API_KEY ? 'yandex' : 'not configured',
    vision: !!VISION_API_KEY,
    cachedPhrases: fs.readdirSync(CACHE_DIR).length,
  });
});

// TTS endpoint — Yandex SpeechKit
app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Text is required' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` });
  }

  const cacheFile = getCachePath(text);

  // Serve from cache
  if (fs.existsSync(cacheFile)) {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Cache', 'hit');
    return fs.createReadStream(cacheFile).pipe(res);
  }

  try {
    const audio = await synthesize(text);
    fs.writeFile(cacheFile, audio, () => {});
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Cache', 'miss');
    res.send(audio);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// STT endpoint — Yandex SpeechKit (для казахского языка)
// Принимает raw-аудио (OGG_OPUS / WAV / MP3) в теле запроса.
// Параметры в query: lang (по умолчанию kk-KZ), format (oggopus|lpcm, по умолчанию oggopus)
app.post('/api/stt', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  if (!YANDEX_STT_API_KEY) {
    return res.status(503).json({ error: 'Yandex STT not configured' });
  }
  const audio = req.body;
  if (!audio || !audio.length) {
    return res.status(400).json({ error: 'Empty audio body' });
  }
  const lang = (req.query.lang || 'kk-KZ').toString();
  const format = (req.query.format || 'oggopus').toString();

  const params = new URLSearchParams({
    lang,
    folderId: YANDEX_FOLDER_ID,
    format,
  });
  if (format === 'lpcm') params.set('sampleRateHertz', (req.query.sampleRateHertz || '48000').toString());

  try {
    const apiRes = await fetch(`${YANDEX_STT_URL}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${YANDEX_STT_API_KEY}`,
        'x-folder-id': YANDEX_FOLDER_ID,
      },
      body: audio,
    });
    const data = await apiRes.json().catch(() => ({}));
    if (!apiRes.ok) {
      console.error('STT error:', apiRes.status, data);
      return res.status(apiRes.status).json({ error: data?.error_message || `STT ${apiRes.status}` });
    }
    res.json({ text: (data.result || '').trim() });
  } catch (err) {
    console.error('STT exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Vision analysis endpoint — online only (Gemini)
app.post('/api/vision/analyze', async (req, res) => {
  if (!VISION_API_KEY) {
    return res.status(503).json({
      error: 'Vision provider not configured. Set GEMINI_API_KEY in .env',
    });
  }

  const { image } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Base64 image is required' });
  }

  try {
    const requestBody = {
      contents: [{
        parts: [
          {
            text: `Сен Қазақстандағы Түркістан қаласындағы Қожа Ахмет Яссауи кесенесінің гидісің.
Бұл суретке қарап, онда не бейнеленгенін анықта.
Егер бұл кесене элементі болса (күмбез, қабырға, өрнек, қазан, жазу, декор, портал, т.б.), қазақ тілінде қысқа және нақты сипаттама бер (3-5 сөйлем).
Егер объект кесенемен байланысты емес, не көріп тұрғаныңды айт және кесене элементтеріне камераны бағыттауды ұсын.
Жауап қарапайым және түсінікті болсын.

Жауапты қатаң JSON форматында қайтар:
{"object_name": "объект атауы", "description": "сипаттама", "is_mausoleum_related": true/false}`
          },
          { inlineData: { mimeType: 'image/jpeg', data: image } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json' }
    };

    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${VISION_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`Vision API error ${apiRes.status}:`, errText);
      return res.status(apiRes.status).json({ error: `Vision API error: ${apiRes.status}` });
    }

    const data = await apiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Vision API');

    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    console.error('Vision analysis error:', err);
    res.status(500).json({ error: 'Image analysis failed' });
  }
});

// SPA fallback — serve index.html for all non-API routes
if (fs.existsSync(distPath)) {
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`TTS: ${YANDEX_API_KEY ? 'Yandex SpeechKit configured' : 'NOT configured (set YANDEX_API_KEY)'}`);
  console.log(`STT: ${YANDEX_STT_API_KEY ? 'Yandex SpeechKit configured' : 'NOT configured (set YANDEX_STT_API_KEY)'}`);
  console.log(`Cache: ${CACHE_DIR}`);
  console.log(`Vision: ${VISION_API_KEY ? 'configured' : 'NOT configured (set GEMINI_API_KEY in .env)'}`);

  // Pre-generate static phrases into disk cache
  if (YANDEX_API_KEY) {
    pregenerate().catch(err => console.error('Pre-gen error:', err.message));
  }
});
