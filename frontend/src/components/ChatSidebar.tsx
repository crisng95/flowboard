import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import { useBoardStore } from "../store/board";
import { useChatStore } from "../store/chat";
import type { ChatMessageDTO, PlanDTO } from "../api/client";

// ── Glyph map (same as NodeCard) ──────────────────────────────────────────────
const ICON: Record<string, string> = {
  character: "◎",
  image: "▣",
  video: "▶",
  prompt: "✦",
  note: "✎",
};

// ── PlanPreviewCard ───────────────────────────────────────────────────────────

const MAX_DOTS = 6;

function PlanPreviewCard({ plan }: { plan: PlanDTO }) {
  const nodeCount = plan.spec.nodes.length;
  const edgeCount = plan.spec.edges.length;
  const dotCount = Math.min(nodeCount, MAX_DOTS);
  const overflow = nodeCount > MAX_DOTS ? nodeCount - MAX_DOTS : 0;

  const dots: JSX.Element[] = [];
  for (let i = 0; i < dotCount; i++) {
    dots.push(
      <span
        key={`dot-${i}`}
        className={`plan-preview-card__dot${i === 0 ? " plan-preview-card__dot--primary" : ""}`}
      />
    );
    if (i < dotCount - 1) {
      dots.push(<span key={`line-${i}`} className="plan-preview-card__line" />);
    }
  }

  const statsText = [
    `${nodeCount} node${nodeCount !== 1 ? "s" : ""}`,
    `${edgeCount} edge${edgeCount !== 1 ? "s" : ""}`,
    ...(plan.spec.layout_hint ? [plan.spec.layout_hint] : []),
  ].join(" · ");

  return (
    <div className="plan-preview-card">
      <div className="plan-preview-card__title">Pipeline proposed</div>
      <div className="plan-preview-card__sketch">
        {dots}
        {overflow > 0 && (
          <span className="plan-preview-card__overflow">+{overflow}</span>
        )}
      </div>
      <div className="plan-preview-card__stats">{statsText}</div>
      <div className="plan-preview-card__actions">
        <button
          className="plan-preview-card__review-btn"
          disabled
          title="Ghost-node review lands in Run 8"
        >
          Review
        </button>
      </div>
    </div>
  );
}

// ── MessageRow ────────────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: ChatMessageDTO }) {
  // Look up attached plan for assistant messages (only present on new sends,
  // not on historical messages loaded via GET /api/boards/:id/chat).
  const plan = useChatStore((s) =>
    msg.role === "assistant" ? s.plans[msg.id] : undefined
  );

  if (msg.role === "system") {
    return (
      <div className="chat-system-divider">
        <span>{msg.content}</span>
      </div>
    );
  }

  if (msg.role === "user") {
    return (
      <div className="chat-bubble chat-bubble--user">
        {msg.content}
      </div>
    );
  }

  // assistant
  return (
    <>
      <div className="chat-bubble chat-bubble--assistant">
        <div className="chat-agent-label">agent</div>
        {msg.content}
      </div>
      {plan && <PlanPreviewCard plan={plan} />}
    </>
  );
}

// ── Mention autocomplete types ────────────────────────────────────────────────

interface MentionCandidate {
  shortId: string;
  type: string;
  title: string;
}

