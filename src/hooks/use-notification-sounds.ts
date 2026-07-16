"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SoundKind = "new-conversation" | "new-message" | "handoff";

const SOUND_PATHS: Record<SoundKind, string> = {
  "new-conversation": "/sounds/new-conversation.wav",
  "new-message": "/sounds/new-message.wav",
  handoff: "/sounds/handoff.wav",
};

export function useNotificationSounds() {
  const audioRef = useRef<Partial<Record<SoundKind, HTMLAudioElement>>>({});
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    const unlock = () => {
      setUnlocked(true);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };

    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, []);

  const getAudio = useCallback((kind: SoundKind): HTMLAudioElement => {
    const cached = audioRef.current[kind];
    if (cached) return cached;

    const audio = new Audio(SOUND_PATHS[kind]);
    audio.preload = "auto";
    audioRef.current[kind] = audio;
    return audio;
  }, []);

  const play = useCallback(
    async (kind: SoundKind) => {
      if (!unlocked) return;

      try {
        const audio = getAudio(kind);
        audio.currentTime = 0;
        await audio.play();
      } catch {
        // Best-effort: browsers can still block or fail decode.
      }
    },
    [getAudio, unlocked],
  );

  const playNewConversation = useCallback(() => {
    void play("new-conversation");
  }, [play]);

  const playNewMessage = useCallback(() => {
    void play("new-message");
  }, [play]);

  const playHandoff = useCallback(() => {
    void play("handoff");
  }, [play]);

  return {
    playNewConversation,
    playNewMessage,
    playHandoff,
  };
}
