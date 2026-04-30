import { useState } from "react";

/**
 * Masked API key input shared by Grok + OpenAI fallback.
 *
 * States (from the plan UI Spec):
 *   - Empty:   placeholder, save/test disabled until format hint passes
 *   - Editing: live regex hint, save enabled, optional reveal toggle
 *   - Saved:   collapsed to first-4 + ••• + last-4 with [Edit] [Clear]
 *   - Edit:    clears the input, focuses, allows new key
 *   - Clear:   inline confirm "Remove this key?" then PUT apiKey: null
 */

interface ApiKeyFieldProps {
  /** Current saved key — when null/undefined the field is empty / waiting
   * for first input. When non-null we render the masked form. */
  savedKey: string | null;
  /** Regex used as a "format hint" — invalid format paints the input red
   * but does NOT block save (regex is heuristic, not a contract). */
  formatHint: RegExp;
  /** Placeholder text in empty state, e.g. "xai-..." or "sk-..." */
  placeholder: string;
  /** Called when the user presses Save with a valid-looking key. */
  onSave(key: string): Promise<void>;
  /** Called when the user confirms Clear. */
  onClear(): Promise<void>;
  /** Called when the user presses Test. Disabled while empty/dirty. */
  onTest?(): Promise<void>;
  /** Disable everything while a parent operation is in flight. */
  disabled?: boolean;
}

function maskKey(key: string): string {
  // Show first 4 + last 4 so the user can sanity-check the right key
  // is saved without exposing the full secret.
  if (key.length <= 12) return "••••••••";
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

export function ApiKeyField({
  savedKey,
  formatHint,
  placeholder,
  onSave,
  onClear,
  onTest,
  disabled = false,
}: ApiKeyFieldProps) {
  const [editing, setEditing] = useState(savedKey === null);
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const formatLooksValid = formatHint.test(draft);
  const draftIsEmpty = draft.trim().length === 0;

  async function handleSave() {
    if (saving || draftIsEmpty) return;
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
      setDraft("");
      setReveal(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleClearConfirmed() {
    setConfirmingClear(false);
    await onClear();
    setEditing(true);
    setDraft("");
  }

  async function handleTest() {
    if (testing || !onTest) return;
    setTesting(true);
    try {
      await onTest();
    } finally {
      setTesting(false);
    }
  }

  // Saved state — collapsed mask + Edit / Clear buttons
  if (!editing && savedKey) {
    return (
      <div className="api-key-field api-key-field--saved">
        <div className="api-key-field__masked">{maskKey(savedKey)}</div>
        {confirmingClear ? (
          <div className="api-key-field__confirm">
            <span>Remove this key?</span>
            <button
              type="button"
              className="api-key-field__btn api-key-field__btn--danger"
              onClick={handleClearConfirmed}
            >
              Yes
            </button>
            <button
              type="button"
              className="api-key-field__btn"
              onClick={() => setConfirmingClear(false)}
            >
              No
            </button>
          </div>
        ) : (
          <div className="api-key-field__actions">
            <button
              type="button"
              className="api-key-field__btn"
              onClick={() => {
                setEditing(true);
                setDraft("");
              }}
              disabled={disabled}
            >
              Edit
            </button>
            <button
              type="button"
              className="api-key-field__btn api-key-field__btn--danger"
              onClick={() => setConfirmingClear(true)}
              disabled={disabled}
            >
              Clear
            </button>
            {onTest && (
              <button
                type="button"
                className="api-key-field__btn api-key-field__btn--primary"
                onClick={handleTest}
                disabled={disabled || testing}
              >
                {testing ? "Testing…" : "Test"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // Editing state — input + reveal + Save / Test
  return (
    <div className="api-key-field api-key-field--editing">
      <div className="api-key-field__input-row">
        <input
          type={reveal ? "text" : "password"}
          className={`api-key-field__input${
            !draftIsEmpty && !formatLooksValid ? " api-key-field__input--invalid" : ""
          }`}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setReveal(false)}
          disabled={disabled || saving}
        />
        <button
          type="button"
          className="api-key-field__reveal"
          onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? "Hide key" : "Show key"}
          tabIndex={-1}
        >
          {reveal ? "🙈" : "👁"}
        </button>
      </div>
      {!draftIsEmpty && !formatLooksValid && (
        <div className="api-key-field__format-hint">
          Doesn't match expected format — but you can still try saving.
        </div>
      )}
      <div className="api-key-field__actions">
        <button
          type="button"
          className="api-key-field__btn api-key-field__btn--primary"
          onClick={handleSave}
          disabled={disabled || saving || draftIsEmpty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {onTest && (
          <button
            type="button"
            className="api-key-field__btn"
            onClick={handleTest}
            disabled={disabled || testing || draftIsEmpty || !formatLooksValid}
            title={
              draftIsEmpty
                ? "Enter a key to test"
                : !formatLooksValid
                  ? "Format looks wrong — save anyway to test it"
                  : "Test this key against the provider's API"
            }
          >
            {testing ? "Testing…" : "Test"}
          </button>
        )}
        {savedKey !== null && (
          <button
            type="button"
            className="api-key-field__btn"
            onClick={() => {
              setEditing(false);
              setDraft("");
            }}
            disabled={saving}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
