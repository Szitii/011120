import { useEffect, useRef } from "react";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { ApiProblemError } from "../adapters/real-api";
import { useAppIsActive } from "../state/useAppIsActive";
import { makeIdempotencyKey, type ChatClient } from "./client";

export interface HomeActionCallbacks {
  onCompanionAction?: (action: CompanionAction) => void;
  onCompanionSpeech?: (body: string) => void;
}

export function useHomeAction(
  client: ChatClient | undefined,
  companionId: string | undefined,
  isActive: boolean,
  callbacks?: HomeActionCallbacks,
) {
  const appActive = useAppIsActive();
  const dispatch = useRef<((action: CompanionAction) => void) | undefined>(undefined);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!client || !companionId) return;
    let active = true;
    const retries = new Set<ReturnType<typeof setTimeout>>();
    const seenIds = new Set<string>();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let pollEpoch = 0;

    const clearPoll = () => {
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    };

    const pollReplies = (chatId: string, sinceIso: string, epoch: number, attempt = 0) => {
      if (!active || epoch !== pollEpoch || attempt >= 20) return;
      clearPoll();
      pollTimer = setTimeout(async () => {
        pollTimer = undefined;
        if (!active || epoch !== pollEpoch) return;
        try {
          const page = await client.getChat(chatId);
          if (!active || epoch !== pollEpoch) return;
          for (const item of [...page.items].reverse()) {
            if (item.companionId !== companionId || item.status !== "SENT") continue;
            if (item.sentAt < sinceIso || seenIds.has(item.id)) continue;
            seenIds.add(item.id);
            if (item.action) callbacksRef.current?.onCompanionAction?.(item.action);
            if (item.body) callbacksRef.current?.onCompanionSpeech?.(item.body);
          }
          if (page.chat.replying) pollReplies(chatId, sinceIso, epoch, attempt + 1);
        } catch {
          // Best-effort room sync; the chat screen remains authoritative.
        }
      }, 1500);
    };

    dispatch.current = action => {
      const key = makeIdempotencyKey("home-action");
      const send = async (attempt: number) => {
        try {
          const result = await client.sendAction(companionId, action, key);
          if (!active) return;
          seenIds.add(result.message.id);
          if (result.replying) {
            pollEpoch++;
            pollReplies(result.chatId, result.message.sentAt, pollEpoch);
          }
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
      clearPoll();
      retries.forEach(timer => clearTimeout(timer));
    };
  }, [client, companionId]);

  return (action: CompanionAction) => {
    if (isActive && appActive) dispatch.current?.(action);
  };
}
