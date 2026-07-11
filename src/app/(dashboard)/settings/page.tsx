'use client';

import { useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppChannelsConfig } from '@/components/settings/whatsapp-channels-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { MembersTab } from '@/components/settings/members-tab';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { AiConfig } from '@/components/settings/ai-config';
import { MetaCapiConfig } from '@/components/settings/meta-capi-config';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';
import { ASCENT } from '@/lib/ui/ascent';

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const section = resolveSection(searchParams.get('tab'));

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    ai: <AiConfig />,
    channels: <WhatsAppChannelsConfig />,
    integrations: <MetaCapiConfig />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
  };

  return (
    <div className={`relative -m-4 min-h-[calc(100vh-0px)] overflow-hidden p-6 sm:-m-6 sm:p-10 space-y-8 ${ASCENT.canvas}`}>
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-20 top-12 h-80 w-80 rounded-full bg-[#7B61FF]/14 blur-3xl" />
        <div className="absolute -right-24 bottom-12 h-[28rem] w-[28rem] rounded-full bg-[#FF4F8A]/9 blur-3xl" />
      </div>
      <div className={`relative rounded-2xl border border-white/10 bg-[linear-gradient(160deg,rgba(13,14,20,0.82),rgba(42,27,77,0.22)_55%,rgba(13,14,20,0.78))] p-6 shadow-[0_18px_48px_rgba(7,8,18,0.38),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[8px] sm:p-7 ${ASCENT.panel}`}>
        <h1 className={`text-3xl font-bold tracking-tight ${ASCENT.title}`}>
          {t('pageTitle')}
        </h1>
        <p className={`mt-2 text-sm ${ASCENT.subtle}`}>
          {t('pageDesc')}
        </p>
      </div>

      <div className={`relative grid gap-6 rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.016)_56%,rgba(255,255,255,0.01))] p-6 shadow-[0_16px_36px_rgba(7,8,18,0.36)] lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start ${ASCENT.panel}`}>
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
