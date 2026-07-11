import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';

const META_API_VERSION = 'v21.0';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = 'Meta API error: ' + response.status;
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
    };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit('meta-capi-test:' + userId, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { data, error } = await supabase
      .from('meta_capi_config')
      .select('dataset_id, access_token, test_event_code')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[meta-capi test] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load Meta CAPI configuration' },
        { status: 500 },
      );
    }

    if (!data?.dataset_id || !data?.access_token) {
      return bad('Configure dataset_id and access_token before running the test.');
    }

    let plainToken = '';
    try {
      plainToken = decrypt(data.access_token);
    } catch {
      return bad('Stored access token could not be decrypted. Please save it again.');
    }

    const eventTime = Math.floor(Date.now() / 1000);
    const eventId = 'wacrm-test-' + String(Date.now());
    const payload: {
      data: Array<{
        event_name: string;
        event_time: number;
        action_source: string;
        event_id: string;
        user_data: { client_user_agent: string };
      }>;
      test_event_code?: string;
    } = {
      data: [
        {
          event_name: 'Lead',
          event_time: eventTime,
          action_source: 'system_generated',
          event_id: eventId,
          user_data: {
            client_user_agent: 'wacrm-meta-capi-test',
          },
        },
      ],
    };
    if (data.test_event_code) payload.test_event_code = data.test_event_code;

    const params = new URLSearchParams({ access_token: plainToken });
    const url =
      'https://graph.facebook.com/' +
      META_API_VERSION +
      '/' +
      encodeURIComponent(data.dataset_id) +
      '/events?' +
      params.toString();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const message = await readErrorMessage(response);
      return NextResponse.json(
        { error: 'Meta CAPI test failed: ' + message },
        { status: 400 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Evento de teste enviado com sucesso ao Meta CAPI.',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
