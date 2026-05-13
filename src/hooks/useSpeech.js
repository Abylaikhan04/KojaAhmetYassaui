import { useState, useCallback, useRef, useEffect } from 'react';

const _API_BASE = import.meta.env.VITE_API_URL || '';
const TTS_URL = `${_API_BASE}/api/tts`;
const STT_BASE = `${_API_BASE}/api/stt`;

/* ─── In-memory blob cache (survives component remounts) ─── */
const blobCache = new Map();

async function fetchAudio(text, signal) {
  const key = text.trim();
  if (!key) return null;
  if (blobCache.has(key)) return blobCache.get(key);

  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: key }),
    signal,
  });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobCache.set(key, url);
  return url;
}

/* ─── Web Speech API TTS (works for any language) ─── */

// Cache the best voice per language so we don't re-scan voice list on every call
const voiceCache = new Map();

// Promise that resolves once the browser has populated the full voice list
// (Online/Neural voices arrive asynchronously — we MUST wait before picking)
let _voicesReadyResolve;
let voicesReadyPromise = new Promise(r => { _voicesReadyResolve = r; });

if (typeof window !== 'undefined' && window.speechSynthesis) {
  const tryResolve = () => {
    const v = window.speechSynthesis.getVoices();
    if (v.length) {
      _voicesReadyResolve(v);
      voiceCache.clear();
    }
  };
  // Trigger immediately (Chrome desktop sometimes has voices right away)
  tryResolve();
  window.speechSynthesis.onvoiceschanged = () => {
    // Re-create promise so next call after a voice-list refresh also waits correctly
    voicesReadyPromise = Promise.resolve(window.speechSynthesis.getVoices());
    voiceCache.clear();
    tryResolve();
  };
  // Safety fallback — never leave callers hanging
  setTimeout(() => _voicesReadyResolve(window.speechSynthesis.getVoices()), 3000);
}

// Voice quality scoring — higher = better, more natural
function scoreVoice(voice, langCode) {
  const name = voice.name.toLowerCase();
  let score = 0;

  // Tier 1 — Microsoft Online Natural (neural, cloud-rendered, best quality on Windows/Edge)
  if (/microsoft.*online.*natural/i.test(name)) score += 500;
  // Tier 2 — any Neural / Natural / Premium / Enhanced / WaveNet / Studio voice
  if (/neural|natural|premium|enhanced|wavenet|studio/i.test(name)) score += 200;
  // Tier 3 — any Microsoft voice (offline but still good on Windows)
  if (/microsoft/i.test(name)) score += 50;
  // Bonus for known high-quality Russian names (Irina, Svetlana — Microsoft Online Natural)
  if (/irina|svetlana|dmitri|milena|katya|tatyana/i.test(name)) score += 80;
  // Google voices — OK but slightly robotic
  if (/google/i.test(name)) score += 30;
  // Exact lang match wins over prefix match
  if (voice.lang.toLowerCase() === langCode) score += 10;
  // Online (cloud) voices are preferred over local even without "Natural" in name
  if (!voice.localService) score += 15;

  return score;
}

function pickBestVoice(voices, langCode) {
  if (voiceCache.has(langCode)) return voiceCache.get(langCode);

  const prefix = langCode.split('-')[0];
  const candidates = voices.filter(v => v.lang.toLowerCase().startsWith(prefix));
  if (!candidates.length) return null;

  candidates.sort((a, b) => scoreVoice(b, langCode) - scoreVoice(a, langCode));
  const best = candidates[0];
  voiceCache.set(langCode, best);
  return best;
}

async function speakWebSpeech(text, langCode = 'ru-RU') {
  return new Promise(async (resolve) => {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = langCode;

    // Wait for the full voice list (including cloud/neural voices) before picking
    const voices = await voicesReadyPromise;
    const best = pickBestVoice(voices, langCode.toLowerCase());
    if (best) utt.voice = best;

    // Natural prosody: slightly slower rate sounds cleaner, neutral pitch avoids the robot effect
    utt.rate = 0.92;
    utt.pitch = 1.0;
    utt.volume = 1.0;
    utt.onend = () => resolve();
    utt.onerror = () => resolve();
    window.speechSynthesis.speak(utt);
  });
}

function stopWebSpeech() {
  window.speechSynthesis.cancel();
}

