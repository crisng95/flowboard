import { create } from "zustand";
import {
  getActiveChatRun,
  listChatMessages,
  sendChatMessage,
  type ChatAttachmentDTO,
  type ChatMessageDTO,
  type ChatRunDTO,
  type PlanDTO,
} from "../api/client";
import { useBoardStore } from "./board";

interface ChatState {
  boardId: number | null;
  messages: ChatMessageDTO[];
  // Sidecar map: assistant message id → plan. Legacy — kept so the
  // (unmounted) ChatSidebar still compiles. The dock flow never sets it:
  // POST /api/chat returns {user, run_id} and the agent writes its own
  // assistant message when the run finishes.
  plans: Record<number, PlanDTO>;
  loading: boolean;
  // True while the message POST (or a legacy plan reply) is in flight.
  pending: boolean;
  error: string | null;
  // Non-null while the server-side agent loop is working on this board.
  activeRun: ChatRunDTO | null;
  // Set when the last run finished with status "failed".
  runError: string | null;

  loadChat(boardId: number): Promise<void>;
  sendMessage(
    message: string,
    mentions: string[],
    attachmentIds?: number[],
    previews?: Array<{ mime: string; url: string }>,
  ): Promise<void>;
  pollRun(): void;
  stopPolling(): void;
  notifyError(msg: string): void;
  clearError(): void;
}

// Monotonic counter for optimistic temp IDs; two sends in the same millisecond
// used to collide on `-Date.now()`.
let _tempSeq = 0;

let _pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;

export const useChatStore = create<ChatState>((set, get) => ({
  boardId: null,
  messages: [],
  plans: {},
  loading: false,
  pending: false,
  error: null,
  activeRun: null,
  runError: null,

  async loadChat(boardId: number) {
    get().stopPolling();
    set({ boardId, loading: true, error: null, activeRun: null, runError: null });
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

  async sendMessage(message, mentions, attachmentIds = [], previews = []) {
    const { boardId, messages } = get();
    if (boardId === null) return;

    const tempId = -(++_tempSeq);
    const optimisticAttachments: ChatAttachmentDTO[] = previews.map((p, i) => ({
      id: tempId * 100 - i,
      asset_id: tempId * 100 - i,
      mime: p.mime,
      url: p.url,
    }));
    const optimisticMsg: ChatMessageDTO = {
      id: tempId,
      board_id: boardId,
      role: "user",
      content: message,
      mentions,
      attachments: optimisticAttachments,
      created_at: new Date().toISOString(),
    };

    set({
      messages: [...messages, optimisticMsg],
      pending: true,
      runError: null,
    });

    try {
      const response = await sendChatMessage(
        boardId,
        message,
        mentions,
        attachmentIds,
      );
      set((s) => ({
        messages: s.messages.map((m) => (m.id === tempId ? response.user : m)),
        pending: false,
        activeRun: {
          id: response.run_id,
          board_id: boardId,
          user_message_id: response.user.id,
          status: "running",
          error: null,
          created_at: new Date().toISOString(),
          finished_at: null,
        },
      }));
      get().pollRun();
    } catch (err) {
      set((s) => ({
        messages: s.messages.filter((m) => m.id !== tempId),
        pending: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  },

  pollRun() {
    if (_pollTimer !== null) clearInterval(_pollTimer);
    _pollTimer = setInterval(async () => {
      const { boardId } = get();
      if (boardId === null) {
        get().stopPolling();
        return;
      }
      let run: ChatRunDTO | null;
      try {
        run = await getActiveChatRun(boardId);
      } catch {
        // Network blip — keep the previous activeRun and try next tick.
        return;
      }
      if (run === null || run.status !== "running") {
        get().stopPolling();
        set({
          activeRun: null,
          runError:
            run?.status === "failed"
              ? (run.error ?? "Agent run failed")
              : null,
        });
        // Run settled: pick up the assistant message the agent wrote and
        // refresh the canvas with whatever nodes it created.
        await get().loadChat(boardId);
        try {
          await useBoardStore.getState().refreshBoardState();
        } catch {
          // Board refresh is best-effort here; the board store surfaces
          // its own errors.
        }
        return;
      }
      set({ activeRun: run });
    }, POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (_pollTimer !== null) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  },

  notifyError(msg: string) {
    set({ error: msg });
  },

  clearError() {
    set({ error: null });
  },
}));
