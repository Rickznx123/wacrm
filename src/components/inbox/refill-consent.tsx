"use client";

import { useEffect, useMemo, useState } from "react";
import { Repeat } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { hasMinRole } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/client";
import { Switch } from "@/components/ui/switch";

interface Prefs {
  opted_in: boolean;
  opted_out_at: string | null;
  allow_health_details: boolean;
}

/**
 * Recompra consent for one contact (migration 045). No row = not
 * authorized. Renders nothing if the module's tables aren't there yet.
 */
export function RefillConsent({ contactId }: { contactId: string }) {
  const { accountId, accountRole, user } = useAuth();
  const canEdit = accountRole ? hasMinRole(accountRole, "agent") : false;
  const supabase = useMemo(() => createClient(), []);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void supabase
      .from("refill_contact_preferences")
      .select("opted_in, opted_out_at, allow_health_details")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        setAvailable(!error);
        setPrefs((data as Prefs | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, contactId, supabase]);

  if (!available) return null;

  const save = async (patch: Partial<Prefs> & Record<string, unknown>) => {
    const { error } = await supabase.from("refill_contact_preferences").upsert(
      { account_id: accountId, contact_id: contactId, updated_by: user?.id ?? null, ...patch },
      { onConflict: "account_id,contact_id" },
    );
    if (error) {
      toast.error("Não foi possível salvar a autorização.");
      return;
    }
    setPrefs((prev) => ({
      opted_in: false,
      opted_out_at: null,
      allow_health_details: false,
      ...prev,
      ...(patch as Partial<Prefs>),
    }));
  };

  const now = () => new Date().toISOString();

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Repeat className="h-3 w-3" />
        Lembretes de recompra
      </div>
      <label className="mt-2 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        Cliente autorizou receber
        <Switch
          checked={!!prefs?.opted_in}
          disabled={!canEdit}
          onCheckedChange={(v) =>
            save(
              v
                ? { opted_in: true, opted_in_at: now(), opted_in_source: "manual", opted_out_at: null }
                : { opted_in: false, opted_out_at: now() },
            )
          }
        />
      </label>
      <label className="mt-2 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        Pode citar o nome do medicamento
        <Switch
          checked={!!prefs?.allow_health_details}
          disabled={!canEdit || !prefs?.opted_in}
          onCheckedChange={(v) => save({ allow_health_details: v })}
        />
      </label>
      {prefs?.opted_out_at && !prefs.opted_in ? (
        <p className="mt-1 px-1 text-[11px] text-muted-foreground">
          Descadastrado em {new Date(prefs.opted_out_at).toLocaleDateString("pt-BR")}
        </p>
      ) : null}
    </div>
  );
}
