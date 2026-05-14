import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTextToSpeech, preloadPhrases } from '../hooks/useSpeech';
import { Camera, Loader2, X } from 'lucide-react';
import { useLang } from '../lib/LangContext';
import { TEXTS } from '../lib/i18n';

export default function CameraRecognition() {
  const navigate = useNavigate();
  const { speak, speakStream, stop } = useTextToSpeech();
  const { lang } = useLang();
  const t = TEXTS[lang];
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const tapTimerRef = useRef(null);
  const hasSpokenRef = useRef(false);
  
  const lastTouchRef = useRef(0);
  const [tapCount, setTapCount] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(null);

  // Start camera
  useEffect(() => {
    async function startCamera() {
      try {
        // Try back camera first, fall back to any camera
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setCameraReady(true);
        }
      } catch (err) {
        const msg = err.name === 'NotAllowedError'
          ? 'Камераға рұқсат жоқ. Браузер параметрлерінде рұқсат беріңіз.'
          : err.name === 'NotReadableError'
          ? 'Камера басқа қолданба пайдаланып жатыр. Оны жауып, қайталаңыз.'
          : 'Камераны ашу мүмкін болмады: ' + (err.message || err.name);
        setCameraError(msg);
      }
    }
    startCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  useEffect(() => { if (lang === 'kk') preloadPhrases([t.cameraInstruction, t.capturing, t.analysisFailed]); }, []);

  // Speak instruction
  useEffect(() => {
    if (!hasSpokenRef.current) {
      hasSpokenRef.current = true;
      setTimeout(() => speak(t.cameraInstruction, undefined, lang), 1000);
    }
  }, [speak]);

  const captureAndAnalyze = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const video = videoRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    setIsAnalyzing(true);
    speak(t.capturing, undefined, lang);

    try {
      const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];

      const apiBase = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiBase}/api/vision/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, lang }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      const response = await res.json();
      setResult(response);
      setIsAnalyzing(false);
      speakStream(`${response.object_name}. ${response.description}`, undefined, lang);
    } catch (err) {
      console.error('Vision analysis error:', err);
      setIsAnalyzing(false);
      speak(t.analysisFailed, undefined, lang);
    }
  }, [speak]);

  const handleTap = useCallback(() => {
    if (isAnalyzing) return;

    setTapCount(prev => prev + 1);
    clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => {
      setTapCount(current => {
        if (current === 1) {
          stop();
          if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
          }
          navigate(-1);
        } else if (current >= 2) {
          setResult(null);
          captureAndAnalyze();
        }
        return 0;
      });
    }, 1000);
  }, [isAnalyzing, navigate, captureAndAnalyze, stop]);

  return (
    <div 
      className="fixed inset-0 bg-black"
      onClick={(e) => { if (Date.now() - lastTouchRef.current < 500) return; handleTap(); }}
      onTouchStart={() => { lastTouchRef.current = Date.now(); handleTap(); }}
    >
      {/* Full screen camera */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Camera error */}
      {cameraError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20 p-8">
          <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl p-8 text-center max-w-sm">
            <p className="text-white text-xl font-body mb-2">{t.cameraUnavailable}</p>
            <p className="text-white/50 text-sm font-body mb-6">{cameraError}</p>
            <button
              onClick={() => navigate(-1)}
              className="px-6 py-3 rounded-xl bg-primary text-primary-foreground font-heading font-semibold"
            >
              {t.backLabel}
            </button>
          </div>
        </div>
      )}

      {/* Overlay UI */}
      <div className="absolute inset-0 flex flex-col pointer-events-none">
        {/* Top bar */}
        <div className="flex items-center justify-between p-4 bg-gradient-to-b from-black/60 to-transparent">
          <div className="flex items-center gap-2">
            <Camera className="w-5 h-5 text-primary" />
            <span className="text-white font-heading font-semibold text-sm">{t.recognize}</span>
          </div>
          <div className="flex gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur">
              <div className="w-2 h-2 rounded-full bg-white/50" />
              <span className="text-white/60 text-xs">{t.backLabel}</span>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 backdrop-blur">
              <div className="w-2 h-2 rounded-full bg-white/50" />
              <div className="w-2 h-2 rounded-full bg-white/50" />
              <span className="text-white/60 text-xs">{t.takePhoto}</span>
            </div>
          </div>
        </div>

        {/* Center crosshair */}
        {!result && !isAnalyzing && (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-48 h-48 md:w-64 md:h-64 relative">
              <div className="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-primary rounded-tl-lg" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-2 border-r-2 border-primary rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-2 border-l-2 border-primary rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-primary rounded-br-lg" />
            </div>
          </div>
        )}

        {/* Loading */}
        <AnimatePresence>
          {isAnalyzing && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex items-center justify-center"
            >
              <div className="bg-black/70 backdrop-blur-xl rounded-2xl p-8 flex flex-col items-center gap-4">
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
                <p className="text-white text-lg font-body">{t.analyzing || 'Талдануда...'}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Result */}
        <AnimatePresence>
          {result && !isAnalyzing && (
            <motion.div
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 50 }}
              className="mt-auto p-4"
            >
              <div className="bg-black/80 backdrop-blur-2xl border border-white/10 rounded-2xl p-5 pointer-events-auto">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="font-heading font-bold text-xl text-white">{result.object_name}</h3>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setResult(null); }}
                    className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white/60 shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-white/70 text-base font-body leading-relaxed">{result.description}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom hint */}
        {!result && !isAnalyzing && (
          <div className="p-4 bg-gradient-to-t from-black/60 to-transparent">
            <p className="text-white/50 text-center text-sm font-body">
              {t.aimAtObject || 'Кесене объектіне камераны бағыттаңыз'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}