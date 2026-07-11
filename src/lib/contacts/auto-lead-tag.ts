import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags'

const AUTO_NEW_LEAD_TAG_NAME = 'Novo Lead'
const AUTO_NEW_LEAD_TAG_KEY = AUTO_NEW_LEAD_TAG_NAME.toLowerCase()
const AUTO_NEW_LEAD_TAG_COLOR = '#7B61FF'

export async function attachAutoNewLeadTag(
  supabase: SupabaseClient,
  params: {
    accountId: string
    userId: string
    contactId: string
  },
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds(supabase, {
    accountId: params.accountId,
    userId: params.userId,
    tagNames: [AUTO_NEW_LEAD_TAG_NAME],
    canCreateTags: true,
    defaultColor: AUTO_NEW_LEAD_TAG_COLOR,
  })

  const tagId = tagIdByKey.get(AUTO_NEW_LEAD_TAG_KEY)
  if (!tagId) return

  const { error } = await supabase
    .from('contact_tags')
    .upsert(
      { contact_id: params.contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )

  if (error) throw error
}
