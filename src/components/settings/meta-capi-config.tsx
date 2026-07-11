'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Eye, EyeOff, FlaskConical, Loader2, Save } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';

interface MetaCapiConfigResponse {
  configured: boolean;
  enabled: boolean;
  dataset_id: string | null;
  test_event_code: string | null;
  has_token: boolean;
}

export function MetaCapiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [testEventCode, setTestEventCode] = useState('');

  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [tokenEdited, setTokenEdited] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);

  const [hasSavedDataset, setHasSavedDataset] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/meta-capi', { cache: 'no-store' });
      const data = (await res.json()) as MetaCapiConfigResponse & { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao carregar configuracao do Meta CAPI.');
        return;
      }

      setConfigured(data.configured);
      setEnabled(Boolean(data.enabled));
      setDatasetId(data.dataset_id ?? '');
      setTestEventCode(data.test_event_code ?? '');
      setHasStoredToken(Boolean(data.has_token));
      // Keep token input empty even when a token is already configured.
      setAccessToken('');
      setTokenEdited(false);
      setHasSavedDataset(Boolean(data.dataset_id && data.dataset_id.trim().length > 0));
    } catch {
      toast.error('Falha ao carregar configuracao do Meta CAPI.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    const nextDataset = datasetId.trim();
    const nextToken = accessToken.trim();
    const hasTokenAfterSave = tokenEdited
      ? nextToken.length > 0 || hasStoredToken
      : hasStoredToken;

    if (enabled && (!nextDataset || !hasTokenAfterSave)) {
      toast.error('Para ativar, salve Dataset ID e Access Token.');
      return;
    }

    setSaving(true);
    try {
      const body: {
        dataset_id: string | null;
        test_event_code: string | null;
        enabled: boolean;
        access_token?: string;
      } = {
        dataset_id: nextDataset || null,
        test_event_code: testEventCode.trim() || null,
        enabled,
      };
      if (tokenEdited) body.access_token = nextToken;

      const res = await fetch('/api/settings/meta-capi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao salvar configuracao do Meta CAPI.');
        return;
      }

      toast.success('Configuracao do Meta CAPI salva com sucesso.');
      await fetchConfig();
    } catch {
      toast.error('Falha ao salvar configuracao do Meta CAPI.');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/settings/meta-capi/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
      };

      if (!res.ok) {
        toast.error(data.error ?? 'Teste de conexao falhou.');
        return;
      }

      toast.success(data.message ?? 'Evento de teste enviado com sucesso.');
    } catch {
      toast.error('Teste de conexao falhou.');
    } finally {
      setTesting(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Carregando configuracao...
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const testDisabled = !canEdit || loading || testing || !hasStoredToken || !hasSavedDataset;
  const testReason = !hasSavedDataset
    ? 'Salve um Dataset ID para habilitar o teste.'
    : !hasStoredToken
      ? 'Salve um Access Token para habilitar o teste.'
      : 'Envia um evento de teste para o Dataset salvo.';

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      <SettingsPanelHead
        title="Integrations"
        description="Configure Meta Conversions API por conta."
      />

      {!canEdit && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Apenas admins podem alterar essa configuracao.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meta Conversions API</CardTitle>
          <CardDescription>
            O token nunca e retornado pela API. O campo fica vazio mesmo quando o token ja existe.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meta-capi-dataset">Dataset ID</Label>
              <Input
                id="meta-capi-dataset"
                value={datasetId}
                onChange={(e) => setDatasetId(e.target.value)}
                placeholder="123456789012345"
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="meta-capi-test-code">Test Event Code</Label>
              <Input
                id="meta-capi-test-code"
                value={testEventCode}
                onChange={(e) => setTestEventCode(e.target.value)}
                placeholder="TEST12345"
                disabled={disabled}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-capi-token">Access Token</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="meta-capi-token"
                  type={showToken ? 'text' : 'password'}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  placeholder="EAAG..."
                  disabled={disabled}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={testDisabled}
              >
                {testing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="mr-2 h-4 w-4" />
                )}
                Testar conexao
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {hasStoredToken
                ? 'Token configurado ✓ (deixe em branco para manter o atual)'
                : 'Nenhum token salvo.'}
            </p>
            <p className="text-xs text-muted-foreground">{testReason}</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Ativar Meta CAPI</p>
              <p className="text-xs text-muted-foreground">
                Quando ativado, os eventos poderao ser enviados usando esta configuracao.
              </p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={handleSave} disabled={disabled}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Salvar configuracao
            </Button>
            {configured && (
              <div className="inline-flex items-center rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                Configuracao encontrada para esta conta.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
