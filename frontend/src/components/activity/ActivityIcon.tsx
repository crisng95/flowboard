/**
 * Inline SVG icons for the activity feed. Drawn at 14×14 with
 * `stroke="currentColor"` so they inherit the row's text color
 * (muted by default; row hover / status tone overrides it).
 *
 * Style: 1.5px stroke, rounded line caps, no fill — matches the
 * existing minimal toolbar aesthetic. Replaces the emoji set
 * (👁 ✨ 🖼 🎬 …) which read as forum-era kitsch on a dark UI.
 */
import type { JSX } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

const baseProps = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  viewBox: "0 0 24 24",
};

function svg(size: number, className: string | undefined, body: JSX.Element): JSX.Element {
  return (
    <svg width={size} height={size} className={className} {...baseProps}>
      {body}
    </svg>
  );
}

export function EyeIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ));
}

export function SparklesIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M12 3 13.5 8.5 19 10 13.5 11.5 12 17 10.5 11.5 5 10 10.5 8.5Z" />
      <path d="M19 16v4M17 18h4" />
    </>
  ));
}

export function SparklesStackIcon({ size = 14, className }: IconProps) {
  // 2 sparkles for "batch"
  return svg(size, className, (
    <>
      <path d="M9 3 10 7 14 8 10 9 9 13 8 9 4 8 8 7Z" />
      <path d="M17 12 17.8 14.5 20 15 17.8 15.5 17 18 16.2 15.5 14 15 16.2 14.5Z" />
    </>
  ));
}

export function ImageIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L4 22" />
    </>
  ));
}

export function VideoIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10 22 7v10l-6-3" />
    </>
  ));
}

export function EditIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </>
  ));
}

export function UploadIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8 12 3 7 8" />
      <path d="M12 3v12" />
    </>
  ));
}

export function LinkIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </>
  ));
}

export function MessageIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" />
      <circle cx="13" cy="10" r="0.6" fill="currentColor" />
      <circle cx="17" cy="10" r="0.6" fill="currentColor" />
    </>
  ));
}

export function DotIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <circle cx="12" cy="12" r="2" />
  ));
}

export function BellIcon({ size = 14, className }: IconProps) {
  return svg(size, className, (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ));
}

/**
 * Map activity type → icon component. Keeping this here (next to the
 * icons) means adding a new type touches one place.
 */
export function ActivityTypeIcon({
  type,
  size = 14,
  className,
}: {
  type: string;
  size?: number;
  className?: string;
}) {
  switch (type) {
    case "vision":            return <EyeIcon size={size} className={className} />;
    case "auto_prompt":       return <SparklesIcon size={size} className={className} />;
    case "auto_prompt_batch": return <SparklesStackIcon size={size} className={className} />;
    case "planner":           return <MessageIcon size={size} className={className} />;
    case "gen_image":         return <ImageIcon size={size} className={className} />;
    case "gen_video":         return <VideoIcon size={size} className={className} />;
    case "edit_image":        return <EditIcon size={size} className={className} />;
    case "upload":            return <UploadIcon size={size} className={className} />;
    case "upload_url":        return <LinkIcon size={size} className={className} />;
    default:                  return <DotIcon size={size} className={className} />;
  }
}
