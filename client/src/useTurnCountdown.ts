import { useEffect, useState } from "react";

const TICK_MS = 100;

export function useTurnCountdown(remainingMs: number, turnNumber: number): number {
  const [liveRemainingMs, setLiveRemainingMs] = useState(() => Math.max(0, remainingMs));

  useEffect(() => {
    const endAt = Date.now() + remainingMs;

    const updateRemaining = (): void => {
      setLiveRemainingMs(Math.max(0, endAt - Date.now()));
    };

    updateRemaining();

    const intervalId = window.setInterval(updateRemaining, TICK_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [remainingMs, turnNumber]);

  return liveRemainingMs;
}
