import type { ClensConfig } from './schema.js';

export const DEFAULT_CONFIG: ClensConfig = {
  version: '1.0',
  project: 'untitled',
  budget: {
    session: 0.50,
    daily: 2.00,
    weekly: 10.00,
    currency: 'USD',
  },
  alerts: {
    soft_threshold: 0.80,
    hard_stop: false,
    notify_on_reset: true,
  },
  model_roi: {
    enabled: true,
    preferred_model: 'sonnet',
    nudge_on_overkill: true,
    nudge_cooldown_min: 10,
  },
  reports: {
    auto_generate: true,
    output_dir: '.claudelens/reports',
    format: 'markdown',
    client_billing_mode: false,
    client_name: '',
    billing_rate_usd: 0,
  },
};
