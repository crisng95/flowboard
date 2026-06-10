import { useMemo } from "react";
import { Handle, Position, useConnection, useEdges, type NodeProps } from "@xyflow/react";
import {
  Bot,
  Copy,
  Image as ImageIcon,
  Play,
  RefreshCw,
  Type,
  Video,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { type FlowNode, useBoardStore } from "../../store/board";
import {
  collectSelectedListMediaItems,
  collectSelectedListTextPrompts,
  useGenerationStore,
} from "../../store/generation";
import { NodeShell } from "./NodeShell";
import { ResizeHandle } from "./shared/ResizeHandle";
import { persistNodeData } from "./shared/persistNodeData";
import { HandleBadge } from "./shared/HandleBadge";
import { edgeHandleClass, EDGE_HANDLE_TOP_OFFSET } from "./shared/edgeHandle";

const MIN_WIDTH = 420;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 560;
const TARGET_IMAGE_TOP = EDGE_HANDLE_TOP_OFFSET + 44;
const TARGET_VIDEO_TOP = EDGE_HANDLE_TOP_OFFSET + 88;

export function AssistantNode(props: NodeProps<FlowNode>) {
  const { id: rfId, data, selected } = props;
  const status = ((data.assistantStatus as string | undefined) ?? (data.status as string | undefined) ?? "idle") as
    | "idle"
    | "queued"
    | "running"
    | "done"
    | "error";
  const isRunning = status === "queued" || status === "running";
  const shortId = data.shortId as string | undefined;
  const width = (data.nodeWidth as number | undefined) ?? DEFAULT_WIDTH;
  const systemPrompt = (data.systemPrompt as string | undefined) ?? "";
  const prompt = (data.assistantPrompt as string | undefined) ?? "";
  const output = (data.assistantOutput as string | undefined) ?? "";
  const error = (data.assistantError as string | undefined) ?? (data.error as string | undefined);

  const edges = useEdges();
  const connection = useConnection();
  const allNodes = useBoardStore((s) => s.nodes);
  const textEdge = edges.find((edge) => edge.target === rfId && edge.targetHandle === "target-text");
  const textSourceNode = textEdge ? allNodes.find((node) => node.id === textEdge.source) : null;
  const upstreamText = useMemo(() => {
    if (!textSourceNode) return [];
    if (textSourceNode.data.type === "list") {
      return collectSelectedListTextPrompts(textSourceNode as { id: string; data: Record<string, unknown> });
    }
    if (textSourceNode.data.type === "assistant") {
      const value = (textSourceNode.data.assistantOutput as string | undefined) ?? "";
      return value.trim() ? [value.trim()] : [];
    }
    const value = ((textSourceNode.data.prompt as string | undefined) ?? "").trim();
    return value ? [value] : [];
  }, [textSourceNode]);

  const attachmentSummary = useMemo(() => {
    const attachmentEdges = edges.filter(
      (edge) =>
        edge.target === rfId &&
        (edge.targetHandle === "target-image" || edge.targetHandle === "target-video"),
    );
    return attachmentEdges.flatMap((edge) => {
      const node = allNodes.find((entry) => entry.id === edge.source);
      if (!node) return [];
      if (node.data.type === "list") {
        return collectSelectedListMediaItems(node as { id: string; data: Record<string, unknown> }).map((item, index) => ({
          id: `${edge.id}-${index}`,
          kind: item.kind === "video" ? "video" : "image",
          title: String(item.title ?? item.kind ?? "Attachment"),
        }));
      }
      const kind = node.data.type === "video" ? "video" : "image";
      const variants = Array.isArray(node.data.mediaIds)
        ? node.data.mediaIds.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [node.data.mediaId].filter((value): value is string => typeof value === "string" && value.length > 0);
      return (variants.length > 0 ? variants : [node.data.mediaId]).flatMap((_, index) => ({
        id: `${edge.id}-${index}`,
        kind,
        title: `${String(node.data.title ?? (kind === "video" ? "Video" : "Image"))} ${variants.length > 1 ? index + 1 : ""}`.trim(),
      }));
    });
  }, [allNodes, edges, rfId]);

  const hasTargetImageEdge = edges.some((edge) => edge.target === rfId && edge.targetHandle === "target-image");
  const hasTargetVideoEdge = edges.some((edge) => edge.target === rfId && edge.targetHandle === "target-video");

  function persistDelta(delta: Record<string, unknown>) {
    useBoardStore.getState().updateNodeData(rfId, delta);
    persistNodeData(rfId, delta);
  }

  function setSystemPrompt(value: string) {
    persistDelta({ systemPrompt: value });
  }

  function setPrompt(value: string) {
    persistDelta({ assistantPrompt: value });
  }

  function handleRun() {
    useGenerationStore.getState().runNodeGraph(rfId);
  }

  function handleCopyOutput() {
    if (!output.trim()) return;
    void navigator.clipboard.writeText(output);
  }

  return (
    <div className={cn("relative", selected && "node-selected")}>
      <NodeShell
        id={rfId}
        Icon={Bot}
        title={data.title || "Assistant"}
        shortId={shortId}
        selected={selected}
        width={width}
        padded={false}
        status={status}
        targetHandle={{ id: "target-text", icon: Type, label: "Prompt context" }}
        sourceHandle={{ id: "source", icon: Type, label: "Assistant output" }}
        className="overflow-hidden"
      >
        <div className="flex min-h-[420px] flex-col px-5 pb-4 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/80">
                Flow Gemini
              </div>
              {attachmentSummary.length > 0 && (
                <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-white/60">
                  {attachmentSummary.length} attachment{attachmentSummary.length > 1 ? "s" : ""}
                </div>
              )}
            </div>
            {output.trim() && (
              <button
                type="button"
                onClick={handleCopyOutput}
                className="nodrag nowheel inline-flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/[0.06] hover:text-white"
                title="Copy output"
              >
                <Copy size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>

          <div className="mb-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-white/35">
              System prompt
            </div>
            <textarea
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              spellCheck={false}
              className="nodrag nowheel img-gen-prompt min-h-[72px] w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-white/88 outline-none placeholder:text-white/30"
              placeholder="You are a helpful creative assistant."
            />
          </div>

          <div className="mb-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-white/35">
              Prompt
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              spellCheck={false}
              className="nodrag nowheel img-gen-prompt min-h-[92px] w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-white/88 outline-none placeholder:text-white/30"
              placeholder="Ask the assistant to analyze, rewrite, or synthesize from your upstream text and media."
            />
            {upstreamText.length > 0 && (
              <div className="mt-3 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-xs leading-relaxed text-white/45">
                Upstream text: {upstreamText.length} item{upstreamText.length > 1 ? "s" : ""}
              </div>
            )}
          </div>

          {attachmentSummary.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachmentSummary.slice(0, 8).map((item) => (
                <div
                  key={item.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs text-white/65"
                >
                  {item.kind === "video" ? <Video size={12} strokeWidth={1.6} /> : <ImageIcon size={12} strokeWidth={1.6} />}
                  <span className="max-w-[170px] truncate">{item.title}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex-1 rounded-[24px] border border-white/[0.08] bg-black/20 p-4">
            {error ? (
              <div className="text-sm leading-relaxed text-rose-300">{error}</div>
            ) : output.trim() ? (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-white/88">
                {output}
              </pre>
            ) : (
              <div className="max-w-[440px] text-[15px] leading-8 text-white/38">
                Assistant is your creative sidekick, powered by a multimodal model. Add prompt context, connect images or
                video, and run it to synthesize a text result.
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-white/40">
              {isRunning ? "Generating..." : "Export as text"}
            </div>
            <button
              type="button"
              onClick={handleRun}
              className={cn(
                "nodrag nowheel inline-flex h-10 w-10 items-center justify-center rounded-full transition",
                isRunning
                  ? "bg-white/[0.08] text-white/70"
                  : "bg-white text-black hover:bg-white/90",
              )}
              title={isRunning ? "Running" : "Run assistant"}
            >
              {isRunning ? <RefreshCw size={16} strokeWidth={1.8} className="animate-spin" /> : <Play size={16} strokeWidth={1.8} fill="currentColor" />}
            </button>
          </div>
        </div>

        <Handle
          type="target"
          position={Position.Left}
          id="target-image"
          style={{ top: TARGET_IMAGE_TOP }}
          className={edgeHandleClass({ side: "left", visible: hasTargetImageEdge || connection.inProgress, dragActive: connection.inProgress })}
        >
          <HandleBadge icon={ImageIcon} active={hasTargetImageEdge} label="Image context" side="left" />
        </Handle>
        <Handle
          type="target"
          position={Position.Left}
          id="target-video"
          style={{ top: TARGET_VIDEO_TOP }}
          className={edgeHandleClass({ side: "left", visible: hasTargetVideoEdge || connection.inProgress, dragActive: connection.inProgress })}
        >
          <HandleBadge icon={Video} active={hasTargetVideoEdge} label="Video context" side="left" />
        </Handle>

        <ResizeHandle
          minWidth={MIN_WIDTH}
          maxWidth={MAX_WIDTH}
          currentWidth={width}
          nodeId={rfId}
          onResize={(nextWidth) => useBoardStore.getState().updateNodeData(rfId, { nodeWidth: nextWidth })}
          onResizeEnd={(nextWidth) => persistNodeData(rfId, { nodeWidth: Math.round(nextWidth) })}
          forceVisible={!!selected}
        />
      </NodeShell>
    </div>
  );
}
