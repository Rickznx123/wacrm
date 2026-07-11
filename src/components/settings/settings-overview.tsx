'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { THEMES } from '@/lib/themes';
import { CURRENCIES } from '@/lib/currency';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ASCENT, ASCENT_INTERACTIVE } from '@/lib/ui/ascent';

import { SECTION_META, type SettingsSection } from './settings-sections';
import { SettingsChip, StatusDot } from './settings-chip';
import { ROLE_META } from './role-meta';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  tags: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { user, profile, accountId, accountRole, defaultCurrency, canManageMembers } =
    useAuth();
  const { mode, theme } = useTheme();
  const t = useTranslations('Settings.overview');
  const tRoles = useTranslations('roles');
  const tSections = useTranslations('Settings.sections');

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  // WhatsApp status is tracked separately: its health check decrypts the
  // token and pings Meta, which is far slower than the cheap count
  // queries. Gating it independently keeps a slow/flaky Meta round-trip
  // from blanking the rest of the landing.
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(true);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const userId = user.id;
    const acctId = accountId;

    // Cheap counts — resolve fast, render immediately.
    (async () => {
      setCountsLoading(true);
      const [membersRes, invitesRes, templatesTotal, templatesPending, tagsRes, fieldsRes] =
        await Promise.allSettled([
          fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
          canManageMembers
            ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
                r.json(),
              )
            : Promise.resolve(null),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'PENDING'),
          supabase
            .from('tags')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase.from('custom_fields').select('id', { count: 'exact', head: true }),
        ]);

      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const pendingInvites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setCounts({
        members,
        pendingInvites,
        templates:
          templatesTotal.status === 'fulfilled'
            ? templatesTotal.value.count ?? null
            : null,
        templatesPending:
          templatesPending.status === 'fulfilled'
            ? templatesPending.value.count ?? null
            : null,
        tags: tagsRes.status === 'fulfilled' ? tagsRes.value.count ?? null : null,
        customFields:
          fieldsRes.status === 'fulfilled' ? fieldsRes.value.count ?? null : null,
      });
      setCountsLoading(false);
    })();

    // WhatsApp connection status — aggregate Meta OR Evolution.
    (async () => {
      setWhatsappLoading(true);
      const [metaRow, evolutionRow, health] = await Promise.allSettled([
        supabase
          .from('whatsapp_config')
          .select('phone_number_id, status')
          .eq('account_id', acctId)
          .maybeSingle(),
        supabase
          .from('whatsapp_channels')
          .select('instance_id, status')
          .eq('account_id', acctId)
          .eq('provider', 'evolution')
          .maybeSingle(),
        fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (cancelled) return;

      const metaConfigured =
        metaRow.status === 'fulfilled' && !!metaRow.value.data?.phone_number_id;
      const evolutionConfigured =
        evolutionRow.status === 'fulfilled' && !!evolutionRow.value.data?.instance_id;

      const metaConnectedByHealth =
        health.status === 'fulfilled' && !!health.value?.connected;
      const metaConnectedByRow =
        metaRow.status === 'fulfilled' &&
        metaRow.value.data?.status === 'connected';
      const evolutionConnected =
        evolutionRow.status === 'fulfilled' &&
        evolutionRow.value.data?.status === 'connected';

      setWhatsapp({
        configured: metaConfigured || evolutionConfigured,
        connected: metaConnectedByHealth || metaConnectedByRow || evolutionConnected,
      });
      setWhatsappLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, accountId, canManageMembers]);

  const displayName = profile?.full_name || profile?.email || t('yourAccount');
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const currencyLabel =
    CURRENCIES.find((c) => c.code === defaultCurrency)?.label ?? defaultCurrency;
  const themeName = THEMES.find((t) => t.id === theme)?.name ?? theme;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const tiles: {
    section: SettingsSection;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'channels',
      loading: whatsappLoading,
      subtitle: !whatsapp?.configured ? (
        t('notSetup')
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('connected')}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('needsReconnecting')}
        </>
      ),
    },
    {
      section: 'members',
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? t('viewTeamMembers')
          : `${t('membersCount', { count: counts.members })}${
              counts.pendingInvites
                ? ` · ${t('pendingInvites', { count: counts.pendingInvites })}`
                : ''
            }`,
    },
    {
      section: 'templates',
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? t('manageTemplates')
          : `${t('templatesCount', { count: counts.templates })}${
              counts.templatesPending
                ? ` · ${t('pendingReview', { count: counts.templatesPending })}`
                : ''
            }`,
    },
    {
      section: 'deals',
      loading: false,
      subtitle: `${defaultCurrency} — ${currencyLabel}`,
    },
    {
      section: 'fields',
      loading: countsLoading,
      subtitle:
        counts?.tags == null && counts?.customFields == null
          ? t('tagsAndFields')
          : `${t('tagsCount', { count: counts?.tags ?? 0 })} · ${t('fieldsCount', {
              count: counts?.customFields ?? 0,
            })}`,
    },
    {
      section: 'appearance',
      loading: false,
      subtitle: t('appearance', { mode: cap(mode), theme: themeName }),
    },
  ];

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity */}
      <Card className={`flex-row items-center gap-4 rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_54%,rgba(255,255,255,0.01))] px-5 py-5 shadow-[0_14px_34px_rgba(7,8,18,0.34)] ${ASCENT.divider}`}>
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-[#7B61FF]/10 text-xl text-[#7B61FF]">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-base font-semibold ${ASCENT.title}`}>
            {displayName}
          </div>
          {profile?.email ? (
            <div className={`truncate text-sm ${ASCENT.subtle}`}>
              {profile.email}
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {tRoles(accountRole!)}
          </SettingsChip>
        ) : null}
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map(({ section, loading, subtitle }) => {
          const meta = SECTION_META[section];
          const Icon = meta.icon;
          return (
            <button
              key={section}
              type="button"
              onClick={() => onSelect(section)}
              className={cn(
                `group flex items-start gap-3.5 rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_54%,rgba(255,255,255,0.01))] p-4 text-left shadow-[0_12px_28px_rgba(7,8,18,0.32)] hover:-translate-y-0.5 hover:border-[#9f8cff]/35 hover:bg-[linear-gradient(170deg,rgba(123,97,255,0.12),rgba(255,255,255,0.02)_65%)] hover:shadow-[0_18px_38px_rgba(12,14,28,0.38)] ${ASCENT.divider} ${ASCENT_INTERACTIVE}`,
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-[linear-gradient(150deg,rgba(123,97,255,0.2),rgba(255,255,255,0.05))] text-[#7B61FF] shadow-[0_8px_18px_rgba(12,14,28,0.3)]">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-semibold ${ASCENT.title}`}>
                  {tSections(section)}
                </span>
                <span className={`mt-0.5 flex items-center gap-1.5 text-xs ${ASCENT.subtle}`}>
                  {loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> {t('loading')}
                    </>
                  ) : (
                    subtitle
                  )}
                </span>
              </span>
              <ChevronRight className={`size-4 shrink-0 ${ASCENT.subtle} transition-transform group-hover:translate-x-0.5`} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
