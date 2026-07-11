import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'
import { ASCENT } from '@/lib/ui/ascent'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle }: MetricCardProps) {
  return (
    <div className={`rounded-2xl border border-white/12 bg-[linear-gradient(175deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_52%,rgba(255,255,255,0.01))] p-5 shadow-[0_14px_34px_rgba(7,8,18,0.34)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#9f8cff]/35 hover:shadow-[0_18px_38px_rgba(12,14,28,0.4),0_0_0_1px_rgba(123,97,255,0.12)] ${ASCENT.divider}`}>
      <div className="flex items-start justify-between">
        <p className={`text-sm font-medium ${ASCENT.subtle}`}>{title}</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/12 bg-[linear-gradient(150deg,rgba(123,97,255,0.2),rgba(255,255,255,0.05))] text-[var(--ascent-subtle)] shadow-[0_8px_18px_rgba(12,14,28,0.3)]">
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className={`mt-3 text-[28px] leading-none font-bold tabular-nums ${ASCENT.title}`}>
        {value}
      </p>
      {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
        <p className={`mt-2 text-sm ${ASCENT.subtle}`}>{subtitle}</p>
      ) : null}
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-[#7B61FF]'
      : sign < 0
      ? 'text-[#FF4F8A]'
      : 'text-[var(--ascent-subtle)]'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-2 flex items-center gap-1 text-sm', tone)}>
      <Arrow className="h-4 w-4" aria-hidden />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}
