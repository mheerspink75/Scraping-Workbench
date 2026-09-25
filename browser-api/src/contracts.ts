import { z } from 'zod';

export const ACTION_NAMES = [
  'click',
  'type',
  'navigate',
  'scroll',
  'extract',
  'evaluate',
  'waitFor',
  'screenshot',
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export const MUTATING_ACTION_NAMES = ['click', 'type', 'navigate', 'evaluate'] as const;
export const MUTATING_ACTIONS = new Set<ActionName>(MUTATING_ACTION_NAMES);

const nullableSelector = z.string().trim().min(1).max(1_000).nullable().optional();
const nullableText = z.string().max(20_000).nullable().optional();
const nullableUrl = z.string().trim().min(1).max(2_048).nullable().optional();
const tabId = z.number().int().nonnegative();

export const actionRequestSchema = z.object({
  action: z.enum(ACTION_NAMES),
  selector: nullableSelector,
  text: nullableText,
  url: nullableUrl,
  tabId,
  permissionToken: z.string().min(20).max(512).optional(),
  sessionId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (['click', 'type', 'extract'].includes(value.action) && !value.selector) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['selector'], message: 'selector is required for this action' });
  }
  if (value.action === 'navigate' && !value.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required for navigate' });
  }
  if (value.action === 'type' && (value.text === null || value.text === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text is required for type' });
  }
  if (value.action === 'evaluate' && (value.text === null || value.text === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text is required for evaluate' });
  }
  if (value.action === 'waitFor' && !value.selector && !value.text) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['selector'], message: 'selector or text is required for waitFor' });
  }
});

export const domQuerySchema = z.object({
  tabId: z.string().regex(/^\d+$/).transform((value) => Number(value)).pipe(z.number().int().nonnegative()),
  sessionId: z.string().uuid().optional(),
}).strict();

export const queryRequestSchema = z.object({
  selector: z.string().trim().min(1).max(1_000),
  tabId,
  sessionId: z.string().uuid().optional(),
}).strict();

export const evalRequestSchema = z.object({
  code: z.string().min(1).max(50_000),
  tabId,
  permissionToken: z.string().min(20).max(512).optional(),
  sessionId: z.string().uuid().optional(),
}).strict();

export const sessionStartSchema = z.object({
  metadata: z.record(z.string().max(200)).optional(),
}).strict();

export const sessionEndSchema = z.object({
  sessionId: z.string().uuid().optional(),
}).strict();

export const permissionRequestSchema = z.object({
  action: z.enum(MUTATING_ACTION_NAMES),
  tabId: tabId.optional(),
  selector: nullableSelector,
  text: z.string().max(50_000).nullable().optional(),
  url: nullableUrl,
  reason: z.string().trim().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (['click', 'type'].includes(value.action) && !value.selector) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['selector'], message: 'selector is required for this action' });
  }
  if (value.action === 'navigate' && !value.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required for navigate' });
  }
  if (value.action === 'type' && (value.text === null || value.text === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text is required for type' });
  }
  if (value.action === 'evaluate' && (value.text === null || value.text === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text is required for evaluate' });
  }
});

export const permissionDecisionSchema = z.object({
  requestId: z.string().uuid(),
  ttlMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict();

export const workflowRequestSchema = z.object({
  workflowId: z.string().uuid().optional(),
  steps: z.array(actionRequestSchema).min(1).max(50),
  stopOnError: z.boolean().optional(),
}).strict();

export const sessionStateQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
}).strict();

export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type DomQuery = z.infer<typeof domQuerySchema>;
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export type EvalRequest = z.infer<typeof evalRequestSchema>;
export type SessionStartRequest = z.infer<typeof sessionStartSchema>;
export type SessionEndRequest = z.infer<typeof sessionEndSchema>;
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export interface PermissionScope {
  sessionId: string;
  tabId: number;
  action: ActionName;
  requestHash: string;
}

export interface PermissionTokenResponse {
  token: string;
  requestId: string;
  scope: PermissionScope;
  issuedAt: string;
  expiresAt: string;
}

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  tabId: number;
  action: ActionName;
  requestHash: string;
  summary: {
    selector?: string;
    url?: string;
    textLength?: number;
  };
  reason?: string;
  createdAt: string;
  expiresAt: string;
}

export interface DomElement {
  tag: string;
  id?: string;
  role?: string;
  text: string;
  attributes: Record<string, string | boolean>;
  visible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface DomSnapshot {
  tabId: number;
  url: string;
  title: string;
  visibleElementCount: number;
  elements: DomElement[];
  truncated: boolean;
  capturedAt: string;
}

export interface QueryMatch {
  index: number;
  tag: string;
  text: string;
  attributes: Record<string, string | boolean>;
  visible: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface QueryResponse {
  tabId: number;
  selector: string;
  count: number;
  matches: QueryMatch[];
  truncated: boolean;
}

export type ActionResult = Record<string, unknown>;

export interface WorkflowStepResult {
  index: number;
  action: ActionName;
  ok: boolean;
  result?: ActionResult;
  error?: { code: string; message: string };
}

export interface WorkflowResult {
  workflowId: string;
  sessionId: string;
  status: 'running' | 'completed' | 'failed' | 'denied';
  currentStep: number;
  steps: WorkflowStepResult[];
  startedAt: string;
  finishedAt?: string;
}

export interface SessionState {
  sessionId: string;
  tabId: number;
  createdAt: string;
  expiresAt: string;
  permissions: { pending: number; active: number };
  activeWorkflow?: {
    workflowId: string;
    currentStep: number;
    status: WorkflowResult['status'];
  };
}
