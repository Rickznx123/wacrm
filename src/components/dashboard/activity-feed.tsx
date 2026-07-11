"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  MessageSquare,
  UserPlus,
  Briefcase,
  Radio,
  Zap,
  Inbox,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { ASCENT, ASCENT_INTERACTIVE } from '@/lib/ui/ascent'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

interface KindTheme {
  icon: ComponentType<{ className?: string }>
  /** Tailwind classes for the round icon badge + label color. */
  badge: string
}

const KIND_THEME: Record<ActivityKind, KindTheme> = {
  message: { icon: MessageSquare, badge: 'bg-[#7B61FF]/10 text-[#7B61FF]' },
  contact: { icon: UserPlus, badge: 'bg-[#7B61FF]/10 text-[#7B61FF]' },
  deal: { icon: Briefcase, badge: 'bg-[#7B61FF]/10 text-[#7B61FF]' },
  broadcast: { icon: Radio, badge: 'bg-[#FF4F8A]/10 text-[#FF4F8A]' },
  automation: { icon: Zap, badge: 'bg-[#FF4F8A]/10 text-[#FF4F8A]' },
}

import { useTranslations } from 'next-intl'

export function ActivityFeed({ items, loading }: ActivityFeedProps) {
  const t = useTranslations('Dashboard.activityFeed')
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)

  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <section className={`rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_55%,rgba(255,255,255,0.01))] shadow-[0_14px_34px_rgba(7,8,18,0.34)] ${ASCENT.divider}`}>
      <header className={`flex items-center justify-between border-b border-white/10 bg-[linear-gradient(180deg,rgba(123,97,255,0.12),rgba(255,255,255,0.02)_60%,transparent)] px-5 py-4 ${ASCENT.divider}`}>
        <h2 className={`text-sm font-semibold ${ASCENT.title}`}>{t('title')}</h2>
        <Link
          href="/inbox"
          className={`text-xs font-medium text-[#7B61FF] ${ASCENT_INTERACTIVE}`}
        >
          {t('viewAll')}
        </Link>
      </header>

      {loading || !items ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={Inbox}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        </div>
      ) : (
        <>
          <ul className={`divide-y ${ASCENT.divider}`}>
            {visible.map((it, i) => {
              const theme = KIND_THEME[it.kind]
              const Icon = theme.icon
              // Alternating row background for scanability. bg-muted/40
              // keeps the stripe visible in both light and dark modes
              // (bg-card/40 vanishes against a white card surface in light).
              const stripe = i % 2 === 0 ? 'bg-transparent' : 'bg-[var(--ascent-hover)]'
              const row = (
                <div className="flex items-center gap-3 px-5 py-2.5">
                  <span
                    className={cn(
                      'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full',
                      theme.badge,
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${ASCENT.body}`}>
                    {it.text}
                  </span>
                  <span className={`flex-shrink-0 text-xs tabular-nums ${ASCENT.subtle}`}>
                    {relativeTime(it.at, t)}
                  </span>
                </div>
              )
              return (
                <li key={it.id} className={cn(stripe, `${ASCENT.row} ${ASCENT_INTERACTIVE}`)}>
                  {it.href ? (
                    <Link href={it.href} className="block">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              )
            })}
          </ul>
          <footer className={`flex items-center justify-between border-t border-white/10 px-5 py-3 text-xs ${ASCENT.divider}`}>
            <span className={`tabular-nums ${ASCENT.subtle}`}>
              {t('showingOf', { visible: visible.length, totalLoaded, plus: totalLoaded === 50 ? '+' : '' })}
            </span>
            <div className="flex items-center gap-1">
              <span className={`mr-1 ${ASCENT.subtle}`}>{t('show')}</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    className={cn(
                      `rounded-md px-2 py-1 font-medium tabular-nums ${ASCENT_INTERACTIVE}`,
                      pageSize === size
                        ? 'bg-[#7B61FF]/12 text-[#7B61FF]'
                        : 'text-[var(--ascent-subtle)] hover:bg-[var(--ascent-hover)] hover:text-[var(--ascent-title)]',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[var(--ascent-subtle)]',
                    )}
                  >
                    {size}
                  </button>
                )
              })}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

function relativeTime(iso: string, t: ReturnType<typeof useTranslations>): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('timeS', { sec: Math.max(1, diffSec) })
  if (diffSec < 3600) return t('timeM', { min: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('timeH', { hr: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('timeD', { day: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
