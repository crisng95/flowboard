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
  agentSessionIdByBoard: Record<number, string>;
  turnNumberByBoard: Record<number, number>;
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
const CHAT_SESSION_KEY = "flowboard.chat.agentSessionIdByBoard";
const CHAT_TURN_KEY = "flowboard.chat.turnNumberByBoard";

function loadBoardMap<T>(key: string): Record<number, T> {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    const out: Record<number, T> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number.parseInt(k, 10);
      if (Number.isFinite(n)) out[n] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persistBoardMap<T>(key: string, value: Record<number, T>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // non-fatal: lose session continuity on reload
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  boardId: null,
  messages: [],
  plans: {},
  agentSessionIdByBoard: loadBoardMap<string>(CHAT_SESSION_KEY),
  turnNumberByBoard: loadBoardMap<number>(CHAT_TURN_KEY),
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
    const {
      boardId,
      messages,
      agentSessionIdByBoard,
      turnNumberByBoard,
    } = get();
    if (boardId === null) return;
    const currentSessionId = agentSessionIdByBoard[boardId] ?? null;
    const currentTurnNumber = turnNumberByBoard[boardId] ?? 1;

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
      const response = await sendChatMessage(boardId, message, mentions, {
        agentSessionId: currentSessionId,
        turnNumber: currentTurnNumber,
      });
      set((s) => ({
        messages: [
          ...s.messages.filter((m) => m.id !== tempId),
          response.user,
          response.assistant,
        ],
        plans: response.plan
          ? { ...s.plans, [response.assistant.id]: response.plan }
          : s.plans,
        agentSessionIdByBoard: response.chatProvider === "omni" && response.agentSessionId
          ? { ...s.agentSessionIdByBoard, [boardId]: response.agentSessionId }
          : s.agentSessionIdByBoard,
        turnNumberByBoard: response.chatProvider === "omni"
          ? {
              ...s.turnNumberByBoard,
              [boardId]: (response.turnNumber ?? currentTurnNumber) + 1,
            }
          : s.turnNumberByBoard,
        pending: false,
      }));
      const next = get();
      persistBoardMap(CHAT_SESSION_KEY, next.agentSessionIdByBoard);
      persistBoardMap(CHAT_TURN_KEY, next.turnNumberByBoard);
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
