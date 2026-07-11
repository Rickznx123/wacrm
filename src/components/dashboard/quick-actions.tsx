"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'
import { ASCENT, ASCENT_INTERACTIVE } from '@/lib/ui/ascent'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string }>
  tint: string
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus, tint: 'text-[#7B61FF]' },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase, tint: 'text-[#7B61FF]' },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio, tint: 'text-[#FF4F8A]' },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap, tint: 'text-[#7B61FF]' },
]

export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')
  
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className={`group flex items-center gap-3 rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_52%,rgba(255,255,255,0.01))] px-4 py-3 shadow-[0_12px_28px_rgba(7,8,18,0.3)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#9f8cff]/35 hover:bg-[linear-gradient(170deg,rgba(123,97,255,0.12),rgba(255,255,255,0.02)_65%)] hover:shadow-[0_18px_38px_rgba(12,14,28,0.38)] ${ASCENT.divider} ${ASCENT_INTERACTIVE}`}
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg border border-white/12 bg-[linear-gradient(150deg,rgba(123,97,255,0.2),rgba(255,255,255,0.05))] shadow-[0_8px_18px_rgba(12,14,28,0.3)] ${a.tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <span className={`text-sm font-medium ${ASCENT.title}`}>{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
