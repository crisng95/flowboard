import { create } from "zustand";
import {
  listChatMessages,
  sendChatMessage,
  type ChatMessageDTO,
  type PlanDTO,
} from "../api/client";

interface ChatState {
  boardId: number | null;
  messages: ChatMessageDTO[];
  // Sidecar map: assistant message id → plan.
  // NOTE: Historical messages loaded via GET /api/boards/:id/chat do not carry
  // plan data. Plans are only attached on new messages from POST /api/chat.
  // This is a known Run 7 limitation; Run 8 may join plans on list.
  plans: Record<number, PlanDTO>;
  loading: boolean;
  pending: boolean;
  error: string | null;

  loadChat(boardId: number): Promise<void>;
  sendMessage(message: string, mentions: string[]): Promise<void>;
  clearError(): void;
}

// Monotonic counter for optimistic temp IDs; two sends in the same millisecond
// used to collide on `-Date.now()`.
let _tempSeq = 0;

export const useChatStore = create<ChatState>((set, get) => ({
  boardId: null,
  messages: [],
  plans: {},
  loading: false,
  pending: false,
  error: null,

  async loadChat(boardId: number) {
    set({ boardId, loading: true, error: null });
    try {
      const messages = await listChatMessages(boardId);
      set({ messages, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async sendMessage(message: string, mentions: string[]) {
    const { boardId, messages } = get();
    if (boardId === null) return;

    const tempId = -(++_tempSeq);
    const optimisticMsg: ChatMessageDTO = {
      id: tempId,
      board_id: boardId,
      role: "user",
      content: message,
      mentions,
      created_at: new Date().toISOString(),
    };

    set({ messages: [...messages, optimisticMsg], pending: true });

    try {
      const response = await sendChatMessage(boardId, message, mentions);
      set((s) => ({
        messages: [
          ...s.messages.filter((m) => m.id !== tempId),
          response.user,
          response.assistant,
        ],
        plans: response.plan
          ? { ...s.plans, [response.assistant.id]: response.plan }
          : s.plans,
        pending: false,
      }));
    } catch (err) {
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== tempId),
        pending: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  },

  clearError() {
    set({ error: null });
  },
}));
