/**
 * SettingsFields - small primitives composed inside a SettingsDrawer.
 *
 * Each node''s drawer mixes-and-matches these to surface its overrides
 * (system prompt textareas, aspect ratio selectors, mode radios, etc.).
 * Locking the typography + spacing here keeps every drawer visually
 * consistent without each node reinventing label/input pairs.
 */
import type { ChangeEvent, ReactNode } from "react";

import { cn } from "../../../lib/utils";

export interface FieldShellProps {
  label: string;
  /** Optional one-line hint rendered below the label. */
  hint?: string;
  /** Optional trailing element (e.g. "reset" link). */
  action?: ReactNode;
  children: ReactNode;
}

export function FieldShell({ label, hint, action, children }: FieldShellProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && (
        <p className="text-2xs text-ink-placeholder leading-snug">{hint}</p>
      )}
    </div>
  );
}

export interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
  action?: ReactNode;
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  hint,
  action,
}: TextAreaFieldProps) {
  return (
    <FieldShell label={label} hint={hint} action={action}>
      <textarea
        value={value}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={cn(
          "w-full rounded-lg border px-3 py-2 text-2xs leading-relaxed",
          "placeholder:text-ink-placeholder text-ink-primary",
          "focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20",
          "resize-none",
        )}
        style={{
          backgroundColor: "#0f1116",
          borderColor: "rgba(255,255,255,0.08)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </FieldShell>
  );
}

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

export interface SelectFieldProps<V extends string> {
  label: string;
  value: V;
  options: SelectOption<V>[];
  onChange: (next: V) => void;
  hint?: string;
}

export function SelectField<V extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: SelectFieldProps<V>) {
  return (
    <FieldShell label={label} hint={hint}>
      <select
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as V)}
        className={cn(
          "w-full rounded-lg border px-3 h-8 text-2xs",
          "text-ink-primary",
          "focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20",
        )}
        style={{
          backgroundColor: "#0f1116",
          borderColor: "rgba(255,255,255,0.08)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export interface RadioFieldProps<V extends string> {
  label: string;
  value: V;
  options: SelectOption<V>[];
  onChange: (next: V) => void;
  hint?: string;
}

export function RadioField<V extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: RadioFieldProps<V>) {
  return (
    <FieldShell label={label} hint={hint}>
      <div className="flex flex-col gap-1.5">
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!active) onChange(opt.value);
              }}
              className={cn(
                "flex items-start gap-2 px-3 py-2 rounded-lg border text-left transition-colors",
                active
                  ? "bg-accent/10 border-accent/40"
                  : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05]",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 size-3 rounded-full border shrink-0",
                  active
                    ? "border-accent bg-accent"
                    : "border-white/[0.2]",
                )}
              />
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-2xs font-medium text-ink-primary">
                  {opt.label}
                </span>
                {opt.hint && (
                  <span className="text-2xs text-ink-placeholder leading-snug">
                    {opt.hint}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}