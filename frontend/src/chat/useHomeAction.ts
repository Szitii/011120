import { useEffect, useRef } from "react";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { ApiProblemError } from "../adapters/real-api";
import { useAppIsActive } from "../state/useAppIsActive";
import { makeIdempotencyKey, type ChatClient } from "./client";

export function useHomeAction(client: ChatClient | undefined, companionId: string | undefined, isActive: boolean) {
  const appActive = useAppIsActive();
  const dispatch = useRef<((action: CompanionAction) => void) | undefined>(undefined);

  useEffect(() => {
    if (!client || !companionId) return;
    let active = true;
    const retries = new Set<ReturnType<typeof setTimeout>>();
    dispatch.current = action => {
      const key = makeIdempotencyKey("home-action");
      const send = async (attempt: number) => {
        try {
          await client.sendAction(companionId, action, key);
        } catch (error) {
          if (!active || attempt === 2 || (error instanceof ApiProblemError && error.status < 500)) return;
          const timer = setTimeout(() => {
            retries.delete(timer);
            if (active) void send(attempt + 1);
          }, 500 * (attempt + 1));
          retries.add(timer);
        }
      };
      void send(0);
    };
    return () => {
      active = false;
      dispatch.current = undefined;
      retries.forEach(timer => clearTimeout(timer));
    };
  }, [client, companionId]);

  return (action: CompanionAction) => {
    if (isActive && appActive) dispatch.current?.(action);
  };
}
