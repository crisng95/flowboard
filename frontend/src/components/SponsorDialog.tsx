import { useEffect, useRef, useState } from "react";

/**
 * Sponsor entry point — top-right canvas button + modal dialog.
 *
 * The button is intentionally premium: gradient background, sparkle
 * cursor accent, gentle hover lift. Click opens a 4-tier sponsor card
 * grid (Coffee → Diamond) backed by PayPal donate URLs. Each tier
 * card is fully clickable, opens PayPal in a new tab with the tier's
 * amount + label pre-filled, and the dialog stays open so the user
 * can switch tiers without re-opening.
 *
 * Sponsors are listed at the top of the README repo by tier — the
 * trust signal we lean on here is "real money, real attribution".
 */

// Ko-fi is the primary sponsor rail because it works globally — no
// country gating like PayPal's `/donate` endpoint, and the page
// accepts an `?amount=` hint to pre-fill the tip box for the chosen
// tier. PayPal stays as a fallback in the footer for users who
// already have a balance there.
const KOFI_USERNAME = "crisnguyen95";
const PAYPAL_EMAIL = "tuannguyenhoangit@gmail.com";

interface Tier {
  key: "coffee" | "gold" | "platinum" | "diamond";
  label: string;
  amount: number;
  tagline: string;
  perks: string[];
  // Visual accents — per-tier so cards read as distinct collectibles
  // rather than four near-identical pills.
  icon: string;
  ringClass: string;
}

const TIERS: Tier[] = [
  {
    key: "coffee",
    label: "Coffee",
    amount: 5,
    tagline: "Buy me a coffee",
    perks: ["Name listed in README sponsors", "Discord supporter role"],
    icon: "☕",
    ringClass: "sponsor-tier--coffee",
  },
  {
    key: "gold",
    label: "Gold",
    amount: 25,
    tagline: "Solid backing",
    perks: ["Gold badge in README", "Priority issue triage", "Discord supporter role"],
    icon: "★",
    ringClass: "sponsor-tier--gold",
  },
  {
    key: "platinum",
    label: "Platinum",
    amount: 50,
    tagline: "For serious users",
    perks: [
      "Platinum badge with logo in README",
      "Priority issue + feature triage",
      "Direct chat with the maintainer",
    ],
    icon: "✦",
    ringClass: "sponsor-tier--platinum",
  },
  {
    key: "diamond",
    label: "Diamond",
    amount: 100,
    tagline: "Top tier",
    perks: [
      "Diamond badge with logo in README header",
      "Direct chat + feature priority",
      "Early access to roadmap drops",
    ],
    icon: "◆",
    ringClass: "sponsor-tier--diamond",
  },
];

function kofiTierUrl(tier: Tier): string {
  // Ko-fi's tip page reads `amount` from the query string and pre-fills
  // the tip selector. Users still confirm on Ko-fi's side, so we don't
  // bypass their checkout — just save them a click.
  const params = new URLSearchParams({ amount: String(tier.amount) });
  return `https://ko-fi.com/${KOFI_USERNAME}?${params.toString()}`;
}

const KOFI_URL = `https://ko-fi.com/${KOFI_USERNAME}`;

export function SponsorButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="sponsor-trigger"
        onClick={() => setOpen(true)}
        aria-label="Support Flowboard"
        title="Become a sponsor"
      >
        <span className="sponsor-trigger__heart" aria-hidden="true">♥</span>
        <span>Sponsor</span>
      </button>
      <SponsorDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

interface SponsorDialogProps {
  open: boolean;
  onClose(): void;
}

function SponsorDialog({ open, onClose }: SponsorDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="sponsor-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="sponsor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sponsor-dialog-title"
      >
        <button
          type="button"
          className="sponsor-dialog__close"
          onClick={onClose}
          aria-label="Close sponsor dialog"
        >
          ×
        </button>

        <div className="sponsor-dialog__header">
          <div className="sponsor-dialog__eyebrow">SUPPORT THE PROJECT</div>
          <h2 id="sponsor-dialog-title" className="sponsor-dialog__title">
            Sponsor Flowboard
          </h2>
          <p className="sponsor-dialog__subtitle">
            Become a sponsor and appear in the top of our Git repository.
            Your name (and logo at higher tiers) is credited in the README
            and the in-app sponsors panel.
          </p>
        </div>

        <div className="sponsor-tier-grid">
          {TIERS.map((tier) => (
            <a
              key={tier.key}
              className={`sponsor-tier ${tier.ringClass}`}
              href={kofiTierUrl(tier)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <div className="sponsor-tier__icon" aria-hidden="true">
                {tier.icon}
              </div>
              <div className="sponsor-tier__name">{tier.label}</div>
              <div className="sponsor-tier__amount">
                <span className="sponsor-tier__currency">$</span>
                {tier.amount}
              </div>
              <div className="sponsor-tier__tagline">{tier.tagline}</div>
              <ul className="sponsor-tier__perks">
                {tier.perks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <div className="sponsor-tier__cta">Tip with Ko-fi →</div>
            </a>
          ))}
        </div>

        <div className="sponsor-dialog__footer">
          <div className="sponsor-dialog__paypal">
            <a
              className="sponsor-dialog__kofi"
              href={KOFI_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              ☕ Open Ko-fi page
            </a>
            <span className="sponsor-dialog__or">or send to PayPal</span>
            <code className="sponsor-dialog__paypal-email">{PAYPAL_EMAIL}</code>
            <button
              type="button"
              className="sponsor-dialog__copy"
              onClick={() => {
                navigator.clipboard?.writeText(PAYPAL_EMAIL).catch(() => {});
              }}
              title="Copy email"
            >
              Copy
            </button>
          </div>
          <p className="sponsor-dialog__fineprint">
            Payments go directly to the maintainer. After Ko-fi (or
            PayPal) confirms, email the receipt + your preferred
            display name to <code>{PAYPAL_EMAIL}</code> and we'll add
            you to the README within 48 hours.
          </p>
        </div>
      </div>
    </div>
  );
}
