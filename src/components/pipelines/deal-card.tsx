"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";
import { ASCENT, ASCENT_INTERACTIVE } from "@/lib/ui/ascent";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("pt-BR", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initials(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  return source.charAt(0).toUpperCase();
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      className={`group relative w-full cursor-pointer rounded-xl border pl-4 pr-3 py-3 text-left shadow-sm ${ASCENT.divider} bg-[var(--ascent-card)] ${ASCENT_INTERACTIVE} ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:bg-[var(--ascent-hover)] hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <h4 className={`flex-1 text-sm font-semibold leading-snug break-words ${ASCENT.title}`}>
          {deal.title}
        </h4>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#7B61FF]/15 px-2 py-0.5 text-[10px] font-semibold text-[#7B61FF]">
            <Check className="h-3 w-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#FF4F8A]/15 px-2 py-0.5 text-[10px] font-semibold text-[#FF4F8A]">
            <X className="h-3 w-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-2 flex items-center gap-2">
        <span className={`flex h-5 w-5 items-center justify-center rounded-full bg-[var(--ascent-field)] text-[10px] font-semibold ${ASCENT.title}`}>
          {initials(deal.contact?.name, deal.contact?.phone)}
        </span>
        <span className={`truncate text-xs ${ASCENT.subtle}`}>{contactLabel}</span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-[#7B61FF]">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className={`flex items-center gap-1 text-[11px] ${ASCENT.subtle}`}>
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-[#7B61FF]/15 text-[10px] font-semibold text-[#7B61FF]"
          >
            {initials(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
