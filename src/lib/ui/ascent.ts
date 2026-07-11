export const ASCENT = {
  canvas: 'bg-[var(--ascent-canvas)]',
  panel: 'bg-[var(--ascent-panel)] rounded-2xl shadow-[var(--ascent-panel-shadow)]',
  card: 'bg-[var(--ascent-card)] rounded-2xl shadow-[var(--ascent-card-shadow)]',
  field:
    'bg-[var(--ascent-field)] border-[var(--ascent-border)] text-[var(--ascent-title)] placeholder:text-[var(--ascent-subtle)] focus-visible:border-[#7B61FF] focus-visible:ring-[#7B61FF]/35',
  popover:
    'bg-[var(--ascent-panel)] border-[var(--ascent-border)] text-[var(--ascent-title)] shadow-[var(--ascent-popover-shadow)]',
  primary:
    'bg-[#7B61FF] text-white hover:bg-[#6E55F4] rounded-xl shadow-[0_8px_16px_rgba(123,97,255,0.28)]',
  primaryGradient:
    'ascent-brand-gradient-bg text-white rounded-xl shadow-[0_8px_16px_rgba(123,97,255,0.3)] hover:brightness-105',
  outline:
    'border border-[var(--ascent-outline-border)] bg-[var(--ascent-outline-bg)] text-[var(--ascent-outline-text)] hover:bg-[var(--ascent-hover)] hover:text-[var(--ascent-title)] rounded-xl',
  ghost: 'text-[var(--ascent-outline-text)] hover:text-[var(--ascent-title)] hover:bg-[var(--ascent-hover)] rounded-xl',
  title: 'text-[var(--ascent-title)]',
  subtle: 'text-[var(--ascent-subtle)]',
  body: 'text-[var(--ascent-body)]',
  tertiary: 'text-[var(--ascent-tertiary)]',
  divider: 'border-[var(--ascent-border)]',
  row: 'hover:bg-[var(--ascent-hover)]',
} as const;

export const ASCENT_INTERACTIVE =
  'transform-gpu border border-transparent transition-all duration-200 ease-out motion-reduce:transform-none motion-reduce:transition-none motion-safe:hover:scale-105 hover:border-[#7B61FF]';