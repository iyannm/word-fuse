import { RefObject, useEffect, useState } from "react";

export interface ObservedSize {
  width: number;
  height: number;
}

const EMPTY_SIZE: ObservedSize = { width: 0, height: 0 };

function readBorderBoxSize(entry: ResizeObserverEntry): ObservedSize {
  const borderBoxSize = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry.borderBoxSize;

  if (borderBoxSize) {
    return {
      width: borderBoxSize.inlineSize,
      height: borderBoxSize.blockSize,
    };
  }

  const { width, height } = entry.target.getBoundingClientRect();
  return { width, height };
}

export function useResizeObserver<T extends Element>(targetRef: RefObject<T>): ObservedSize {
  const [size, setSize] = useState<ObservedSize>(EMPTY_SIZE);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) {
      return;
    }

    const updateSize = (nextSize: ObservedSize): void => {
      setSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height ? current : nextSize,
      );
    };

    const measure = (): void => {
      const { width, height } = target.getBoundingClientRect();
      updateSize({ width, height });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      updateSize(readBorderBoxSize(entry));
    });

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [targetRef]);

  return size;
}
