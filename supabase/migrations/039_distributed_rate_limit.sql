-- ============================================================
-- Distributed rate limiting (serverless-safe)
--
-- Shared counter backed by Postgres for multi-instance deployments.
-- Intended for server-side routes that need consistent limits across
-- Vercel/serverless replicas.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_updated_at
  ON public.rate_limit_counters(updated_at);

CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_scope TEXT,
  p_key TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER,
  p_now TIMESTAMPTZ DEFAULT NOW()
) RETURNS TABLE (
  allowed BOOLEAN,
  remaining INTEGER,
  reset_at TIMESTAMPTZ,
  current_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, NOW());
  v_window_start TIMESTAMPTZ;
  v_reset_at TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  IF p_scope IS NULL OR p_scope = '' THEN
    RAISE EXCEPTION 'p_scope is required' USING ERRCODE = '22023';
  END IF;
  IF p_key IS NULL OR p_key = '' THEN
    RAISE EXCEPTION 'p_key is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit <= 0 THEN
    RAISE EXCEPTION 'p_limit must be > 0' USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'p_window_seconds must be > 0' USING ERRCODE = '22023';
  END IF;

  v_window_start := to_timestamp(
    floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds
  );
  v_reset_at := v_window_start + make_interval(secs => p_window_seconds);

  INSERT INTO public.rate_limit_counters(scope, key, window_start, count, updated_at)
  VALUES (p_scope, p_key, v_window_start, 1, v_now)
  ON CONFLICT (scope, key, window_start)
  DO UPDATE SET
    count = public.rate_limit_counters.count + 1,
    updated_at = v_now
  RETURNING count INTO v_count;

  DELETE FROM public.rate_limit_counters
  WHERE scope = p_scope
    AND key = p_key
    AND window_start < (v_window_start - make_interval(secs => p_window_seconds * 2));

  allowed := v_count <= p_limit;
  remaining := GREATEST(p_limit - v_count, 0);
  reset_at := v_reset_at;
  current_count := v_count;

  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.consume_rate_limit(
  TEXT,
  TEXT,
  INTEGER,
  INTEGER,
  TIMESTAMPTZ
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.consume_rate_limit(
  TEXT,
  TEXT,
  INTEGER,
  INTEGER,
  TIMESTAMPTZ
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.consume_rate_limit(
  TEXT,
  TEXT,
  INTEGER,
  INTEGER,
  TIMESTAMPTZ
) TO service_role;
