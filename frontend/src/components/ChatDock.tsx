import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useBoardStore } from "../store/board";
import { useChatStore } from "../store/chat";
import {
  getActivityList,
  getLlmProviders,
  uploadChatAttachments,
  type ChatMessageDTO,
} from "../api/client";

// ── Limits (mirror backend caps in routes/chat.py) ────────────────────────────
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Dock sizing ──────────────────────────────────────────────────────────────
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 160;
const COLLAPSED_HEIGHT = 48;

const STEP_LABEL: Record<string, string> = {
  chat_agent: "Agent",
  gen_image: "Tạo ảnh",
  gen_video: "Tạo video",
  edit_image: "Sửa ảnh",
  upload: "Upload",
  planner: "Lập kế hoạch",
};

function extractMentions(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1]);
}

interface PickedFile {
  file: File;
  preview: string;
}

function MessageRow({ msg }: { msg: ChatMessageDTO }) {
  if (msg.role === "system") {
    return (
      <div className="chat-system-divider">
        <span>{msg.content}</span>
      </div>
    );
  }
  return (
    <div
      className={`chat-bubble ${
        msg.role === "user" ? "chat-bubble--user" : "chat-bubble--assistant"
      }`}
    >
      {msg.role === "assistant" && (
        <div className="chat-agent-label">agent</div>
      )}
      {msg.attachments.length > 0 && (
        <div className="chat-dock__msg-attachments">
          {msg.attachments.map((a) => (
            <img
              key={a.id}
              className="chat-dock__msg-thumb"
              src={a.url}
              alt="đính kèm"
              loading="lazy"
            />
          ))}
        </div>
      )}
      <div className="chat-bubble__text">{msg.content}</div>
    </div>
  );
}

