'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, QrCode, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import { WhatsAppConfig } from './whatsapp-config';

interface EvolutionChannel {
  provider: 'evolution';
  instance_id: string;
  status: 'creating' | 'qrcode' | 'connected' | 'disconnected' | 'error';
  qr_code?: string | null;
  phone?: string | null;
  profile_name?: string | null;
  last_error?: string | null;
}

interface EvolutionReadResponse {
  configured: boolean;
  connected: boolean;
  channel: EvolutionChannel | null;
}

export function WhatsAppChannelsConfig() {
  const t = useTranslations('Settings');
  const [activeTab, setActiveTab] = useState<'meta' | 'evolution'>('meta');
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [data, setData] = useState<EvolutionReadResponse | null>(null);

  const fetchEvolution = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/qrcode', { cache: 'no-store' });
      const payload = (await res.json()) as EvolutionReadResponse;
      if (!res.ok) {
        throw new Error((payload as { error?: string }).error ?? 'Failed to load Evolution status');
      }
      setData(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load Evolution status';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchEvolution();
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/connect', { method: 'POST' });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? 'Failed to connect Evolution channel');
      }
      toast.success('Instancia Evolution criada. Escaneie o QR Code para conectar.');
      await fetchEvolution();
      setActiveTab('evolution');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect Evolution channel';
      toast.error(message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/disconnect', { method: 'POST' });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? 'Failed to disconnect Evolution channel');
      }
      toast.success('Instancia Evolution desconectada.');
      await fetchEvolution();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to disconnect Evolution channel';
      toast.error(message);
    } finally {
      setDisconnecting(false);
    }
  };

  const qr = data?.channel?.qr_code;
  const connected = !!data?.connected;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('sections.channels')}</CardTitle>
          <CardDescription>
            Gerencie provedores WhatsApp sem alterar a integracao Meta existente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'meta' | 'evolution')}>
            <TabsList>
              <TabsTrigger value="meta">WhatsApp Cloud (Meta)</TabsTrigger>
              <TabsTrigger value="evolution">WhatsApp QR (Evolution)</TabsTrigger>
            </TabsList>

            <TabsContent value="meta" className="mt-4">
              <WhatsAppConfig />
            </TabsContent>

            <TabsContent value="evolution" className="mt-4 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Evolution API (QR Code)</CardTitle>
                  <CardDescription>
                    Conecte um numero via QR Code usando Evolution API v2.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={handleConnect} disabled={connecting}>
                      {connecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <QrCode className="mr-2 h-4 w-4" />}
                      Gerar QR Code
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleDisconnect}
                      disabled={disconnecting || !data?.configured}
                    >
                      {disconnecting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Unplug className="mr-2 h-4 w-4" />}
                      Desconectar
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => void fetchEvolution()} disabled={loading}>
                      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                      Atualizar status
                    </Button>
                  </div>

                  {loading ? (
                    <p className="text-sm text-muted-foreground">Carregando status...</p>
                  ) : connected ? (
                    <Alert>
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Conectado</AlertTitle>
                      <AlertDescription>
                        {data?.channel?.profile_name || 'WhatsApp'} {data?.channel?.phone ? `(${data.channel.phone})` : ''}
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <Alert>
                      <AlertTitle>Status atual</AlertTitle>
                      <AlertDescription>
                        {data?.channel?.status || 'disconnected'}
                        {data?.channel?.last_error ? ` - ${data.channel.last_error}` : ''}
                      </AlertDescription>
                    </Alert>
                  )}

                  {qr ? (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">QR Code</p>
                      <img
                        src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`}
                        alt="QR Code Evolution"
                        className="h-64 w-64 rounded-md border border-border object-contain"
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
