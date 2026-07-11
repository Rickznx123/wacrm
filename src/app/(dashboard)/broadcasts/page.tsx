'use client';

import { useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Radio, Plus, Loader2 } from 'lucide-react';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';
import { ASCENT, ASCENT_INTERACTIVE } from '@/lib/ui/ascent';

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  /** Tailwind bg class for the fill, e.g. "bg-primary" */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
        {pct}%
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.page');
  const tStatus = useTranslations('Broadcasts.status');
  const canCreate = useCan('send-messages');
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts() {
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from('broadcasts')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setBroadcasts(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errorLoad'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBroadcasts();
  }, []);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending]);

  if (loading) {
    return (
      <div className={`flex h-64 items-center justify-center rounded-2xl border border-white/10 bg-[linear-gradient(170deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01)_60%)] ${ASCENT.panel}`}>
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-[linear-gradient(170deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01)_60%)] ${ASCENT.panel}`}>
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className={`relative -m-4 min-h-[calc(100vh-0px)] overflow-hidden space-y-6 p-6 sm:-m-6 sm:p-10 ${ASCENT.canvas}`}>
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-20 top-12 h-80 w-80 rounded-full bg-[#7B61FF]/14 blur-3xl" />
        <div className="absolute -right-24 bottom-12 h-[28rem] w-[28rem] rounded-full bg-[#FF4F8A]/9 blur-3xl" />
      </div>
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label="Broadcast in progress"
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-muted"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <div className={`relative flex items-center justify-between rounded-2xl border border-white/10 bg-[linear-gradient(160deg,rgba(13,14,20,0.82),rgba(42,27,77,0.22)_55%,rgba(13,14,20,0.78))] p-6 shadow-[0_18px_48px_rgba(7,8,18,0.38),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[8px] ${ASCENT.panel}`}>
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create broadcasts"
          onClick={() => router.push('/broadcasts/new')}
          className={`border border-white/10 bg-[linear-gradient(135deg,#7B61FF,#6B4FE6)] text-primary-foreground shadow-[0_10px_24px_rgba(66,46,165,0.45)] hover:brightness-105 ${ASCENT_INTERACTIVE}`}
        >
          <Plus className="h-4 w-4" />
          {t('newBroadcast')}
        </GatedButton>
      </div>

      {broadcasts.length === 0 ? (
        <div className={`flex h-64 flex-col items-center justify-center rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.016)_56%,rgba(255,255,255,0.01))] shadow-[0_16px_36px_rgba(7,8,18,0.36)] ${ASCENT.panel}`}>
          <Radio className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t('noBroadcastsYet')}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('createFirst')}
          </p>
          <GatedButton
            canAct={canCreate}
            gateReason="create broadcasts"
            onClick={() => router.push('/broadcasts/new')}
            className={`mt-4 border border-white/10 bg-[linear-gradient(135deg,#7B61FF,#6B4FE6)] text-primary-foreground shadow-[0_10px_24px_rgba(66,46,165,0.45)] hover:brightness-105 ${ASCENT_INTERACTIVE}`}
          >
            <Plus className="h-4 w-4" />
            {t('newBroadcast')}
          </GatedButton>
        </div>
      ) : (
        <div className={`overflow-x-auto rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.016)_56%,rgba(255,255,255,0.01))] shadow-[0_16px_36px_rgba(7,8,18,0.36)] ${ASCENT.panel}`}>
          <Table>
            <TableHeader>
              <TableRow className="border-b border-white/10 bg-[linear-gradient(180deg,rgba(123,97,255,0.12),rgba(255,255,255,0.02)_60%,transparent)] hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t('table.name')}</TableHead>
                <TableHead className="hidden text-muted-foreground md:table-cell">{t('table.template')}</TableHead>
                <TableHead className="hidden text-right text-muted-foreground sm:table-cell">
                  {t('table.recipients')}
                </TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.delivery')}</TableHead>
                <TableHead className="hidden text-muted-foreground lg:table-cell">{t('table.read')}</TableHead>
                <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                <TableHead className="hidden text-muted-foreground sm:table-cell">{t('table.date')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {broadcasts.map((broadcast) => {
                const status = getBroadcastStatus(broadcast.status);
                return (
                  <TableRow
                    key={broadcast.id}
                    className="cursor-pointer border-b border-white/8 last:border-b-0 hover:bg-[#7B61FF]/6"
                    onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                  >
                    <TableCell className="font-medium text-foreground">
                      {broadcast.name}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {broadcast.template_name}
                    </TableCell>
                    <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                      {broadcast.total_recipients}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.delivered_count}
                        total={broadcast.total_recipients}
                        color="bg-primary"
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.read_count}
                        total={broadcast.total_recipients}
                        color="bg-blue-500"
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                      >
                        {status.pulse && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                          </span>
                        )}
                        {tStatus(status.label)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {new Date(broadcast.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
