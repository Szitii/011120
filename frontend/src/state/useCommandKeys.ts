import { useRef } from "react";
import { createCommandKey } from "../adapters/real-api";

export function useCommandKeys() {
  const keys = useRef(new Map<string, { payload: string; key: string }>());
  const forRequest = (kind: string, payload: unknown) => {
    const serialized = JSON.stringify(payload);
    const previous = keys.current.get(kind);
    if (previous?.payload === serialized) return previous.key;
    const key = createCommandKey(kind);
    keys.current.set(kind, { payload: serialized, key });
    return key;
  };
  const complete = (kind: string) => { keys.current.delete(kind); };
  return { forRequest, complete };
}