function getMentionQuery(text: string, caretPos: number): string | null {
  const before = text.slice(0, caretPos);
  const match = before.match(/(^|\s)#(\w*)$/);
  return match ? match[2] : null;
}

function extractMentionsFromText(text: string): string[] {
  const matches = text.matchAll(/#(\w+)/g);
  return [...matches].map((m) => m[1]);
}

// ── ChatComposer ──────────────────────────────────────────────────────────────

function ChatComposer() {
  const [text, setText] = useState("");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverQuery, setPopoverQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const nodes = useBoardStore((s) => s.nodes);
  const pending = useChatStore((s) => s.pending);
  const sendMessage = useChatStore((s) => s.sendMessage);

  // Build candidate list from nodes
  const allCandidates: MentionCandidate[] = nodes.map((n) => ({
    shortId: n.data.shortId,
    type: n.data.type,
    title: n.data.title,
  }));

  // Filter by query
  const q = popoverQuery.toLowerCase();
  const shortIdMatches = allCandidates.filter((c) =>
    c.shortId.startsWith(q)
  );
  const titleMatches = allCandidates.filter(
    (c) => !c.shortId.startsWith(q) && c.title.toLowerCase().includes(q)
  );
  const candidates = [...shortIdMatches, ...titleMatches];

  // Autoresize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 20;
    const minHeight = 60;
    const maxHeight = lineHeight * 6 + 24;
    el.style.height = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight) + "px";
  }, [text]);

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    const caret = e.target.selectionStart ?? val.length;
    const query = getMentionQuery(val, caret);
    if (query !== null) {
      setPopoverQuery(query);
      setPopoverOpen(true);
      setFocusedIndex(0);
    } else {
      setPopoverOpen(false);
    }
  }, []);

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      const el = textareaRef.current;
      if (!el) return;
      const caret = el.selectionStart ?? text.length;
      const before = text.slice(0, caret);
      const after = text.slice(caret);

      // Find and replace the #query token before the caret
      const match = before.match(/(^|\s)(#\w*)$/);
      if (!match) return;
      const tokenStart = before.length - match[2].length;
      const newBefore = before.slice(0, tokenStart) + `#${candidate.shortId} `;
      const newText = newBefore + after;
      setText(newText);

      setPopoverOpen(false);

      // Restore focus and move caret
      requestAnimationFrame(() => {
        el.focus();
        const newCaret = newBefore.length;
        el.setSelectionRange(newCaret, newCaret);
      });
    },
    [text]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (popoverOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setPopoverOpen(false);
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFocusedIndex((i) => Math.min(i + 1, candidates.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setFocusedIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && candidates.length > 0) {
          e.preventDefault();
          insertMention(candidates[focusedIndex]);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!pending && text.trim()) {
          const known = new Set(allCandidates.map((c) => c.shortId));
          const mentions = extractMentionsFromText(text).filter((m) => known.has(m));
          sendMessage(text.trim(), mentions);
          setText("");
          setPopoverOpen(false);
        }
      }
    },
    [popoverOpen, candidates, focusedIndex, pending, text, sendMessage, insertMention, allCandidates]
  );

  const canSend = !pending && text.trim().length > 0;

  return (
    <div className="chat-composer">
      <div style={{ position: "relative" }}>
        {popoverOpen && candidates.length > 0 && (
          <div className="mention-popover" ref={popoverRef} role="listbox">
            {candidates.map((c, i) => (
              <div
                key={c.shortId}
                className={`mention-row${i === focusedIndex ? " mention-row--focused" : ""}`}
                role="option"
                aria-selected={i === focusedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(c);
                }}
              >
                <span className="mention-row__glyph">{ICON[c.type] ?? "□"}</span>
                <span className="mention-row__id">#{c.shortId}</span>
                <span className="mention-row__dash">–</span>
                <span className="mention-row__title">{c.title}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="chat-composer__textarea"
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Describe intent · # to mention a node"
          rows={2}
          aria-label="Chat message"
          aria-autocomplete="list"
          aria-expanded={popoverOpen}
          disabled={pending}
        />
      </div>
      <div className="chat-composer__actions">
        <span className="chat-composer__hint">↵ send · ⇧↵ newline · # mention</span>
        <button
          className="chat-composer__send"
          disabled={!canSend}
          aria-label="Send message"
          onClick={() => {
            if (!canSend) return;
            const known = new Set(allCandidates.map((c) => c.shortId));
            const mentions = extractMentionsFromText(text).filter((m) => known.has(m));
            sendMessage(text.trim(), mentions);
            setText("");
            setPopoverOpen(false);
          }}
        >
          →
        </button>
      </div>
    </div>
  );
}

// ── ChatSidebar ───────────────────────────────────────────────────────────────

export function ChatSidebar() {
  const boardId = useBoardStore((s) => s.boardId);
  const boardName = useBoardStore((s) => s.boardName);
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const loadChat = useChatStore((s) => s.loadChat);

  const scrollRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef<number | null>(null);

  // Load chat when boardId becomes available
  useEffect(() => {
    if (boardId !== null && loadedRef.current !== boardId) {
      loadedRef.current = boardId;
      loadChat(boardId);
    }
  }, [boardId, loadChat]);

  // Autoscroll to bottom when messages change or pending changes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  return (
    <aside className="sidebar chat">
      <header className="chat__header">
        <span className="chat__label">CHAT</span>
        {boardName && (
          <>
            <span className="chat__scope-sep">&nbsp;·&nbsp;</span>
            <span className="chat__scope">{boardName}</span>
          </>
        )}
      </header>

      <div className="chat__messages" ref={scrollRef}>
        {messages.map((m) => (
          <MessageRow key={m.id} msg={m} />
        ))}
        {pending && <div className="chat__typing">…</div>}
      </div>

      <ChatComposer />
    </aside>
  );
}
