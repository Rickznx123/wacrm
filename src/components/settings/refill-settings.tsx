'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings, hasMinRole } from '@/lib/auth/roles';
import { createClient } from '@/lib/supabase/client';
import {
  REFILL_SETTINGS_DEFAULTS,
  renderReminderMessage,
  type RefillProduct,
  type RefillSettings as Settings,
} from '@/lib/refill/core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from './settings-panel-head';

const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring';

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendente',
  sending: 'Enviando',
  sent: 'Enviado',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

const REASON_LABEL: Record<string, string> = {
  sem_autorizacao: 'sem autorização do cliente',
  descadastrado: 'cliente descadastrado',
  produto_desativado: 'produto desativado',
  expirado: 'expirado',
  recomprado: 'cliente comprou de novo',
  manual: 'cancelado manualmente',
};

interface ServerStatus {
  sendingAllowedByEnv: boolean;
  ponteConfigured: boolean;
  ponteBound: boolean;
}

interface ReminderRow {
  id: string;
  status: string;
  cancel_reason: string | null;
  scheduled_for: string;
  sent_at: string | null;
  last_error: string | null;
  contact: { name: string | null; phone: string } | null;
  product: { name: string } | null;
}

const EMPTY_PRODUCT = {
  external_product_id: '',
  name: '',
  days_per_unit: '30',
  lead_days: '',
  quantity_based: true,
  sensitive: true,
};

const PREVIEW_END_DATE = new Date('2026-12-15T15:00:00Z');

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

