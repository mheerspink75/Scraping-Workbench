import { z } from 'zod';

export const BRIDGE_ENDPOINTS = [
  'browser.session.start',
  'browser.session.end',
  'browser.dom',
  'browser.query',
  'browser.action',
  'browser.eval',
  'browser.workflow',
  'browser.permission.request',
  'browser.permission.approve',
  'browser.permission.deny',
] as const;

export type BridgeEndpoint = (typeof BRIDGE_ENDPOINTS)[number];

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

export const MUTATING_ACTION_NAMES = ['click', 'type', 'navigate', 'evaluate'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

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

export const domPayloadSchema = z.object({
  tabId,
  sessionId: z.string().uuid().optional(),
}).strict();

export const queryPayloadSchema = z.object({
  selector: z.string().trim().min(1).max(1_000),
  tabId,
  sessionId: z.string().uuid().optional(),
}).strict();

export const evalPayloadSchema = z.object({
  code: z.string().min(1).max(50_000),
  tabId,
  permissionToken: z.string().min(20).max(512).optional(),
  sessionId: z.string().uuid().optional(),
}).strict();

export const sessionStartPayloadSchema = z.object({
  metadata: z.record(z.string().max(200)).optional(),
}).strict();

export const sessionEndPayloadSchema = z.object({
  sessionId: z.string().uuid().optional(),
}).strict();

export const permissionRequestPayloadSchema = z.object({
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

export const permissionDecisionPayloadSchema = z.object({
  requestId: z.string().uuid(),
  ttlMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict();

export const workflowPayloadSchema = z.object({
  workflowId: z.string().uuid().optional(),
  steps: z.array(actionRequestSchema).min(1).max(50),
  stopOnError: z.boolean().optional(),
}).strict();

export const payloadSchemas = {
  'browser.session.start': sessionStartPayloadSchema,
  'browser.session.end': sessionEndPayloadSchema,
  'browser.dom': domPayloadSchema,
  'browser.query': queryPayloadSchema,
  'browser.action': actionRequestSchema,
  'browser.eval': evalPayloadSchema,
  'browser.workflow': workflowPayloadSchema,
  'browser.permission.request': permissionRequestPayloadSchema,
  'browser.permission.approve': permissionDecisionPayloadSchema,
  'browser.permission.deny': permissionDecisionPayloadSchema,
} as const;

export const bridgeEnvelopeSchema = z.object({
  endpoint: z.enum(BRIDGE_ENDPOINTS),
  payload: z.unknown(),
}).strict();

export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;
export type SessionEndPayload = z.infer<typeof sessionEndPayloadSchema>;
export type DomPayload = z.infer<typeof domPayloadSchema>;
export type QueryPayload = z.infer<typeof queryPayloadSchema>;
export type ActionPayload = z.infer<typeof actionRequestSchema>;
export type EvalPayload = z.infer<typeof evalPayloadSchema>;
export type WorkflowPayload = z.infer<typeof workflowPayloadSchema>;
export type PermissionRequestPayload = z.infer<typeof permissionRequestPayloadSchema>;
export type PermissionDecisionPayload = z.infer<typeof permissionDecisionPayloadSchema>;

export type BridgePayload =
  | SessionStartPayload
  | SessionEndPayload
  | DomPayload
  | QueryPayload
  | ActionPayload
  | EvalPayload
  | WorkflowPayload
  | PermissionRequestPayload
  | PermissionDecisionPayload;

export interface BridgeRequest {
  endpoint: BridgeEndpoint;
  payload: unknown;
}

export function isMutatingAction(action: ActionName): boolean {
  return action === 'click' || action === 'type' || action === 'navigate' || action === 'evaluate';
}

export function endpointRequiresSession(endpoint: BridgeEndpoint): boolean {
  return endpoint !== 'browser.session.start'
    && endpoint !== 'browser.permission.approve'
    && endpoint !== 'browser.permission.deny';
}

export function endpointRequiresApprovalSecret(endpoint: BridgeEndpoint): boolean {
  return endpoint === 'browser.permission.approve' || endpoint === 'browser.permission.deny';
}
