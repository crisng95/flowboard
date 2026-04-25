import { useEffect, useRef } from "react";
import { useBoardStore } from "../store/board";
import { useChatStore } from "../store/chat";
import { useGenerationStore } from "../store/generation";

export function Toaster() {
  const boardError = useBoardStore((s) => s.error);
  const chatError = useChatStore((s) => s.error);
  const genError = useGenerationStore((s) => s.error);
  const clearBoardError = useBoardStore((s) => s.clearError);
  const clearChatError = useChatStore((s) => s.clearError);
  const clearGenError = useGenerationStore((s) => s.clearError);

  // Priority: chat > generation > board
  const error = chatError ?? genError ?? boardError;
  const clearError =
    chatError !== null ? clearChatError : genError !== null ? clearGenError : clearBoardError;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!error) return;

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      clearError();
      timerRef.current = null;
    }, 5000);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [error, clearError]);

  if (!error) return null;

  return (
    <div className="toaster" role="alert" aria-live="assertive">
      <div className="toaster__body">
        <span className="toaster__icon" aria-hidden="true">!</span>
        <span className="toaster__msg">{error}</span>
        <button
          className="toaster__close"
          onClick={clearError}
          aria-label="Dismiss error"
        >
          ×
        </button>
      </div>
    </div>
  );
}
