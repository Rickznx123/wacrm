"use client";

import { useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { useRealtime } from "@/hooks/use-realtime";
import { useNotificationSounds } from "@/hooks/use-notification-sounds";
import type { Conversation, Message } from "@/types";

const EVENT_DEDUPE_WINDOW_MS = 12_000;

type EventCache = Map<string, number>;

function shouldHandleEvent(cache: EventCache, key: string, now: number): boolean {
  const last = cache.get(key);
  if (last && now - last < EVENT_DEDUPE_WINDOW_MS) {
    return false;
  }
  cache.set(key, now);

  if (cache.size > 600) {
    for (const [k, ts] of cache) {
      if (now - ts > EVENT_DEDUPE_WINDOW_MS * 2) {
        cache.delete(k);
      }
    }
  }
  return true;
}

function isHandoffEvent(event: {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Conversation;
  old: Partial<Conversation>;
}): boolean {
  if (event.eventType !== "UPDATE") return false;

  const next = event.new;
  const prev = event.old;

  const disabledNow = next.ai_autoreply_disabled === true;
  const disabledChanged =
    typeof prev.ai_autoreply_disabled === "boolean"
      ? prev.ai_autoreply_disabled !== next.ai_autoreply_disabled
      : false;

  const assignedChanged =
    typeof prev.assigned_agent_id !== "undefined"
      ? prev.assigned_agent_id !== next.assigned_agent_id
      : Boolean(next.assigned_agent_id);

  const summaryFilled = Boolean(next.ai_handoff_summary && next.ai_handoff_summary.trim());

  return (disabledNow && disabledChanged) || assignedChanged || summaryFilled;
}

function inferCustomerLabel(message: Message): string {
  const text = (message.content_text ?? "").trim();
  if (!text) return "cliente";

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) return "cliente";

  if (firstLine.length > 40) return "cliente";
  if (/\d/.test(firstLine)) return "cliente";
  if (/\b(?:rua|avenida|av\.?|endere[cç]o|bairro|refer[eê]ncia|telefone|celular|frete|taxa)\b/i.test(firstLine)) {
    return "cliente";
  }

  return firstLine;
}

export function NotificationProvider() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { playHandoff, playNewConversation, playNewMessage } = useNotificationSounds();

  const eventCacheRef = useRef<EventCache>(new Map());
  const conversationStatusRef = useRef<Map<string, Conversation["status"]>>(new Map());

  const activeConversationId = useMemo(() => {
    if (!pathname?.startsWith("/inbox")) return null;
    return searchParams.get("c");
  }, [pathname, searchParams]);

  const openConversationFromToast = useCallback(
    (conversationId: string) => {
      router.push(`/inbox?c=${conversationId}`);
    },
    [router],
  );

  const showHandoffToast = useCallback(
    (conversationId: string) => {
      const toastId = `handoff:${conversationId}`;
      toast.custom(
        () => (
          <button
            type="button"
            onClick={() => openConversationFromToast(conversationId)}
            className="w-full rounded-md bg-popover p-3 text-left"
          >
            <div className="font-medium">🛒 Novo atendimento</div>
            <div className="text-sm text-muted-foreground">
              Um pedido foi encaminhado para a equipe.
            </div>
          </button>
        ),
        { id: toastId, duration: 10_000 },
      );
    },
    [openConversationFromToast],
  );

  const showNewConversationToast = useCallback(
    (conversationId: string) => {
      const toastId = `new-conversation:${conversationId}`;
      toast.custom(
        () => (
          <button
            type="button"
            onClick={() => openConversationFromToast(conversationId)}
            className="w-full rounded-md bg-popover p-3 text-left"
          >
            <div className="font-medium">📥 Nova conversa recebida</div>
          </button>
        ),
        { id: toastId, duration: 8_000 },
      );
    },
    [openConversationFromToast],
  );

  const handleConversationEvent = useCallback(
    (event: {
      eventType: "INSERT" | "UPDATE" | "DELETE";
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      if (event.eventType === "DELETE") return;

      const now = Date.now();
      const conv = event.new;
      conversationStatusRef.current.set(conv.id, conv.status);

      if (event.eventType === "INSERT") {
        const key = `conversation-insert:${conv.id}:${conv.created_at ?? ""}`;
        if (!shouldHandleEvent(eventCacheRef.current, key, now)) return;

        playNewConversation();
        showNewConversationToast(conv.id);
        return;
      }

      if (isHandoffEvent(event)) {
        const key = [
          "handoff",
          conv.id,
          conv.updated_at ?? "",
          String(conv.ai_autoreply_disabled ?? ""),
          conv.assigned_agent_id ?? "",
          conv.ai_handoff_summary ?? "",
        ].join(":");

        if (!shouldHandleEvent(eventCacheRef.current, key, now)) return;

        playHandoff();
        showHandoffToast(conv.id);
      }
    },
    [playHandoff, playNewConversation, showHandoffToast, showNewConversationToast],
  );

  const handleMessageEvent = useCallback(
    (event: {
      eventType: "INSERT" | "UPDATE" | "DELETE";
      new: Message;
      old: Partial<Message>;
    }) => {
      if (event.eventType !== "INSERT") return;

      const message = event.new;
      if (message.sender_type !== "customer") return;

      const conversationStatus = conversationStatusRef.current.get(message.conversation_id);
      const isActiveConversation = activeConversationId === message.conversation_id;
      const isOpenConversation = conversationStatus === "open" || isActiveConversation;
      if (!isOpenConversation) return;

      const now = Date.now();
      const key = `customer-message:${message.id}`;
      if (!shouldHandleEvent(eventCacheRef.current, key, now)) return;

      playNewMessage();
      const senderLabel = inferCustomerLabel(message);
      toast.info(`💬 Nova mensagem de ${senderLabel}`, {
        id: `new-message:${message.id}`,
        duration: 5_000,
      });
    },
    [activeConversationId, playNewMessage],
  );

  useRealtime({
    channelName: "dashboard-notifications-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  return null;
}
