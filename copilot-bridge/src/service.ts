import crypto from 'node:crypto';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';
import {
  BRIDGE_ENDPOINTS,
  bridgeEnvelopeSchema,
  endpointRequiresApprovalSecret,
  endpointRequiresSession,
  isMutatingAction,
  payloadSchemas,
  type ActionName,
  type BridgeEndpoint,
} from './contracts.js';
import { BridgeError } from './errors.js';
import { BrowserApiForwarder, type ForwardContext, type ForwardResult } from './forwarder.js';

export interface IncomingBridgeHeaders {
  sessionId?: string;
  permissionToken?: string;
  approvalSecret?: string;
}

export interface ValidatedBridgeRequest {
  endpoint: BridgeEndpoint;
  payload: unknown;
}

const sessionIdSchema = z.string().uuid();

function safeEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
}

function payloadSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' ? value : undefined;
}

function payloadPermissionToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { permissionToken?: unknown }).permissionToken;
  return typeof value === 'string' ? value : undefined;
}

function assertNoPrototypeKeys(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoPrototypeKeys(item, seen));
    return;
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new BridgeError(400, 'UNSAFE_OBJECT_KEY', 'Prototype-related object keys are not allowed.');
    }
    assertNoPrototypeKeys((value as Record<string, unknown>)[key], seen);
  }
}

function requireToken(value: string | undefined, action: string): string {
  if (!value || value.length < 20 || value.length > 512) {
    throw new BridgeError(403, 'PERMISSION_REQUIRED', `An explicit one-time permission token is required for ${action}.`);
  }
  return value;
}

function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class BridgeService {
  private readonly usedPermissionTokens = new Set<string>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly forwarder: BrowserApiForwarder,
  ) {}

  validate(input: unknown): ValidatedBridgeRequest {
    const rawEndpoint = input && typeof input === 'object'
      ? (input as { endpoint?: unknown }).endpoint
      : undefined;
    if (typeof rawEndpoint !== 'string' || !(BRIDGE_ENDPOINTS as readonly string[]).includes(rawEndpoint)) {
      throw new BridgeError(400, 'INVALID_ENDPOINT', 'Unsupported endpoint');
    }
    const envelope = bridgeEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      throw new BridgeError(400, 'INVALID_BRIDGE_REQUEST', 'The bridge request envelope is invalid.', envelope.error.issues);
    }
    const endpoint = envelope.data.endpoint;
    const schema = payloadSchemas[endpoint] as z.ZodType<unknown>;
    const payload = schema.safeParse(envelope.data.payload);
    if (!payload.success) {
      throw new BridgeError(400, 'INVALID_PAYLOAD', `The payload does not match ${endpoint}.`, payload.error.issues);
    }
    assertNoPrototypeKeys(payload.data);
    return { endpoint, payload: payload.data };
  }

  async forward(input: unknown, headers: IncomingBridgeHeaders): Promise<ForwardResult> {
    const request = this.validate(input);
    const context = this.contextFor(request, headers);
    return this.forwarder.forward(request.endpoint, request.payload, context);
  }

  async health(): Promise<boolean> {
    return this.forwarder.health();
  }

  private claimToken(token: string): string {
    const digest = tokenDigest(token);
    if (this.usedPermissionTokens.has(digest)) {
      throw new BridgeError(403, 'PERMISSION_REPLAYED', 'Permission tokens may be used only once.');
    }
    this.usedPermissionTokens.add(digest);
    return token;
  }

  private contextFor(request: ValidatedBridgeRequest, headers: IncomingBridgeHeaders): ForwardContext {
    const { endpoint, payload } = request;
    const context: ForwardContext = {};

    if (endpointRequiresSession(endpoint)) {
      if (!headers.sessionId) {
        throw new BridgeError(400, 'SESSION_HEADER_REQUIRED', `The ${endpoint} endpoint requires x-browser-session.`);
      }
      const session = sessionIdSchema.safeParse(headers.sessionId);
      if (!session.success) {
        throw new BridgeError(400, 'INVALID_SESSION_HEADER', 'x-browser-session must be a UUID.');
      }
      const bodySession = payloadSessionId(payload);
      if (bodySession && bodySession !== session.data) {
        throw new BridgeError(403, 'SESSION_MISMATCH', 'The payload sessionId does not match x-browser-session.');
      }
      context.sessionId = session.data;
    } else if (headers.sessionId) {
      // A session header is not forwarded to session-start or approval routes.
      // It is intentionally ignored rather than allowing it to change scope.
    }

    if (endpoint === 'browser.action') {
      const actionPayload = payload as { action: ActionName };
      if (isMutatingAction(actionPayload.action)) {
        const bodyToken = payloadPermissionToken(payload);
        if (headers.permissionToken && bodyToken) {
          throw new BridgeError(400, 'TOKEN_CONFLICT', 'Choose either the permission-token header or payload token, not both.');
        }
        context.permissionToken = this.claimToken(requireToken(headers.permissionToken || bodyToken, actionPayload.action));
      } else if (headers.permissionToken || payloadPermissionToken(payload)) {
        throw new BridgeError(400, 'UNEXPECTED_PERMISSION_TOKEN', 'Read-only browser actions cannot carry a permission token.');
      }
    } else if (endpoint === 'browser.eval') {
      const bodyToken = payloadPermissionToken(payload);
      if (headers.permissionToken && bodyToken) {
        throw new BridgeError(400, 'TOKEN_CONFLICT', 'Choose either the permission-token header or payload token, not both.');
      }
      context.permissionToken = this.claimToken(requireToken(headers.permissionToken || bodyToken, 'eval'));
    } else if (endpoint === 'browser.workflow') {
      if (headers.permissionToken) {
        throw new BridgeError(400, 'WORKFLOW_TOKEN_REQUIRED', 'Workflow steps must each carry their own permission token.');
      }
      const workflow = payload as { steps: Array<{ action: ActionName; permissionToken?: string }> };
      workflow.steps.forEach((step) => {
        if (isMutatingAction(step.action)) {
          this.claimToken(requireToken(step.permissionToken, step.action));
        } else if (step.permissionToken) {
          throw new BridgeError(400, 'UNEXPECTED_PERMISSION_TOKEN', 'Read-only workflow steps cannot carry a permission token.');
        }
      });
    } else if (headers.permissionToken) {
      throw new BridgeError(400, 'UNEXPECTED_PERMISSION_TOKEN', 'This endpoint cannot carry x-permission-token.');
    }

    if (endpointRequiresApprovalSecret(endpoint)) {
      const decision = payload as { ttlMs?: unknown };
      if (decision.ttlMs !== undefined) {
        throw new BridgeError(400, 'APPROVAL_TTL_NOT_ALLOWED', 'Copilot may not choose a permission-token lifetime.');
      }
      if (!this.config.browserApprovalSecret) {
        throw new BridgeError(503, 'APPROVAL_DISABLED', 'Approval forwarding is disabled until BROWSER_APPROVAL_SECRET is configured.');
      }
      if (!headers.approvalSecret || !safeEqual(this.config.browserApprovalSecret, headers.approvalSecret)) {
        throw new BridgeError(403, 'APPROVAL_FORBIDDEN', 'An explicit matching x-browser-approval-secret is required.');
      }
      context.approvalSecret = headers.approvalSecret;
    } else if (headers.approvalSecret) {
      throw new BridgeError(400, 'UNEXPECTED_APPROVAL_SECRET', 'This endpoint cannot carry x-browser-approval-secret.');
    }

    return context;
  }
}
