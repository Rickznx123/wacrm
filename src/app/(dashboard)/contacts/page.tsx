'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
  RefreshCw,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';
import { ASCENT, ASCENT_INTERACTIVE } from '@/lib/ui/ascent';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  const supabase = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Whether a connected Evolution WhatsApp channel exists — gates the
  // "Sync from WhatsApp" button, since the import endpoint 400s without one.
  const [evolutionConnected, setEvolutionConnected] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [supabase]);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;

    if (selectedTagIds.length > 0) {
      // Tag filter active — resolve it server-side (join + distinct +
      // windowed total count + pagination) so a tag covering many
      // contacts can't silently truncate the result or overflow an IN
      // clause. See migration 025_filter_contacts_by_tags.
      const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let query = supabase
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (term) {
        const like = `%${term}%`;
        query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
      }

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = contactRows.map((c) => c.id);
    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    const enriched: ContactWithTags[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [supabase, page, search, selectedTagIds, tagsMap, t]);

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  // Check once on mount whether an Evolution channel is connected so the
  // "Sync from WhatsApp" button only shows when the import can succeed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/whatsapp/evolution/qrcode', {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { connected?: boolean };
        if (!cancelled) setEvolutionConnected(Boolean(payload.connected));
      } catch {
        // Leave the button hidden if the status check fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  async function handleSyncFromWhatsApp() {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/evolution/contacts/import', {
        method: 'POST',
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        toast.error(body?.error ?? t('toastSyncFailed'));
        return;
      }

      toast.success(
        t('toastSyncSuccess', {
          imported: body?.imported ?? 0,
          skipped: body?.skipped ?? 0,
        })
      );
      fetchContacts();
    } catch {
      toast.error(t('toastSyncFailed'));
    } finally {
      setSyncing(false);
    }
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    const { error } = await supabase.from('contacts').delete().in('id', ids);

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count: ids.length }));
      setSelected(new Set());
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0;

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  return (
    <div
      className={`relative -m-4 min-h-[calc(100vh-0px)] overflow-hidden p-6 sm:-m-6 sm:p-10 space-y-8 ${ASCENT.canvas}`}
    >
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute -left-20 top-12 h-80 w-80 rounded-full bg-[#7B61FF]/14 blur-3xl" />
        <div className="absolute -right-24 bottom-12 h-[28rem] w-[28rem] rounded-full bg-[#FF4F8A]/9 blur-3xl" />
      </div>
      {/* Header */}
      <div className={`relative flex flex-col gap-6 rounded-2xl border border-white/10 bg-[linear-gradient(160deg,rgba(13,14,20,0.82),rgba(42,27,77,0.22)_55%,rgba(13,14,20,0.78))] p-6 shadow-[0_18px_48px_rgba(7,8,18,0.38),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-[8px] sm:p-7 ${ASCENT.panel}`}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
          <h1 className={`text-3xl font-bold tracking-tight ${ASCENT.title}`}>
            {t('title')}
          </h1>
            <p className={`text-sm font-normal ${ASCENT.subtle}`}>
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
          </p>
          </div>
          {/* Ações — só "Adicionar Contato" tem destaque total; o resto discreto. */}
          <div className="flex flex-wrap items-center gap-2.5">
          {canEditSettings && (
            <Button
              variant="ghost"
              onClick={() => setCustomFieldsOpen(true)}
              className={`h-11 px-4 ${ASCENT.ghost} ${ASCENT_INTERACTIVE}`}
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          {evolutionConnected &&
            (canEditSettings ? (
              <GatedButton
                variant="outline"
                canAct={canEditSettings}
                gateReason="sync contacts from WhatsApp"
                onClick={handleSyncFromWhatsApp}
                disabled={syncing}
                className={`h-11 px-4 ${ASCENT.outline} ${ASCENT_INTERACTIVE}`}
              >
                {syncing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {syncing ? t('syncingEvolution') : t('syncEvolutionBtn')}
              </GatedButton>
            ) : (
              <div className="flex flex-col items-start gap-1">
                <Button
                  variant="outline"
                  disabled
                  className={`h-11 px-4 ${ASCENT.outline} opacity-60`}
                >
                  <RefreshCw className="size-4" />
                  {t('syncEvolutionBtn')}
                </Button>
                <p className={`text-xs ${ASCENT.subtle}`}>{t('syncAdminOnly')}</p>
              </div>
            ))}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={() => setImportOpen(true)}
            className={`h-11 px-4 ${ASCENT.outline} ${ASCENT_INTERACTIVE}`}
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason="add or import contacts"
            onClick={openAddForm}
            className={`h-11 px-4 font-medium ${ASCENT.primaryGradient} ${ASCENT_INTERACTIVE}`}
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
          </div>
        </div>
        {/* Search + tag filter */}
        <div className="space-y-3 pt-1">
          <div className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative w-full max-w-sm">
              <Search className={`absolute left-3 top-1/2 -translate-y-1/2 size-4 ${ASCENT.subtle}`} />
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  // Reset pagination when the query changes — the result
                  // set shrinks/grows, page N may no longer be valid.
                  setPage(0);
                }}
                placeholder={t('searchPlaceholder')}
                className={`h-11 rounded-xl border-white/12 bg-white/[0.03] pl-9 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ${ASCENT.field}`}
              />
            </div>

            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    className={`h-11 shrink-0 border-white/12 bg-white/[0.03] hover:bg-[#7B61FF]/10 ${ASCENT.outline}`}
                  />
                }
              >
                <Filter className="size-4" />
                {t('filterByTags')}
                {selectedTagIds.length > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center rounded-full bg-[#FF4F8A] px-1.5 text-[10px] font-semibold text-white">
                    {selectedTagIds.length}
                  </span>
                )}
              </PopoverTrigger>
              <PopoverContent align="start" className={`w-64 rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(19,21,33,0.98),rgba(30,20,56,0.94)_60%,rgba(14,15,24,0.98))] p-0 shadow-[0_20px_44px_rgba(6,8,18,0.5)] backdrop-blur-xl ${ASCENT.popover}`}>
                <div className={`flex items-center justify-between px-4 py-3 border-b ${ASCENT.divider}`}>
                  <span className={`text-sm font-medium ${ASCENT.title}`}>
                    {t('filterByTags')}
                  </span>
                  {selectedTagIds.length > 0 && (
                    <button
                      onClick={clearTagFilters}
                      className={`text-xs ${ASCENT.subtle} hover:${ASCENT.title}`}
                    >
                      {t('clearAll')}
                    </button>
                  )}
                </div>
                {allTags.length === 0 ? (
                  <p className={`px-4 py-5 text-sm text-center ${ASCENT.subtle}`}>
                    {t('noTagsYet')}
                  </p>
                ) : (
                  <div className="max-h-64 overflow-y-auto py-1.5">
                    {allTags.map((tag) => (
                      <label
                        key={tag.id}
                        className="flex items-center gap-2.5 px-4 py-2 cursor-pointer hover:bg-[var(--ascent-hover)]"
                      >
                        <Checkbox
                          checked={selectedTagIds.includes(tag.id)}
                          onCheckedChange={() => toggleTagFilter(tag.id)}
                          aria-label={`Filter by ${tag.name}`}
                        />
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                        <span className={`text-sm truncate ${ASCENT.body}`}>
                          {tag.name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>

          {/* Active tag-filter chips */}
          {selectedTagIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedTagIds.map((id) => {
                const tag = tagsMap[id];
                if (!tag) return null;
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      backgroundColor: tag.color + '20',
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    <button
                      onClick={() => toggleTagFilter(id)}
                      aria-label={`Remove ${tag.name} filter`}
                      className="hover:opacity-70"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                );
              })}
              <button
                onClick={clearTagFilters}
                className={`text-xs ${ASCENT.subtle} hover:${ASCENT.title} px-1`}
              >
                {t('clearAll')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className={`flex items-center justify-between gap-4 rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015)_58%,rgba(255,255,255,0.01))] px-5 py-3 shadow-[0_14px_34px_rgba(7,8,18,0.34)] ${ASCENT.card}`}>
          <p className={`text-sm ${ASCENT.body}`}>
            <span className="inline-flex items-center justify-center rounded-full bg-[#FF4F8A] px-2 py-0.5 mr-2 text-xs font-semibold text-white">
              {selected.size}
            </span>
            {t('selectedCount', { count: selected.size })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className={ASCENT.ghost}
            >
              {t('clearSelection')}
            </Button>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason="delete contacts"
              onClick={() => setBulkDeleteOpen(true)}
              className="rounded-xl"
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Table */}
      <div className={`overflow-hidden rounded-2xl border border-white/12 bg-[linear-gradient(170deg,rgba(255,255,255,0.05),rgba(255,255,255,0.016)_56%,rgba(255,255,255,0.01))] shadow-[0_16px_36px_rgba(7,8,18,0.36)] ${ASCENT.panel}`}>
        <Table>
          <TableHeader>
            <TableRow className={`hover:bg-transparent border-b border-white/10 bg-[linear-gradient(180deg,rgba(123,97,255,0.12),rgba(255,255,255,0.02)_60%,transparent)] ${ASCENT.divider}`}>
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label="Select all contacts on this page"
                />
              </TableHead>
              <TableHead className={`${ASCENT.subtle} font-medium`}>{t('tableColumns.name')}</TableHead>
              <TableHead className={`${ASCENT.subtle} font-medium`}>{t('tableColumns.phone')}</TableHead>
              <TableHead className={`${ASCENT.subtle} font-medium hidden md:table-cell`}>{t('tableColumns.email')}</TableHead>
              <TableHead className={`${ASCENT.subtle} font-medium hidden lg:table-cell`}>{t('tableColumns.company')}</TableHead>
              <TableHead className={`${ASCENT.subtle} font-medium hidden md:table-cell`}>{t('tableColumns.tags')}</TableHead>
              <TableHead className={`${ASCENT.subtle} font-medium hidden lg:table-cell`}>{t('tableColumns.createdAt')}</TableHead>
              <TableHead className={`${ASCENT.subtle} w-12`} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className={ASCENT.divider}>
                <TableCell colSpan={8} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-[#7B61FF]" />
                    <p className={`text-sm ${ASCENT.subtle}`}>{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className={ASCENT.divider}>
                <TableCell colSpan={8} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-[#6C7082]" />
                    <p className={`text-sm ${ASCENT.subtle}`}>
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="add or import contacts"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className={`mt-2 ${ASCENT.outline} ${ASCENT_INTERACTIVE}`}
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className={`cursor-pointer border-b border-white/8 last:border-b-0 ${ASCENT.divider} ${ASCENT.row}`}
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell className="py-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={`Select ${contact.name || contact.phone}`}
                    />
                  </TableCell>
                  <TableCell className={`py-4 font-medium ${ASCENT.title}`}>
                    {contact.name || <span className={`${ASCENT.subtle} italic`}>{t('unnamed')}</span>}
                  </TableCell>
                  <TableCell className="py-4 text-[var(--ascent-body)] font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className={`py-4 hidden md:table-cell text-sm ${ASCENT.body}`}>
                    {contact.email || <span className={ASCENT.subtle}>-</span>}
                  </TableCell>
                  <TableCell className={`py-4 hidden lg:table-cell text-sm ${ASCENT.body}`}>
                    {contact.company || <span className={ASCENT.subtle}>-</span>}
                  </TableCell>
                  <TableCell className="py-4 hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className={`${ASCENT.subtle} text-xs`}>-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className={`text-[10px] ${ASCENT.subtle}`}>
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={`py-4 text-xs hidden lg:table-cell ${ASCENT.subtle}`}>
                    {new Date(contact.created_at).toLocaleDateString('pt-BR', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell className="py-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={`text-[var(--ascent-subtle)] hover:text-[var(--ascent-title)] hover:bg-[var(--ascent-hover)]`}
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className={ASCENT.popover}
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-[var(--ascent-body)] focus:bg-[var(--ascent-hover)] focus:text-[var(--ascent-title)]"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className={ASCENT.divider} />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className={`text-xs ${ASCENT.subtle}`}>
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className={`${ASCENT.outline} ${ASCENT_INTERACTIVE} disabled:opacity-30`}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className={`text-xs px-2 ${ASCENT.subtle}`}>
              {t('pageCount', { page: page + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className={`${ASCENT.outline} ${ASCENT_INTERACTIVE} disabled:opacity-30`}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className={`sm:max-w-sm ${ASCENT.popover}`}>
          <DialogHeader>
            <DialogTitle className={ASCENT.title}>{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className={ASCENT.subtle}>
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className={`${ASCENT.outline} ${ASCENT_INTERACTIVE}`}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className={`sm:max-w-sm ${ASCENT.popover}`}>
          <DialogHeader>
            <DialogTitle className={ASCENT.title}>
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className={ASCENT.subtle}>
              {t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className={`${ASCENT.outline} ${ASCENT_INTERACTIVE}`}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
