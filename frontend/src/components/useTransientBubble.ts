import { useEffect, useRef, useState } from "react";

export function useTransientBubble() {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function show(next: string) {
    clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => setText(null), 2500);
  }

  return [text, show] as const;
}
