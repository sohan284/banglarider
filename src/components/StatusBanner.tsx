"use client";

import { t, type Lang } from "@/lib/i18n";

export interface Banner {
  id: string;
  tone: "error" | "warn" | "info";
  text: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

const TONE: Record<Banner["tone"], string> = {
  error: "bg-[var(--err-bg)] text-[var(--err-ink)] border-[var(--err-ink)]/20",
  warn: "bg-[var(--warn-bg)] text-[var(--warn-ink)] border-[var(--warn-ink)]/20",
  info: "bg-[var(--panel)] text-[var(--ink)] border-[var(--line)]",
};

/** Stacked messages at the top of the screen: load errors, offline, notices. */
export default function StatusBanner({ banners, lang }: { banners: Banner[]; lang: Lang }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col items-center gap-2 p-3 md:left-[400px]">
      {banners.map((b) => (
        <div
          key={b.id}
          role={b.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border px-3 py-2 text-sm shadow-md ${TONE[b.tone]}`}
        >
          <p className="flex-1">{b.text}</p>
          {b.action && (
            <button type="button" onClick={b.action.onClick} className="shrink-0 rounded-lg bg-black/10 px-2.5 py-1 font-semibold hover:bg-black/15">
              {b.action.label}
            </button>
          )}
          {b.onDismiss && (
            <button
              type="button"
              onClick={b.onDismiss}
              aria-label={t("dismiss", lang)}
              className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-black/10"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
