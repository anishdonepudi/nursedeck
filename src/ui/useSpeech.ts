import { useCallback, useEffect, useRef, useState } from 'react';
import { toSpokenText } from '@shared/spoken.js';

/**
 * Read-aloud, using the browser's built-in speech synthesis.
 *
 * Chosen over a cloud text-to-speech service for three reasons: it is free, it
 * works offline, and it sends nothing anywhere — her study material never
 * leaves the machine. macOS and Windows both ship good voices.
 *
 * The student asked for this specifically: hearing the question lets her answer
 * out loud, which is retrieval practice rather than recognition.
 */

export interface Speech {
  supported: boolean;
  speaking: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  speak: (text: string) => void;
  stop: () => void;
  voices: { name: string; lang: string }[];
  voiceName?: string;
  setVoiceName: (name: string) => void;
}

const STORAGE_ENABLED = 'nursedeck.readAloud';
const STORAGE_VOICE = 'nursedeck.voice';

export function useSpeech(): Speech {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [enabled, setEnabledState] = useState(false);
  const [voiceName, setVoiceNameState] = useState<string>();
  const currentUtterance = useRef<SpeechSynthesisUtterance | undefined>(undefined);

  // Preferences persist per machine; losing them every launch would make the
  // feature annoying enough to stop using.
  useEffect(() => {
    try {
      setEnabledState(localStorage.getItem(STORAGE_ENABLED) === '1');
      const v = localStorage.getItem(STORAGE_VOICE);
      if (v) setVoiceNameState(v);
    } catch {
      // Private browsing or blocked storage: defaults are fine.
    }
  }, []);

  useEffect(() => {
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    // Voices load asynchronously on some platforms.
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, [synth]);

  // Speech keeps running after the window closes unless it is cancelled.
  useEffect(() => () => synth?.cancel(), [synth]);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try { localStorage.setItem(STORAGE_ENABLED, on ? '1' : '0'); } catch { /* ignore */ }
    if (!on) synth?.cancel();
  }, [synth]);

  const setVoiceName = useCallback((name: string) => {
    setVoiceNameState(name);
    try { localStorage.setItem(STORAGE_VOICE, name); } catch { /* ignore */ }
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!synth || !text.trim()) return;
      // Cancel first: queued utterances otherwise stack up as she moves through
      // cards faster than the voice reads them.
      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(toSpokenText(text));
      const chosen = voices.find((v) => v.name === voiceName);
      if (chosen) utterance.voice = chosen;
      utterance.rate = 0.95;
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);

      currentUtterance.current = utterance;
      setSpeaking(true);
      synth.speak(utterance);
    },
    [synth, voices, voiceName],
  );

  const stop = useCallback(() => {
    synth?.cancel();
    setSpeaking(false);
  }, [synth]);

  return {
    supported: !!synth,
    speaking,
    enabled,
    setEnabled,
    speak,
    stop,
    voices: voices.map((v) => ({ name: v.name, lang: v.lang })),
    ...(voiceName ? { voiceName } : {}),
    setVoiceName,
  };
}