export function RefillSettings() {
  const { accountId, accountRole } = useAuth();
  const isAdmin = accountRole ? canEditSettings(accountRole) : false;
  const isAgent = accountRole ? hasMinRole(accountRole, 'agent') : false;
  const supabase = useMemo(() => createClient(), []);

  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<Settings>(REFILL_SETTINGS_DEFAULTS);
  const [lastSync, setLastSync] = useState<Record<string, unknown> | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [products, setProducts] = useState<RefillProduct[]>([]);
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [newProduct, setNewProduct] = useState(EMPTY_PRODUCT);
  const [purchase, setPurchase] = useState({ phone: '', name: '', product_id: '', quantity: '1', purchased_at: '' });

  const loadReminders = useCallback(async () => {
    if (!accountId) return;
    let query = supabase
      .from('refill_reminders')
      .select('id, status, cancel_reason, scheduled_for, sent_at, last_error, contact:contacts(name, phone), product:refill_products(name)')
      .eq('account_id', accountId)
      .order('scheduled_for', { ascending: false })
      .limit(100);
    if (statusFilter !== 'all') query = query.eq('status', statusFilter);
    const { data, error } = await query;
    if (error) toast.error('Falha ao carregar o histórico de lembretes.');
    setReminders((data ?? []) as unknown as ReminderRow[]);
  }, [accountId, statusFilter, supabase]);

  const loadAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [settingsRes, productsRes, serverRes] = await Promise.all([
      supabase
        .from('refill_settings')
        .select('enabled, sending_enabled, default_lead_days, message_template, sensitive_message_template, last_sync_summary')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('refill_products')
        .select('id, external_product_id, name, days_per_unit, quantity_based, lead_days, sensitive, active')
        .eq('account_id', accountId)
        .order('name'),
      fetch('/api/refill/sync', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (settingsRes.error || productsRes.error) {
      toast.error('Falha ao carregar a Recompra. A migração 045 já foi aplicada?');
    }
    if (settingsRes.data) {
      const { last_sync_summary, ...rest } = settingsRes.data as Settings & { last_sync_summary: Record<string, unknown> | null };
      setSettings(rest);
      setLastSync(last_sync_summary);
    }
    setProducts((productsRes.data ?? []) as RefillProduct[]);
    setServer(serverRes as ServerStatus | null);
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
  }, [loadAll]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReminders();
  }, [loadReminders]);

  const saveSettings = async (patch: Partial<Settings> = {}) => {
    if (!accountId) return;
    const next = { ...settings, ...patch };
    setSaving(true);
    const { error } = await supabase
      .from('refill_settings')
      .upsert({ account_id: accountId, ...next }, { onConflict: 'account_id' });
    setSaving(false);
    if (error) {
      toast.error(`Não foi possível salvar: ${error.message}`);
      return;
    }
    setSettings(next);
    toast.success('Configurações da Recompra salvas.');
  };

  const syncNow = async () => {
    setSyncing(true);
    const res = await fetch('/api/refill/sync', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    setSyncing(false);
    if (!res.ok || !body.ok) toast.error(body.error ?? 'Falha ao sincronizar com a PONTE.');
    else toast.success(`Sincronizado: ${body.purchasesCreated} compra(s) nova(s).`);
    void loadAll();
    void loadReminders();
  };

  const addProduct = async () => {
    if (!accountId) return;
    const days = Number(newProduct.days_per_unit);
    const lead = newProduct.lead_days === '' ? null : Number(newProduct.lead_days);
    if (!newProduct.external_product_id.trim() || !newProduct.name.trim() || !(days >= 1 && days <= 365)) {
      toast.error('Preencha código, nome e uma duração entre 1 e 365 dias.');
      return;
    }
    const { error } = await supabase.from('refill_products').insert({
      account_id: accountId,
      external_product_id: newProduct.external_product_id.trim(),
      name: newProduct.name.trim(),
      days_per_unit: days,
      lead_days: lead,
      quantity_based: newProduct.quantity_based,
      sensitive: newProduct.sensitive,
    });
    if (error) {
      toast.error(error.code === '23505' ? 'Já existe um produto com esse código.' : error.message);
      return;
    }
    setNewProduct(EMPTY_PRODUCT);
    void loadAll();
  };

  const updateProduct = async (id: string, patch: Partial<RefillProduct>) => {
    const { error } = await supabase.from('refill_products').update(patch).eq('id', id);
    if (error) toast.error(error.message);
    else setProducts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const deleteProduct = async (id: string) => {
    if (!confirm('Excluir o produto apaga também as compras e lembretes dele. Continuar?')) return;
    const { error } = await supabase.from('refill_products').delete().eq('id', id);
    if (error) toast.error(error.message);
    else void loadAll();
  };

  const registerPurchase = async () => {
    const res = await fetch('/api/refill/purchases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...purchase,
        quantity: Number(purchase.quantity),
        purchased_at: purchase.purchased_at ? new Date(`${purchase.purchased_at}T12:00:00`).toISOString() : undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? 'Falha ao registrar a compra.');
      return;
    }
    toast.success('Compra registrada e lembrete agendado.');
    setPurchase({ phone: '', name: '', product_id: '', quantity: '1', purchased_at: '' });
    void loadReminders();
  };

  const cancelReminder = async (id: string) => {
    const { error } = await supabase
      .from('refill_reminders')
      .update({ status: 'cancelled', cancel_reason: 'manual' })
      .eq('id', id)
      .eq('status', 'pending');
    if (error) toast.error(error.message);
    else void loadReminders();
  };

  const preview = useMemo(() => {
    const sample = { name: 'Fralda G', sensitive: false };
    const end = PREVIEW_END_DATE;
    return {
      normal: renderReminderMessage(settings, sample, null, 'Maria Souza', end),
      sensitive: renderReminderMessage(settings, { ...sample, sensitive: true }, null, 'Maria Souza', end),
    };
  }, [settings]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title="Recompra automática"
        description="Lembra o cliente pelo WhatsApp quando um produto de uso contínuo (fralda, leite, medicamento) está perto de acabar. Usa só as mensagens abaixo — sem IA."
      />

      {/* Status */}
      <Card>
        <CardHeader>
          <CardTitle>Funcionamento</CardTitle>
          <CardDescription>
            Mensagens reais só saem com as três travas liberadas: módulo ativo, envio real ativo e
            <code className="mx-1">REFILL_SENDING_ENABLED=true</code> no servidor. Sem isso, o cron só agenda e
            registra (modo simulação).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="refill-enabled">Ativar recompra (importar vendas e agendar lembretes)</Label>
            <Switch
              id="refill-enabled"
              checked={settings.enabled}
              disabled={!isAdmin || saving}
              onCheckedChange={(v) => saveSettings({ enabled: v })}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="refill-sending">Envio real de mensagens pelo WhatsApp</Label>
            <Switch
              id="refill-sending"
              checked={settings.sending_enabled}
              disabled={!isAdmin || saving}
              onCheckedChange={(v) => {
                if (v && !confirm('Ativar o envio real? Clientes autorizados vão receber mensagens.')) return;
                void saveSettings({ sending_enabled: v });
              }}
            />
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>Trava do servidor: {server?.sendingAllowedByEnv ? 'liberada' : 'bloqueada (simulação)'}</li>
            <li>
              PONTE: {server?.ponteConfigured ? 'configurada' : 'não configurada'}
              {server?.ponteConfigured ? (server.ponteBound ? ', vinculada a esta conta' : ', vinculada a outra conta') : ''}
            </li>
            {lastSync ? (
              <li>
                Última sincronização: {fmtDate(String(lastSync.at))} —{' '}
                {lastSync.ok
                  ? `${lastSync.purchasesCreated} nova(s), ${lastSync.duplicates} repetida(s), ${lastSync.invalidPhone} telefone(s) inválido(s)`
                  : `erro: ${String(lastSync.error)}`}
              </li>
            ) : null}
          </ul>
          {isAdmin ? (
            <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing || !server?.ponteBound}>
              {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Sincronizar agora
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* Messages */}
      <Card>
        <CardHeader>
          <CardTitle>Mensagens</CardTitle>
          <CardDescription>
            Variáveis: {'{nome}'}, {'{primeiro_nome}'}, {'{produto}'}, {'{data_prevista}'}. Produtos sensíveis
            (medicamentos) usam a mensagem genérica, sem o nome do produto, a menos que o cliente autorize.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-[12rem] space-y-1.5">
            <Label htmlFor="refill-lead">Avisar quantos dias antes</Label>
            <Input
              id="refill-lead"
              type="number"
              min={0}
              max={60}
              value={settings.default_lead_days}
              disabled={!isAdmin}
              onChange={(e) => setSettings((s) => ({ ...s, default_lead_days: Number(e.target.value) }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-msg">Mensagem padrão</Label>
            <Textarea
              id="refill-msg"
              rows={3}
              maxLength={1000}
              value={settings.message_template}
              disabled={!isAdmin}
              onChange={(e) => setSettings((s) => ({ ...s, message_template: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Prévia: {preview.normal}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refill-msg-sensitive">Mensagem para produtos sensíveis</Label>
            <Textarea
              id="refill-msg-sensitive"
              rows={3}
              maxLength={1000}
              value={settings.sensitive_message_template}
              disabled={!isAdmin}
              onChange={(e) => setSettings((s) => ({ ...s, sensitive_message_template: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Prévia: {preview.sensitive}</p>
          </div>
          {isAdmin ? (
            <Button
              size="sm"
              disabled={saving || !(settings.default_lead_days >= 0 && settings.default_lead_days <= 60)}
              onClick={() => saveSettings()}
            >
              <Save className="size-4" /> Salvar mensagens
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* Products */}
      <Card>
        <CardHeader>
          <CardTitle>Produtos de uso contínuo</CardTitle>
          <CardDescription>
            O código é o mesmo do Inova Farma (produto_id da PONTE). A duração é por unidade; com
            &quot;soma pela quantidade&quot;, 2 unidades de 30 dias viram 60 dias.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {products.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum produto cadastrado.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Código</th>
                    <th className="py-2 pr-3">Nome</th>
                    <th className="py-2 pr-3">Dias/un.</th>
                    <th className="py-2 pr-3">Antecedência</th>
                    <th className="py-2 pr-3">Soma qtd.</th>
                    <th className="py-2 pr-3">Sensível</th>
                    <th className="py-2 pr-3">Ativo</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id} className="border-t border-border">
                      <td className="py-2 pr-3 font-mono text-xs">{p.external_product_id}</td>
                      <td className="py-2 pr-3">{p.name}</td>
                      <td className="py-2 pr-3">{p.days_per_unit}</td>
                      <td className="py-2 pr-3">{p.lead_days ?? `padrão (${settings.default_lead_days})`}</td>
                      <td className="py-2 pr-3">
                        <Switch checked={p.quantity_based} disabled={!isAdmin} onCheckedChange={(v) => updateProduct(p.id, { quantity_based: v })} />
                      </td>
                      <td className="py-2 pr-3">
                        <Switch checked={p.sensitive} disabled={!isAdmin} onCheckedChange={(v) => updateProduct(p.id, { sensitive: v })} />
                      </td>
                      <td className="py-2 pr-3">
                        <Switch checked={p.active} disabled={!isAdmin} onCheckedChange={(v) => updateProduct(p.id, { active: v })} />
                      </td>
                      <td className="py-2">
                        {isAdmin ? (
                          <Button variant="ghost" size="icon" aria-label={`Excluir ${p.name}`} onClick={() => deleteProduct(p.id)}>
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {isAdmin ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="np-code">Código no Inova</Label>
                <Input id="np-code" value={newProduct.external_product_id} onChange={(e) => setNewProduct((s) => ({ ...s, external_product_id: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-name">Nome</Label>
                <Input id="np-name" value={newProduct.name} onChange={(e) => setNewProduct((s) => ({ ...s, name: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-days">Dias por unidade</Label>
                <Input id="np-days" type="number" min={1} max={365} value={newProduct.days_per_unit} onChange={(e) => setNewProduct((s) => ({ ...s, days_per_unit: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="np-lead">Antecedência (vazio = padrão)</Label>
                <Input id="np-lead" type="number" min={0} max={60} value={newProduct.lead_days} onChange={(e) => setNewProduct((s) => ({ ...s, lead_days: e.target.value }))} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={newProduct.quantity_based} onCheckedChange={(v) => setNewProduct((s) => ({ ...s, quantity_based: v }))} />
                Soma pela quantidade
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={newProduct.sensitive} onCheckedChange={(v) => setNewProduct((s) => ({ ...s, sensitive: v }))} />
                Sensível (saúde)
              </label>
              <div className="sm:col-span-2 lg:col-span-2 lg:text-right">
                <Button size="sm" onClick={addProduct}>Adicionar produto</Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Manual purchase */}
      {isAgent ? (
        <Card>
          <CardHeader>
            <CardTitle>Registrar compra manualmente</CardTitle>
            <CardDescription>Para vendas que não vêm pela PONTE ou para testar o agendamento.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label htmlFor="mp-phone">Celular com DDD</Label>
              <Input id="mp-phone" value={purchase.phone} onChange={(e) => setPurchase((s) => ({ ...s, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-name">Nome (opcional)</Label>
              <Input id="mp-name" value={purchase.name} onChange={(e) => setPurchase((s) => ({ ...s, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-product">Produto</Label>
              <select id="mp-product" className={SELECT_CLASS} value={purchase.product_id} onChange={(e) => setPurchase((s) => ({ ...s, product_id: e.target.value }))}>
                <option value="">Selecione…</option>
                {products.filter((p) => p.active).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-qty">Quantidade</Label>
              <Input id="mp-qty" type="number" min={1} value={purchase.quantity} onChange={(e) => setPurchase((s) => ({ ...s, quantity: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-date">Data da compra</Label>
              <Input id="mp-date" type="date" value={purchase.purchased_at} onChange={(e) => setPurchase((s) => ({ ...s, purchased_at: e.target.value }))} />
            </div>
            <div className="sm:col-span-2 lg:col-span-5">
              <Button size="sm" disabled={!purchase.phone || !purchase.product_id} onClick={registerPurchase}>
                Registrar compra
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* History */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Histórico de lembretes</CardTitle>
            <CardDescription>Últimos 100. Cancelados mostram o motivo.</CardDescription>
          </div>
          <select aria-label="Filtrar por status" className={`${SELECT_CLASS} max-w-[10rem]`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">Todos</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </CardHeader>
        <CardContent>
          {reminders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum lembrete.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Cliente</th>
                    <th className="py-2 pr-3">Produto</th>
                    <th className="py-2 pr-3">Agendado</th>
                    <th className="py-2 pr-3">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {reminders.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-2 pr-3">{r.contact?.name || r.contact?.phone || '—'}</td>
                      <td className="py-2 pr-3">{r.product?.name ?? '—'}</td>
                      <td className="py-2 pr-3">{fmtDate(r.scheduled_for)}</td>
                      <td className="py-2 pr-3">
                        {STATUS_LABEL[r.status] ?? r.status}
                        {r.cancel_reason ? ` (${REASON_LABEL[r.cancel_reason] ?? r.cancel_reason})` : ''}
                        {r.status === 'failed' && r.last_error ? (
                          <span className="block text-xs text-destructive">{r.last_error}</span>
                        ) : null}
                      </td>
                      <td className="py-2 text-right">
                        {r.status === 'pending' && isAgent ? (
                          <Button variant="ghost" size="sm" onClick={() => cancelReminder(r.id)}>Cancelar</Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
