/**
 * Read aloud and dictation. With a speech or transcription model chosen in Settings → Media
 * models, Facet uses it; otherwise the browser's own voice and speech recognition, where present.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getApp } from '../../app';
import { markdownToPlain } from '../markdown/render';

let current: { id: string; stop: () => void } | null = null;
const listeners = new Set<() => void>();

function setCurrent(next: typeof current) {
  current = next;
  for (const l of listeners) l();
}

/** Which message is being read aloud, and a toggle to start/stop reading one. */
export function useReadAloud(): { speaking: string | null; loading: string | null; toggle: (id: string, markdown: string) => Promise<void> } {
  const [, force] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const toggle = useCallback(async (id: string, markdown: string) => {
    if (current?.id === id) {
      current.stop();
      setCurrent(null);
      return;
    }
    current?.stop();
    setCurrent(null);
    const text = markdownToPlain(markdown);
    if (!text) return;
    const abort = new AbortController();
    try {
      setLoading(id);
      const file = await getApp().media.speak(text, abort.signal);
      setLoading(null);
      if (file) {
        const url = URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mimeType }));
        const audio = new Audio(url);
        const stop = () => {
          audio.pause();
          URL.revokeObjectURL(url);
        };
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (current?.id === id) setCurrent(null);
        };
        setCurrent({ id, stop });
        await audio.play();
        return;
      }
    } catch (e) {
      setLoading(null);
      if ((e as Error)?.name === 'AbortError') return;
      throw e;
    }
    if (typeof speechSynthesis === 'undefined') throw new Error('This browser can’t read text aloud. Choose a speech model in Settings → Media models.');
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => {
      if (current?.id === id) setCurrent(null);
    };
    setCurrent({ id, stop: () => speechSynthesis.cancel() });
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }, []);
  return { speaking: current?.id ?? null, loading, toggle };
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
};

function browserRecognizer(): Recognition | null {
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  // Electron ships the API without a speech service, so it never returns results there.
  if (!Ctor || (window as any).facetDesktop) return null;
  return new Ctor() as Recognition;
}

/**
 * Dictation: records and transcribes with the chosen transcription model, or uses the browser's
 * recognizer. `onText` receives the final text to insert.
 */
export function useDictation(onText: (text: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getApp().media.dictationAvailable().then((ai) => {
      if (!cancelled) setAvailable(ai || browserRecognizer() !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    const app = getApp();
    if (await app.media.dictationAvailable()) {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        onError('Facet can’t use the microphone. Allow microphone access and try again.');
        return;
      }
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 2000) {
          setState('idle');
          return;
        }
        setState('transcribing');
        try {
          const text = await app.media.transcribe(blob);
          if (text.trim()) onText(text.trim());
        } catch (e) {
          onError((e as Error).message || 'Couldn’t transcribe the recording.');
        } finally {
          setState('idle');
        }
      };
      recorder.current = rec;
      rec.start();
      setState('recording');
      return;
    }
    const r = browserRecognizer();
    if (!r) {
      onError('Choose a transcription model in Settings → Media models to dictate here.');
      return;
    }
    r.lang = navigator.language;
    r.interimResults = false;
    r.continuous = true;
    let text = '';
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript;
    };
    r.onerror = (e: any) => {
      if (e?.error !== 'no-speech' && e?.error !== 'aborted') onError('Speech recognition stopped: ' + (e?.error ?? 'unknown error'));
    };
    r.onend = () => {
      setState('idle');
      if (text.trim()) onText(text.trim());
    };
    recognition.current = r;
    r.start();
    setState('recording');
  }, [onText, onError]);

  const stop = useCallback(() => {
    recorder.current?.state === 'recording' && recorder.current.stop();
    recognition.current?.stop();
    recorder.current = null;
    recognition.current = null;
  }, []);

  return { state, available, start, stop };
}
