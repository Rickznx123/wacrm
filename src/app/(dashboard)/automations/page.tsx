"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Zap,
  Plus,
  MoreVertical,
  Copy,
  Pencil,
  Trash2,
  FileText,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
} from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { useCan } from "@/hooks/use-can"
import { useTranslations } from "next-intl"
import type { Automation } from "@/types"
import { Button } from "@/components/ui/button"
import { GatedButton } from "@/components/ui/gated-button"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AUTOMATION_TEMPLATES, type TemplateSlug } from "@/lib/automations/templates"
import { triggerMeta, formatRelative } from "@/lib/automations/trigger-meta"
import { cn } from "@/lib/utils"
import { ASCENT, ASCENT_INTERACTIVE } from "@/lib/ui/ascent"

const TEMPLATE_ORDER: TemplateSlug[] = [
  "welcome_message",
  "out_of_office",
  "lead_qualifier",
  "follow_up_reminder",
]

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
}

export default function AutomationsPage() {
  const router = useRouter()
  const canCreate = useCan("send-messages")
  const t = useTranslations("Automations.list")
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function load() {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false })
      if (fetchErr) throw fetchErr
      setAutomations((data ?? []) as Automation[])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load automations")
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations((prev) =>
      prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ?? prev,
    )
    const res = await fetch(`/api/automations/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: next }),
    })
    if (!res.ok) {
      // Roll back on error.
      setAutomations((prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ?? prev,
      )
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.updateError"))
      return
    }
    toast.success(next ? t("toasts.activated") : t("toasts.paused"))
  }

  async function duplicate(a: Automation) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, { method: "POST" })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.duplicateError"))
      return
    }
    toast.success(t("toasts.duplicated"))
    load()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    const res = await fetch(`/api/automations/${pendingDelete.id}`, { method: "DELETE" })
    setDeleting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      toast.error(body?.error ?? t("toasts.deleteError"))
      return
    }
    toast.success(t("toasts.deleted"))
    setPendingDelete(null)
    load()
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`)
  }

  if (error) {
    return (
      <div className={`-m-4 min-h-[calc(100vh-0px)] p-6 sm:-m-6 sm:p-10 ${ASCENT.canvas}`}>
        <div className={`flex h-64 flex-col items-center justify-center gap-2 ${ASCENT.panel}`}>
          <p className="text-sm text-[#FF4F8A]">{error}</p>
          <Button variant="outline" onClick={() => window.location.reload()} className={`${ASCENT.outline} ${ASCENT_INTERACTIVE}`}>
          {t("retry")}
          </Button>
        </div>
      </div>
    )
  }

  if (automations === null) {
    return (
      <div className={`-m-4 min-h-[calc(100vh-0px)] p-6 sm:-m-6 sm:p-10 ${ASCENT.canvas}`}>
        <div className={`flex h-64 items-center justify-center ${ASCENT.panel}`}>
          <Loader2 className="h-6 w-6 animate-spin text-[#7B61FF]" />
        </div>
      </div>
    )
  }

  const showTemplates = automations.length < 3

  return (
    <div className={`-m-4 min-h-[calc(100vh-0px)] p-6 sm:-m-6 sm:p-10 space-y-8 ${ASCENT.canvas}`}>
      <div className={`flex items-center justify-between p-6 sm:p-7 ${ASCENT.panel}`}>
        <div>
          <h1 className={`text-3xl font-bold tracking-tight ${ASCENT.title}`}>{t("title")}</h1>
          <p className={`mt-2 text-sm ${ASCENT.subtle}`}>
            {t("subtitle")}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create automations"
          onClick={() => router.push("/automations/new")}
          className={`${ASCENT.primary} ${ASCENT_INTERACTIVE}`}
        >
          <Plus className="h-4 w-4" />
          {t("create")}
        </GatedButton>
      </div>

      {showTemplates && (
        <section>
          <h2 className={`mb-3 text-sm font-semibold ${ASCENT.subtle}`}>{t("templatesTitle")}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {TEMPLATE_ORDER.map((slug) => {
              const t = AUTOMATION_TEMPLATES[slug]
              const Icon = TEMPLATE_ICON[slug]
              return (
                <button
                  key={slug}
                  onClick={() => startFromTemplate(slug)}
                  className={`group flex flex-col items-start rounded-xl border bg-[var(--ascent-card)] p-4 text-left hover:bg-[var(--ascent-hover)] ${ASCENT.divider} ${ASCENT_INTERACTIVE}`}
                >
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[#7B61FF]/10 text-[#7B61FF] group-hover:bg-[#7B61FF]/15">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className={`text-sm font-semibold ${ASCENT.title}`}>{t.name}</div>
                  <p className={`mt-1 text-xs ${ASCENT.subtle}`}>{t.description}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {automations.length === 0 ? (
        <div className={`flex h-48 flex-col items-center justify-center rounded-xl border border-dashed ${ASCENT.divider} bg-[var(--ascent-card)]`}>
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#7B61FF]/10">
            <Zap className="h-6 w-6 text-[#7B61FF]" />
          </div>
          <p className={`mt-3 text-sm font-medium ${ASCENT.title}`}>{t("emptyTitle")}</p>
          <p className={`mt-1 text-xs ${ASCENT.subtle}`}>
            {t("emptyDesc")}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {automations.map((a) => (
            <AutomationCard
              key={a.id}
              automation={a}
              onToggle={(next) => toggleActive(a, next)}
              onEdit={() => router.push(`/automations/${a.id}/edit`)}
              onDuplicate={() => duplicate(a)}
              onLogs={() => router.push(`/automations/${a.id}/logs`)}
              onDelete={() => setPendingDelete(a)}
              t={t}
            />
          ))}
        </ul>
      )}

      <Dialog open={!!pendingDelete} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <DialogContent className={ASCENT.popover}>
          <DialogHeader>
            <DialogTitle className={ASCENT.title}>{t("deleteTitle")}</DialogTitle>
            <DialogDescription className={ASCENT.subtle}>
              {t("deleteDesc", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
              className={`${ASCENT.ghost} ${ASCENT_INTERACTIVE}`}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
              className={ASCENT_INTERACTIVE}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AutomationCard({
  automation,
  onToggle,
  onEdit,
  onDuplicate,
  onLogs,
  onDelete,
  t,
}: {
  automation: Automation
  onToggle: (next: boolean) => void
  onEdit: () => void
  onDuplicate: () => void
  onLogs: () => void
  onDelete: () => void
  t: ReturnType<typeof useTranslations>
}) {
  const meta = triggerMeta(automation.trigger_type)
  return (
    <li className={`rounded-xl border bg-[var(--ascent-card)] hover:bg-[var(--ascent-hover)] ${ASCENT.divider} ${ASCENT_INTERACTIVE}`}>
      <div className="flex items-center gap-4 p-4">
        <div
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[#7B61FF]/10"
          aria-hidden
        >
          <Zap className="h-5 w-5 text-[#7B61FF]" />
        </div>

        <button
          type="button"
          onClick={onEdit}
          className={`min-w-0 flex-1 text-left rounded-lg ${ASCENT_INTERACTIVE}`}
        >
          <div className="flex items-center gap-2">
            <span className={`truncate text-sm font-semibold ${ASCENT.title}`}>
              {automation.name}
            </span>
            {automation.is_active && (
              <span className="relative flex h-2 w-2" aria-label="active">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF4F8A] opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF4F8A]" />
              </span>
            )}
          </div>
          {automation.description && (
            <p className={`mt-0.5 truncate text-xs ${ASCENT.subtle}`}>{automation.description}</p>
          )}
          <div className={`mt-2 flex flex-wrap items-center gap-2 text-xs ${ASCENT.subtle}`}>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                meta.pillClass,
              )}
            >
              {meta.label}
            </span>
            <span className="tabular-nums">
              {automation.execution_count === 1
                ? t("runs", { count: automation.execution_count })
                : t("runsPlural", { count: automation.execution_count })}
            </span>
            <span aria-hidden>·</span>
            <span>{t("lastRun", { time: formatRelative(automation.last_executed_at) })}</span>
          </div>
        </button>

        <div className="flex items-center gap-3">
          <Switch
            checked={automation.is_active}
            onCheckedChange={(v) => onToggle(!!v)}
            aria-label={automation.is_active ? t("deactivate") : t("activate")}
          />

          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Open menu"
              className={`inline-flex h-8 w-8 items-center justify-center rounded-md ${ASCENT.subtle} hover:bg-[var(--ascent-hover)] hover:text-[var(--ascent-title)] data-[popup-open]:bg-[var(--ascent-hover)] ${ASCENT_INTERACTIVE}`}
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={ASCENT.popover}>
              <DropdownMenuItem onClick={onEdit} className="text-[var(--ascent-body)] focus:bg-[var(--ascent-hover)] focus:text-[var(--ascent-title)]">
                <Pencil className="h-4 w-4" />
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate} className="text-[var(--ascent-body)] focus:bg-[var(--ascent-hover)] focus:text-[var(--ascent-title)]">
                <Copy className="h-4 w-4" />
                {t("duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogs} className="text-[var(--ascent-body)] focus:bg-[var(--ascent-hover)] focus:text-[var(--ascent-title)]">
                <FileText className="h-4 w-4" />
                {t("viewLogs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator className={ASCENT.divider} />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 className="h-4 w-4" />
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  )
}