/** Split text into sentence-like chunks for streaming playback */
function splitChunks(text) {
  const parts = text.match(/[^.!?]+[.!?]+[\s)»"]*/g);
  if (!parts || parts.length === 0) return [text.trim()];
  const chunks = parts.map(s => s.trim()).filter(Boolean);
  const consumed = parts.join('').length;
  const leftover = text.slice(consumed).trim();
  if (leftover) chunks.push(leftover);
  return chunks.length ? chunks : [text.trim()];
}

/**
 * Pre-fetch phrases into the in-memory blob cache.
 * Fire-and-forget; safe to call on every component mount.
 */
export function preloadPhrases(phrases) {
  for (const p of phrases) {
    if (!p?.trim() || blobCache.has(p.trim())) continue;
    fetchAudio(p).catch(() => {});
  }
}

/** Same as preloadPhrases but returns a Promise that resolves when all fetches finish. */
export function preloadPhrasesAsync(phrases) {
  const promises = [];
  for (const p of phrases) {
    if (!p?.trim() || blobCache.has(p.trim())) continue;
    promises.push(fetchAudio(p).catch(() => {}));
  }
  return Promise.all(promises);
}

/* ─── Unlock audio playback on first user gesture ─── */
let audioUnlocked = false;
const unlockCallbacks = [];

export function isAudioUnlocked() { return audioUnlocked; }

function onUnlock() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  // Play a tiny silent WAV to fully unlock the audio pipeline
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {}
  const cbs = unlockCallbacks.splice(0);
  cbs.forEach(cb => cb());
}

if (typeof document !== 'undefined') {
  const events = ['click', 'touchstart', 'touchend', 'keydown'];
  const unlock = () => {
    onUnlock();
    events.forEach(e => document.removeEventListener(e, unlock, true));
  };
  events.forEach(e => document.addEventListener(e, unlock, { once: true, capture: true }));
}

function waitForUnlock() {
  if (audioUnlocked) return Promise.resolve();
  return new Promise(resolve => unlockCallbacks.push(resolve));
}

