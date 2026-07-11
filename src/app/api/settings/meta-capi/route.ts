import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit';
import { encrypt } from '@/lib/whatsapp/encryption';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

interface ConfigBody {
  dataset_id: string | null;
  test_event_code: string | null;
  enabled: boolean;
  access_token?: string | null;
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data, error } = await supabase
      .from('meta_capi_config')
      .select('dataset_id, access_token, enabled, test_event_code')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[meta-capi GET] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load Meta CAPI configuration' },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json({
        configured: false,
        enabled: false,
        dataset_id: null,
        test_event_code: null,
        has_token: false,
      });
    }

    return NextResponse.json({
      configured: true,
      enabled: Boolean(data.enabled),
      dataset_id: data.dataset_id ?? null,
      test_event_code: data.test_event_code ?? null,
      has_token: Boolean(data.access_token),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit('meta-capi-config:' + userId, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as ConfigBody | null;
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    if (typeof body.enabled !== 'boolean') return bad('enabled must be boolean');
    if (body.dataset_id !== null && typeof body.dataset_id !== 'string') {
      return bad('dataset_id must be string or null');
    }
    if (body.test_event_code !== null && typeof body.test_event_code !== 'string') {
      return bad('test_event_code must be string or null');
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'access_token') &&
      body.access_token !== null &&
      typeof body.access_token !== 'string'
    ) {
      return bad('access_token must be string, null, or omitted');
    }

    const datasetId = body.dataset_id ? body.dataset_id.trim() : null;
    const testEventCode = body.test_event_code ? body.test_event_code.trim() : null;
    const tokenProvided = Object.prototype.hasOwnProperty.call(body, 'access_token');
    const rawToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';

    const { data: existing, error: existingError } = await supabase
      .from('meta_capi_config')
      .select('id, access_token')
      .eq('account_id', accountId)
      .maybeSingle();

    if (existingError) {
      console.error('[meta-capi POST] existing fetch error:', existingError);
      return NextResponse.json(
        { error: 'Failed to save Meta CAPI configuration' },
        { status: 500 },
      );
    }

    const hasTokenAfterSave = tokenProvided
      ? rawToken.length > 0 || Boolean(existing?.access_token)
      : Boolean(existing?.access_token);

    if (body.enabled && (!datasetId || !hasTokenAfterSave)) {
      return bad('enabled requires a saved dataset_id and access_token');
    }

    const payload: Record<string, unknown> = {
      dataset_id: datasetId,
      test_event_code: testEventCode,
      enabled: body.enabled,
    };

    // Keep existing token when omitted or sent as empty string.
    if (tokenProvided && rawToken) {
      payload.access_token = encrypt(rawToken);
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('meta_capi_config')
        .update(payload)
        .eq('account_id', accountId);

      if (updateError) {
        console.error('[meta-capi POST] update error:', updateError);
        return NextResponse.json(
          { error: 'Failed to save Meta CAPI configuration' },
          { status: 500 },
        );
      }
    } else {
      const insertPayload: Record<string, unknown> = {
        account_id: accountId,
        created_by: userId,
        dataset_id: datasetId,
        test_event_code: testEventCode,
        enabled: body.enabled,
        access_token: tokenProvided && rawToken ? encrypt(rawToken) : null,
      };

      const { error: insertError } = await supabase
        .from('meta_capi_config')
        .insert(insertPayload);

      if (insertError) {
        console.error('[meta-capi POST] insert error:', insertError);
        return NextResponse.json(
          { error: 'Failed to save Meta CAPI configuration' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
