import { z } from 'zod';

const BudgetSchema = z.object({
  session: z.number().positive(),
  daily: z.number().positive(),
  weekly: z.number().positive(),
  currency: z.string().default('USD'),
});

const AlertsSchema = z.object({
  soft_threshold: z.number().min(0).max(1).default(0.80),
  hard_stop: z.boolean().default(false),
  notify_on_reset: z.boolean().default(true),
});

const ModelRoiSchema = z.object({
  enabled: z.boolean().default(true),
  preferred_model: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  nudge_on_overkill: z.boolean().default(true),
  nudge_cooldown_min: z.number().min(1).default(10),
});

const ReportsSchema = z.object({
  auto_generate: z.boolean().default(true),
  output_dir: z.string().default('.claudelens/reports'),
  format: z.literal('markdown').default('markdown'),
  client_billing_mode: z.boolean().default(false),
  client_name: z.string().default(''),
  billing_rate_usd: z.number().min(0).default(0),
});

export const ClensConfigSchema = z.object({
  version: z.string().default('1.0'),
  project: z.string().default('untitled'),
  budget: BudgetSchema,
  alerts: AlertsSchema,
  model_roi: ModelRoiSchema,
  reports: ReportsSchema,
});

export type ClensConfig = z.infer<typeof ClensConfigSchema>;