export function useTextToSpeech() {
  const audioRef = useRef(null);
  const abortRef = useRef(null);
  const activeRef = useRef(false);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    stopWebSpeech();
  }, []);

  /** Play a blob URL or a pre-built Audio element, resolves on end */
  const playOne = useCallback(async (urlOrAudio, signal) => {
    if (!audioUnlocked) await waitForUnlock();
    if (signal?.aborted) throw new DOMException('', 'AbortError');

    return new Promise((resolve, reject) => {
      const audio = typeof urlOrAudio === 'string' ? new Audio(urlOrAudio) : urlOrAudio;
      audioRef.current = audio;

      const onAbort = () => {
        audio.pause();
        audio.src = '';
        reject(new DOMException('', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        audioRef.current = null;
      };
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); resolve(); };

      const doPlay = () => {
        audio.play().catch(err => {
          if (err.name === 'NotAllowedError') {
            waitForUnlock().then(() => {
              if (signal?.aborted) { cleanup(); reject(new DOMException('', 'AbortError')); return; }
              audio.play().catch(e => { cleanup(); reject(e); });
            });
          } else {
            cleanup(); reject(err);
          }
        });
      };

      // Wait for audio to be fully buffered before playing to prevent stuttering
      if (audio.readyState >= 4) { // HAVE_ENOUGH_DATA
        doPlay();
      } else {
        audio.addEventListener('canplaythrough', () => doPlay(), { once: true });
        // If the audio element doesn't have a src yet or loading hasn't started, trigger it
        if (typeof urlOrAudio === 'string' && !audio.src) audio.src = urlOrAudio;
      }
    });
  }, []);

  /**
   * STATIC PATH — single fetch + play.
   * lang='ru' → Web Speech API.
   * lang='kk' (default) → Yandex.
   * options.webSpeech=true → force Web Speech (e.g. audio guide).
   */
  const speak = useCallback(async (text, onEnd, lang, options = {}) => {
    stop();
    if (!text?.trim()) { onEnd?.(); return; }

    // Web Speech path: Russian always, or explicitly requested (audio guide)
    if (lang === 'ru' || options.webSpeech) {
      const langCode = lang === 'ru' ? 'ru-RU' : 'kk-KZ';
      activeRef.current = true;
      try {
        await speakWebSpeech(text, langCode);
        if (activeRef.current) onEnd?.();
      } catch { onEnd?.(); }
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    activeRef.current = true;

    try {
      const url = await fetchAudio(text, ctrl.signal);
      if (!activeRef.current) return;
      await playOne(url, ctrl.signal);
      if (activeRef.current) onEnd?.();
    } catch (err) {
      if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') { console.error('speak:', err); onEnd?.(); }
    }
  }, [stop, playOne]);

  /**
   * DYNAMIC PATH — parallel fetch + pre-buffered sequential playback.
   * lang='ru' or options.webSpeech → Web Speech API.
   */
  const speakStream = useCallback(async (text, onEnd, lang, options = {}) => {
    stop();
    if (!text?.trim()) { onEnd?.(); return; }

    // Web Speech path
    if (lang === 'ru' || options.webSpeech) {
      const langCode = lang === 'ru' ? 'ru-RU' : 'kk-KZ';
      activeRef.current = true;
      const chunks = splitChunks(text);
      for (const chunk of chunks) {
        if (!activeRef.current) return;
        await speakWebSpeech(chunk, langCode);
      }
      if (activeRef.current) onEnd?.();
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    activeRef.current = true;

    const chunks = splitChunks(text);

    if (chunks.length <= 1) {
      try {
        const url = await fetchAudio(chunks[0] ?? text.trim(), ctrl.signal);
        if (!activeRef.current) return;
        await playOne(url, ctrl.signal);
        if (activeRef.current) onEnd?.();
      } catch (err) {
        if (err.name !== 'AbortError') { console.error('speakStream:', err); onEnd?.(); }
      }
      return;
    }

    // Fire all chunk fetches in parallel.
    // As each URL arrives, immediately create + preload an Audio element
    // so it is buffered/decoded BEFORE its turn — eliminating the startup gap.
    const audioPromises = chunks.map(chunk =>
      fetchAudio(chunk, ctrl.signal)
        .then(url => {
          if (!url || !activeRef.current) return null;
          const a = new Audio(url);
          a.preload = 'auto';
          a.load(); // buffer while previous phrase is playing
          return a;
        })
        .catch(() => null)
    );

    for (let i = 0; i < audioPromises.length; i++) {
      try {
        if (!activeRef.current) return;
        const audio = await audioPromises[i];
        if (!audio || !activeRef.current) return;
        await playOne(audio, ctrl.signal);
      } catch (err) {
        if (err.name === 'AbortError' || !activeRef.current) return;
      }
    }
    if (activeRef.current) onEnd?.();
  }, [stop, playOne]);

  const isPlaying = useCallback(() => {
    return audioRef.current instanceof Audio && !audioRef.current.paused;
  }, []);

  useEffect(() => stop, [stop]);

  return { speak, speakStream, stop, isPlaying };
}

export function useSpeechToText() {
  const [transcript, setTranscript] = useState('');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef(null);
  const activeRef = useRef(false);       // true while user wants to keep listening
  const accumulatedRef = useRef('');     // text accumulated across restarts (no duplicates)
  const langRef = useRef('kk-KZ');

  // Yandex STT (для казахского) — запись через MediaRecorder + отправка на /api/stt
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);  // остаётся открытым на всю сессию
  const mimeTypeRef = useRef('');
  const yandexAbortRef = useRef(null);

  /** Останавливает микрофон и сбрасывает состояние */
  const releaseStream = useCallback(() => {
    const s = mediaStreamRef.current;
    mediaStreamRef.current = null;
    if (s) try { s.getTracks().forEach(t => t.stop()); } catch {}
    setIsListening(false);
  }, []);

  /**
   * Записывает один чанк (~4 сек) на уже открытом stream,
   * отправляет в Yandex, и сразу запускает следующий чанк если activeRef.current.
   */
  const recordChunk = useCallback((langCode) => {
    const stream = mediaStreamRef.current;
    if (!stream || !activeRef.current) { releaseStream(); return; }

    const mimeType = mimeTypeRef.current;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    mediaRecorderRef.current = recorder;
    const chunks = [];

    recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

    recorder.onstop = async () => {
      mediaRecorderRef.current = null;

      if (!activeRef.current) { releaseStream(); return; }

      const blob = chunks.length ? new Blob(chunks, { type: mimeType || 'audio/webm' }) : null;

      // Если записи нет или слишком коротко — просто продолжаем запись
      if (!blob || blob.size < 500) {
        recordChunk(langCode);
        return;
      }

      // Chrome пишет audio/webm;codecs=opus — Yandex STT v1 не принимает WebM.
      // Декодируем через Web Audio API → ресемплируем в 16kHz mono Int16 → LPCM.
      // Firefox пишет audio/ogg;codecs=opus → можно отправить напрямую как oggopus.
      let fetchBody = blob;
      let sttUrl = `${STT_BASE}?lang=${encodeURIComponent(langCode)}&format=oggopus`;

      if (!mimeType.includes('ogg')) {
        try {
          const arrayBuf = await blob.arrayBuffer();
          const tmpCtx = new AudioContext();
          const decoded = await tmpCtx.decodeAudioData(arrayBuf);
          tmpCtx.close();

          const TARGET_SR = 16000;
          const frames = Math.ceil(decoded.duration * TARGET_SR);
          const offline = new OfflineAudioContext(1, frames, TARGET_SR);
          const src = offline.createBufferSource();
          src.buffer = decoded;
          src.connect(offline.destination);
          src.start(0);
          const rendered = await offline.startRendering();
          const float32 = rendered.getChannelData(0);

          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }
          fetchBody = int16.buffer;
          sttUrl = `${STT_BASE}?lang=${encodeURIComponent(langCode)}&format=lpcm&sampleRateHertz=${TARGET_SR}`;
        } catch (convErr) {
          console.error('WebM→PCM conversion failed:', convErr);
          if (activeRef.current) recordChunk(langCode);
          return;
        }
      }

      // Отправляем в Yandex STT
      const ctrl = new AbortController();
      yandexAbortRef.current = ctrl;
      try {
        const res = await fetch(sttUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: fetchBody,
          signal: ctrl.signal,
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const text = (data.text || '').trim();
          if (text) {
            accumulatedRef.current = (accumulatedRef.current + ' ' + text).trim();
            setTranscript(accumulatedRef.current);
          }
        } else {
          console.error('Yandex STT failed:', res.status, await res.text().catch(() => ''));
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.error('Yandex STT error:', err);
      } finally {
        yandexAbortRef.current = null;
        // Продолжаем запись или освобождаем микрофон
        if (activeRef.current) recordChunk(langCode);
        else releaseStream();
      }
    };

    recorder.start();

    // Авто-стоп через 4 сек → onstop отправит чанк и запустит следующий
    setTimeout(() => {
      if (mediaRecorderRef.current === recorder && recorder.state === 'recording') {
        try { recorder.stop(); } catch {}
      }
    }, 4000);
  }, [releaseStream]);

  /** Запрашивает микрофон один раз и запускает цикл записи */
  const startYandexSTT = useCallback(async (langCode) => {
    // Если stream уже открыт — сразу начинаем писать
    if (mediaStreamRef.current) { recordChunk(langCode); return; }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      mimeTypeRef.current = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : '';
      setIsListening(true);
      recordChunk(langCode);
    } catch (err) {
      console.error('getUserMedia error:', err);
      activeRef.current = false;
      setIsListening(false);
      alert('Не удалось получить доступ к микрофону');
    }
  }, [recordChunk]);

  const startListening = useCallback((lang = 'kk-KZ') => {
    if (activeRef.current) return; // already running

    langRef.current = lang;
    activeRef.current = true;
    accumulatedRef.current = '';
    setTranscript('');

    // Казахский язык → Yandex STT (Web Speech не поддерживает kk-KZ корректно)
    if (lang.toLowerCase().startsWith('kk')) {
      startYandexSTT(lang);
      return;
    }

    // Русский (и прочие) → Web Speech API
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Браузер не поддерживает распознавание речи');
      activeRef.current = false;
      return;
    }

    setIsListening(true);

    function createAndStart() {
      if (!activeRef.current) return;

      const rec = new SpeechRecognition();
      rec.lang = langRef.current;
      rec.interimResults = true;
      rec.continuous = false;   // single utterance — most reliable across browsers
      rec.maxAlternatives = 1;
      recognitionRef.current = rec;

      rec.onresult = (event) => {
        let interimTranscript = '';
        let newFinal = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            newFinal += result[0].transcript.trim() + ' ';
          } else {
            interimTranscript = result[0].transcript;
          }
        }
        if (newFinal) accumulatedRef.current += newFinal;
        setTranscript((accumulatedRef.current + interimTranscript).trim());
      };

      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return; // expected — will restart
        activeRef.current = false;
        setIsListening(false);
      };

      rec.onend = () => {
        if (activeRef.current) {
          // Restart immediately for next utterance
          setTimeout(createAndStart, 50);
        } else {
          setIsListening(false);
        }
      };

      try { rec.start(); } catch {
        activeRef.current = false;
        setIsListening(false);
      }
    }

    createAndStart();
  }, [startYandexSTT]);

  const stopListening = useCallback(() => {
    activeRef.current = false;

    // Web Speech
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onend = null;
      try { rec.stop(); } catch {}
    }

    // Yandex: стопаем текущий recorder (onstop вызовет releaseStream)
    // Если recorder не активен — освобождаем stream напрямую
    const mr = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (mr && mr.state !== 'inactive') {
      try { mr.stop(); } catch {}
    } else {
      releaseStream();
    }

    // Отменяем текущий Yandex fetch
    if (yandexAbortRef.current) {
      yandexAbortRef.current.abort();
      yandexAbortRef.current = null;
    }
  }, [releaseStream]);

  const clearTranscript = useCallback(() => {
    accumulatedRef.current = '';
    setTranscript('');
  }, []);

  return { transcript, isListening, startListening, stopListening, clearTranscript };
}