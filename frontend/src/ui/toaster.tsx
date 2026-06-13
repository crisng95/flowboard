import { useEffect } from "react";
import { Toaster as Sonner, toast } from "sonner";
import { useBoardStore } from "../store/board";
import { useChatStore } from "../store/chat";
import { useGenerationStore } from "../store/generation";
import { usePipelineStore } from "../store/pipeline";

export function Toaster() {
  const boardError = useBoardStore((s) => s.error);
  const chatError = useChatStore((s) => s.error);
  const genError = useGenerationStore((s) => s.error);
  const pipelineError = usePipelineStore((s) => s.error);
  
  const clearBoardError = useBoardStore((s) => s.clearError);
  const clearChatError = useChatStore((s) => s.clearError);
  const clearGenError = useGenerationStore((s) => s.clearError);
  const clearPipelineError = usePipelineStore((s) => s.clearError);

  useEffect(() => {
    if (boardError) {
      toast.error(boardError);
      clearBoardError();
    }
  }, [boardError, clearBoardError]);

  useEffect(() => {
    if (chatError) {
      toast.error(chatError);
      clearChatError();
    }
  }, [chatError, clearChatError]);

  useEffect(() => {
    if (genError) {
      toast.error(genError);
      clearGenError();
    }
  }, [genError, clearGenError]);

  useEffect(() => {
    if (pipelineError) {
      toast.error(pipelineError);
      clearPipelineError();
    }
  }, [pipelineError, clearPipelineError]);

  return (
    <Sonner
      theme="dark"
      className="sonner-toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.sonner-toaster]:bg-[#16161a] group-[.sonner-toaster]:text-white group-[.sonner-toaster]:border-white/[0.08] group-[.sonner-toaster]:shadow-2xl group-[.sonner-toaster]:rounded-xl font-sans text-xs px-4 py-3 gap-2.5",
          description: "group-[.toast]:text-white/40 text-[10px]",
          actionButton:
            "group-[.toast]:bg-accent group-[.toast]:text-white font-semibold rounded-lg",
          cancelButton:
            "group-[.toast]:bg-white/[0.08] group-[.toast]:text-white/80 font-semibold rounded-lg",
          success: "group-[.toast]:text-[#4ade80]",
          error: "group-[.toast]:text-[#f87171]",
          info: "group-[.toast]:text-accent",
        },
      }}
    />
  );
}
