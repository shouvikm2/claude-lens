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
};