export function ChatDock() {
  const boardId = useBoardStore((s) => s.boardId);
  const nodes = useBoardStore((s) => s.nodes);
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const activeRun = useChatStore((s) => s.activeRun);
  const runError = useChatStore((s) => s.runError);
  const loadChat = useChatStore((s) => s.loadChat);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const notifyError = useChatStore((s) => s.notifyError);

  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [museAvailable, setMuseAvailable] = useState<boolean | null>(null);
  const [stepText, setStepText] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizingRef = useRef(false);

  // Load this board's channel on switch.
  useEffect(() => {
    if (boardId !== null) void loadChat(boardId);
  }, [boardId, loadChat]);

  // Muse worker presence — same endpoint/logic family as AiProviderBadge.
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const providers = await getLlmProviders();
        if (!alive) return;
        const muse = providers.find((p) => p.name === "muse");
        setMuseAvailable(muse ? muse.available : false);
      } catch {
        // Network blip — keep stale state, retry next tick.
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Agent-step line: latest activity while a run is active.
  useEffect(() => {
    if (!activeRun) {
      setStepText(null);
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const { items } = await getActivityList({ limit: 5 });
        if (!alive || items.length === 0) return;
        const latest = items[0];
        const label = STEP_LABEL[latest.type] ?? latest.type;
        const node = latest.node_short_id ? ` · #${latest.node_short_id}` : "";
        setStepText(`${label}${node} — ${latest.status}`);
      } catch {
        // Keep the previous step text on blips.
      }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeRun]);

  // Autoscroll to the newest message.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stepText, runError]);

  // Revoke preview object URLs on unmount.
  useEffect(() => {
    const current = files;
    return () => {
      for (const f of current) URL.revokeObjectURL(f.preview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const accepted: PickedFile[] = [];
      for (const f of Array.from(list)) {
        if (files.length + accepted.length >= MAX_FILES) {
          notifyError(`Tối đa ${MAX_FILES} ảnh mỗi tin nhắn.`);
          break;
        }
        if (!f.type.startsWith("image/")) {
          notifyError(`"${f.name}" không phải ảnh — chỉ nhận image/*.`);
          continue;
        }
        if (f.size > MAX_FILE_BYTES) {
          notifyError(`"${f.name}" quá 10 MB.`);
          continue;
        }
        accepted.push({ file: f, preview: URL.createObjectURL(f) });
      }
      if (accepted.length > 0) setFiles((prev) => [...prev, ...accepted]);
    },
    [files, notifyError],
  );

  const removeFile = useCallback((preview: string) => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.preview !== preview);
      const removed = prev.find((f) => f.preview === preview);
      if (removed) URL.revokeObjectURL(removed.preview);
      return next;
    });
  }, []);

  const canSend =
    !pending &&
    !uploading &&
    activeRun === null &&
    museAvailable === true &&
    (text.trim().length > 0 || files.length > 0);

  const handleSend = useCallback(async () => {
    if (!canSend || boardId === null) return;
    const known = new Set(nodes.map((n) => n.data.shortId));
    const mentions = extractMentions(text).filter((m) => known.has(m));

    let attachmentIds: number[] = [];
    let previews: Array<{ mime: string; url: string }> = [];
    if (files.length > 0) {
      setUploading(true);
      try {
        const result = await uploadChatAttachments(boardId, files.map((f) => f.file));
        attachmentIds = result.assets.map((a) => a.id);
        previews = result.assets.map((a) => ({ mime: a.mime, url: a.url }));
      } catch (err) {
        notifyError(err instanceof Error ? err.message : String(err));
        setUploading(false);
        return;
      }
      setUploading(false);
      for (const f of files) URL.revokeObjectURL(f.preview);
      setFiles([]);
    }

    const content =
      text.trim() || "Hãy dùng các ảnh đính kèm để thực hiện yêu cầu của tôi.";
    setText("");
    await sendMessage(content, mentions, attachmentIds, previews);
  }, [canSend, boardId, nodes, text, files, sendMessage, notifyError]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  // Drag-resize from the top edge handle.
  const onResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startY = e.clientY;
    const startH = height;
    const maxH = Math.floor(window.innerHeight * 0.7);
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const next = Math.min(
        Math.max(startH + (startY - ev.clientY), MIN_HEIGHT),
        maxH,
      );
      setHeight(next);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height]);

  if (boardId === null) return null;

  if (collapsed) {
    return (
      <div
        className="chat-dock chat-dock--collapsed"
        style={{ height: COLLAPSED_HEIGHT }}
      >
        <button
          type="button"
          className="chat-dock__bar"
          onClick={() => setCollapsed(false)}
        >
          <span className="chat-dock__bar-label">Chat — hỏi AI làm video…</span>
          {activeRun && <span className="chat-dock__bar-running">đang chạy…</span>}
          <span className="chat-dock__bar-chevron" aria-hidden="true">▲</span>
        </button>
      </div>
    );
  }

  return (
    <div className="chat-dock" style={{ height }}>
      <div
        className="chat-dock__resize-handle"
        onMouseDown={onResizeStart}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Kéo để đổi chiều cao"
      />
      <div className="chat-dock__header">
        <span className="chat-dock__title">Chat AI</span>
        <span
          className={`chat-dock__presence chat-dock__presence--${
            museAvailable === null ? "loading" : museAvailable ? "ok" : "bad"
          }`}
          title={
            museAvailable
              ? "Muse worker đang chạy"
              : "Chưa có Muse worker"
          }
        >
          {museAvailable === null ? "○" : museAvailable ? "●" : "○"} Muse
        </span>
        <button
          type="button"
          className="chat-dock__collapse-btn"
          onClick={() => setCollapsed(true)}
          aria-label="Thu gọn chat"
        >
          ▼
        </button>
      </div>

      {museAvailable === false && (
        <div className="chat-dock__notice">
          Chưa có Muse worker — chạy{" "}
          <code>python agent/scripts/muse_worker.py</code> rồi gửi lại.
        </div>
      )}

      <div className="chat-dock__messages" ref={messagesRef}>
        {messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        {activeRun && (
          <div className="chat-dock__step">
            <span className="chat-dock__step-dots" aria-hidden="true">●●●</span>
            <span>{stepText ?? "Agent đang thực hiện…"}</span>
          </div>
        )}
        {runError && (
          <div className="chat-dock__error">Lỗi: {runError}</div>
        )}
      </div>

      <div className="chat-dock__composer">
        {files.length > 0 && (
          <div className="chat-dock__attach-strip">
            {files.map((f) => (
              <div key={f.preview} className="chat-dock__thumb">
                <img src={f.preview} alt={f.file.name} />
                <button
                  type="button"
                  className="chat-dock__thumb-remove"
                  onClick={() => removeFile(f.preview)}
                  aria-label={`Gỡ ${f.file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
            <span className="chat-dock__attach-count">
              {files.length}/{MAX_FILES}
            </span>
          </div>
        )}
        <div className="chat-dock__input-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="chat-dock__attach-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={pending || uploading || activeRun !== null}
            title="Đính kèm ảnh (tối đa 5)"
            aria-label="Đính kèm ảnh"
          >
            📎
          </button>
          <textarea
            ref={textareaRef}
            className="chat-dock__textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              activeRun
                ? "Agent đang chạy…"
                : "Mô tả ý tưởng + yêu cầu làm video… (Enter để gửi)"
            }
            disabled={pending || uploading || activeRun !== null}
            rows={2}
          />
          <button
            type="button"
            className="chat-dock__send"
            onClick={() => void handleSend()}
            disabled={!canSend}
            aria-label="Gửi"
          >
            {uploading ? "…" : "➤"}
          </button>
        </div>
      </div>
    </div>
  );
}
