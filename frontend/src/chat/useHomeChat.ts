import { useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../../contracts/chat.ts";
import type { CompanionAction } from "../../../contracts/companion-actions.ts";
import { ApiProblemError } from "../adapters/real-api.ts";
import { makeIdempotencyKey, type ChatClient } from "./client.ts";
import { useAppIsActive } from "../state/useAppIsActive";

const pollInterval = 1500;

export function useHomeChat(client: ChatClient | undefined, companionId: string | undefined, isActive: boolean) {
  const appActive = useAppIsActive();
  const [preview, setPreview] = useState<{ chatId?: string; messages: ChatMessage[] }>({ messages: [] });
  const submit = useRef<((action: CompanionAction) => void) | undefined>(undefined);

  useLayoutEffect(() => {
    setPreview({ messages: [] });
  }, [client, companionId]);

  useLayoutEffect(() => {
    if (!client || !companionId || !isActive || !appActive) return;

    let active = true;
    let chatId: string | undefined;
    let fetching = false;
    let refreshRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let remaining = 60;
    const retries = new Set<ReturnType<typeof setTimeout>>();

    const refresh = async () => {
      if (!active || !chatId || fetching) return;
      clearTimeout(timer);
      fetching = true;
      refreshRequested = false;
      let replying = false;
      try {
        const page = await client.getChat(chatId);
        if (!active) return;
        if (!page.chat.direct || !page.chat.members.some(member => member.companionId === companionId)) return;
        replying = page.chat.replying;
        setPreview({
          chatId,
          messages: page.items
            .filter(message => message.status === "SENT" && message.body !== null && !message.action)
            .slice(0, 2).reverse(),
        });
      } catch (error) {
        replying = !(error instanceof ApiProblemError) || error.status >= 500;
        if (active && error instanceof ApiProblemError && error.status === 404 && !refreshRequested) {
          chatId = undefined;
          setPreview({ messages: [] });
        }
      } finally {
        fetching = false;
        if (active && refreshRequested) void refresh();
        else if (active && replying && remaining-- > 0) timer = setTimeout(() => void refresh(), pollInterval);
      }
    };

    void client.listChats().then(({ items }) => {
      if (!active || chatId) return;
      chatId = items.find(chat => chat.direct && chat.members.some(member => member.companionId === companionId))?.id;
      if (chatId) void refresh();
      else setPreview({ messages: [] });
    }).catch(() => {
      // A transient preview failure should leave the interactive room usable.
    });

    submit.current = action => {
      const key = makeIdempotencyKey("home-action");
      const send = async (attempt: number) => {
        try {
          const result = await client.sendAction(companionId, action, key);
          if (!active) return;
          chatId = result.chatId;
          setPreview(current => ({ ...current, chatId: result.chatId }));
          remaining = 60;
          refreshRequested = true;
          void refresh();
        } catch (error) {
          if (!active || attempt === 2 || (error instanceof ApiProblemError && error.status < 500)) return;
          const retry = setTimeout(() => {
            retries.delete(retry);
            void send(attempt + 1);
          }, 500 * (attempt + 1));
          retries.add(retry);
        }
      };
      void send(0);
    };

    return () => {
      active = false;
      submit.current = undefined;
      clearTimeout(timer);
      retries.forEach(retry => clearTimeout(retry));
    };
  }, [appActive, client, companionId, isActive]);

  return { ...preview, submit };
}
