import { memo, RefObject, useId, useMemo } from "react";
import { useResizeObserver } from "./useResizeObserver";
import { useTurnCountdown } from "./useTurnCountdown";

interface BorderTimerProps {
  containerRef: RefObject<HTMLElement>;
  remainingMs: number;
  turnDurationSeconds: number;
  turnNumber: number;
}

function BorderTimerComponent(props: BorderTimerProps): JSX.Element | null {
  const size = useResizeObserver(props.containerRef);
  const liveRemainingMs = useTurnCountdown(props.remainingMs, props.turnNumber);
  const strokeId = useId().replace(/:/g, "");
  const glowId = useId().replace(/:/g, "");

  const durationMs = Math.max(1, props.turnDurationSeconds * 1000);
  const progress = Math.max(0, Math.min(1, liveRemainingMs / durationMs));

  const geometry = useMemo(() => {
    const strokeWidth = 4;
    const width = size.width;
    const height = size.height;

    if (width <= strokeWidth || height <= strokeWidth) {
      return null;
    }

    const x = strokeWidth / 2;
    const y = strokeWidth / 2;
    const rectWidth = width - strokeWidth;
    const rectHeight = height - strokeWidth;
    const radius = Math.max(0, Math.min(24, rectWidth / 2, rectHeight / 2));
    const pathLength =
      2 * (rectWidth + rectHeight - 4 * radius) + 2 * Math.PI * radius;

    return {
      strokeWidth,
      width,
      height,
      x,
      y,
      rectWidth,
      rectHeight,
      radius,
      pathLength,
    };
  }, [size.height, size.width]);

  if (!geometry) {
    return null;
  }

  const litLength = Math.max(0, progress * geometry.pathLength);

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={strokeId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4AF8FF" />
          <stop offset="60%" stopColor="#8F5BFF" />
          <stop offset="100%" stopColor="#FF9B54" />
        </linearGradient>
        <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <rect
        x={geometry.x}
        y={geometry.y}
        width={geometry.rectWidth}
        height={geometry.rectHeight}
        rx={geometry.radius}
        fill="none"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={geometry.strokeWidth}
      />

      {litLength > 0 ? (
        <>
          <rect
            x={geometry.x}
            y={geometry.y}
            width={geometry.rectWidth}
            height={geometry.rectHeight}
            rx={geometry.radius}
            fill="none"
            stroke="rgba(74,248,255,0.22)"
            strokeWidth={geometry.strokeWidth + 2}
            strokeDasharray={`${litLength} ${geometry.pathLength}`}
            strokeLinecap="round"
            filter={`url(#${glowId})`}
            opacity="0.55"
          />
          <rect
            x={geometry.x}
            y={geometry.y}
            width={geometry.rectWidth}
            height={geometry.rectHeight}
            rx={geometry.radius}
            fill="none"
            stroke={`url(#${strokeId})`}
            strokeWidth={geometry.strokeWidth}
            strokeDasharray={`${litLength} ${geometry.pathLength}`}
            strokeLinecap="round"
            filter={`url(#${glowId})`}
          />
        </>
      ) : null}
    </svg>
  );
}

const BorderTimer = memo(BorderTimerComponent);

export default BorderTimer;
