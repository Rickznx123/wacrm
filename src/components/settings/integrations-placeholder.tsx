import { Card } from '@/components/ui/card';
import { ASCENT } from '@/lib/ui/ascent';

import { SettingsPanelHead } from './settings-panel-head';

export function IntegrationsPlaceholder() {
  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Integrations"
        description="Connect external tools and data sources."
      />
      <Card
        className={`rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.018)_54%,rgba(255,255,255,0.01))] p-5 shadow-[0_12px_28px_rgba(7,8,18,0.32)] ${ASCENT.panel}`}
      >
        <p className={`text-sm ${ASCENT.subtle}`}>
          Configuracao do Meta Conversions API - em breve.
        </p>
      </Card>
    </section>
  );
}
