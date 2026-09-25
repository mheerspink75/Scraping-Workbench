import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { BrowserApiConfig } from './config.js';
import { BrowserService } from './browser-service.js';
import {
  actionRequestSchema,
  domQuerySchema,
  evalRequestSchema,
  permissionDecisionSchema,
  permissionRequestSchema,
  queryRequestSchema,
  sessionEndSchema,
  sessionStartSchema,
  workflowRequestSchema,
} from './contracts.js';
import { AppError, asAppError, errorBody } from './errors.js';

const sessionIdSchema = z.string().uuid();

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<void>;

function asyncHandler(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}

function requestId(response: Response): string {
  const existing = response.getHeader('x-request-id');
  return typeof existing === 'string' ? existing : crypto.randomUUID();
}

function requireSession(request: Request): string {
  const value = request.header('x-browser-session');
  const parsed = sessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(401, 'SESSION_HEADER_REQUIRED', 'Provide the session id in the x-browser-session header.');
  }
  return parsed.data;
}

function parseBody<T>(schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: z.ZodError } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'The request body is invalid.', parsed.error.issues);
  }
  return parsed.data;
}

function requireApiSecret(request: Request, config: BrowserApiConfig): void {
  if (!config.apiSecret) return;
  const provided = request.header('x-browser-api-secret') || '';
  const expected = Buffer.from(config.apiSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new AppError(401, 'API_SECRET_REQUIRED', 'A valid API secret is required.');
  }
}

function requireApprovalSecret(request: Request, config: BrowserApiConfig): void {
  if (!config.approvalSecret) {
    throw new AppError(503, 'APPROVAL_DISABLED', 'Permission approval is disabled until BROWSER_APPROVAL_SECRET is configured.');
  }
  const provided = request.header('x-browser-approval-secret') || request.header('x-approval-secret') || '';
  const expected = Buffer.from(config.approvalSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new AppError(403, 'APPROVAL_FORBIDDEN', 'A valid approval secret is required.');
  }
}

export function createApp(service: BrowserService, config: BrowserApiConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use((request, response, next) => {
    const id = request.header('x-request-id') || crypto.randomUUID();
    response.setHeader('x-request-id', id);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    next();
  });

  app.get('/healthz', (_request, response) => {
    response.json({ ok: true, service: 'browser-api' });
  });

  app.use((request, _response, next) => {
    try {
      requireApiSecret(request, config);
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post('/browser/session/start', asyncHandler(async (request, response) => {
    const body = parseBody(sessionStartSchema, request.body ?? {});
    const state = await service.startSession(body.metadata);
    response.status(201).json(state);
  }));

  app.post('/browser/session/end', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const body = parseBody(sessionEndSchema, request.body ?? {});
    if (body.sessionId && body.sessionId !== sessionId) {
      throw new AppError(403, 'SESSION_MISMATCH', 'The body sessionId does not match the session header.');
    }
    await service.endSession(sessionId);
    response.json({ ended: true, sessionId });
  }));

  app.get('/browser/session', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    response.json({ session: service.sessionState(sessionId) });
  }));

  app.get('/browser/sessions', asyncHandler(async (request, response) => {
    requireApprovalSecret(request, config);
    response.json({ sessions: service.listSessions() });
  }));

  app.post('/browser/permission/request', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const body = parseBody(permissionRequestSchema, request.body ?? {});
    const pending = service.requestPermission(sessionId, body.action, body.tabId, {
      ...(body.selector !== undefined ? { selector: body.selector } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
    }, body.reason);
    response.status(202).json(pending);
  }));

  app.get('/browser/permissions', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    requireApprovalSecret(request, config);
    response.json({ pending: service.pendingPermissions(sessionId) });
  }));

  app.post('/browser/permission/approve', asyncHandler(async (request, response) => {
    requireApprovalSecret(request, config);
    const body = parseBody(permissionDecisionSchema, request.body ?? {});
    response.json(service.approvePermission(body.requestId, body.ttlMs));
  }));

  app.post('/browser/permission/deny', asyncHandler(async (request, response) => {
    requireApprovalSecret(request, config);
    const body = parseBody(permissionDecisionSchema, request.body ?? {});
    service.denyPermission(body.requestId);
    response.status(204).send();
  }));

  app.post('/browser/action', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const body = parseBody(actionRequestSchema, request.body);
    const result = await service.action(sessionId, body, request.header('x-permission-token'));
    response.json({ ok: true, action: body.action, result });
  }));

  app.get('/browser/dom', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const query = parseBody(domQuerySchema, {
      tabId: request.query.tabId,
      ...(request.query.sessionId ? { sessionId: request.query.sessionId } : {}),
    });
    response.json(await service.dom(sessionId, query));
  }));

  app.post('/browser/query', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const body = parseBody(queryRequestSchema, request.body);
    response.json(await service.query(sessionId, body));
  }));

  app.post('/browser/workflow', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const body = parseBody(workflowRequestSchema, request.body);
    const result = await service.workflow(sessionId, body);
    response.json(result);
  }));

  app.get('/browser/workflow/:workflowId', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const parsedWorkflowId = z.string().uuid().safeParse(request.params.workflowId);
    if (!parsedWorkflowId.success) throw new AppError(400, 'VALIDATION_ERROR', 'workflowId must be a UUID.');
    response.json(service.workflowState(sessionId, parsedWorkflowId.data));
  }));

  app.post('/browser/eval', asyncHandler(async (request, response) => {
    const sessionId = requireSession(request);
    const body = parseBody(evalRequestSchema, request.body);
    const value = await service.evaluate(sessionId, body, request.header('x-permission-token'));
    response.json({ ok: true, value });
  }));

  app.use((_request, _response, next) => {
    next(new AppError(404, 'NOT_FOUND', 'The requested endpoint does not exist.'));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const id = requestId(response);
    if (error instanceof SyntaxError && 'body' in error) {
      const parseError = new AppError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
      response.status(parseError.status).json(errorBody(parseError, id));
      return;
    }
    const appError = asAppError(error);
    response.status(appError.status).json(errorBody(appError, id));
  });

  return app;
}
