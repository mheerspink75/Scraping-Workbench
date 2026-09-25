import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { BridgeConfig } from './config.js';
import { BridgeError, normalizeError } from './errors.js';
import { BridgeService, type IncomingBridgeHeaders } from './service.js';

function asyncHandler(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}

function requestId(response: Response): string {
  const value = response.getHeader('x-request-id');
  return typeof value === 'string' ? value : crypto.randomUUID();
}

function requireBridgeApiSecret(request: Request, config: BridgeConfig): void {
  if (!config.bridgeApiSecret) return;
  const provided = request.header('x-bridge-api-secret') || '';
  const expected = Buffer.from(config.bridgeApiSecret);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new BridgeError(401, 'BRIDGE_API_SECRET_REQUIRED', 'A valid bridge API secret is required.');
  }
}

function incomingHeaders(request: Request): IncomingBridgeHeaders {
  const sessionId = request.header('x-browser-session');
  const permissionToken = request.header('x-permission-token');
  const approvalSecret = request.header('x-browser-approval-secret');
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(permissionToken ? { permissionToken } : {}),
    ...(approvalSecret ? { approvalSecret } : {}),
  };
}

export function createApp(service: BridgeService, config: BridgeConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const id = crypto.randomUUID();
    response.setHeader('x-request-id', id);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('x-frame-options', 'DENY');
    next();
  });

  app.get('/copilot/bridge/health', asyncHandler(async (_request, response) => {
    const browserApiReachable = await service.health();
    response.json({ status: 'ok', browserApiReachable });
  }));

  app.use((request, _response, next) => {
    try {
      if (request.path === '/copilot/bridge') requireBridgeApiSecret(request, config);
      next();
    } catch (error) {
      next(error);
    }
  });

  app.use(express.json({ limit: config.maxBodyBytes, strict: true }));

  app.post('/copilot/bridge', asyncHandler(async (request, response) => {
    const result = await service.forward(request.body, incomingHeaders(request));
    response.status(result.status);
    if (result.contentType) response.setHeader('content-type', result.contentType);
    response.send(result.body);
  }));

  app.use((_request, _response, next) => {
    next(new BridgeError(404, 'NOT_FOUND', 'The requested bridge endpoint does not exist.'));
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const id = requestId(response);
    if (error instanceof SyntaxError && 'body' in error) {
      const normalized = normalizeError(new BridgeError(400, 'INVALID_JSON', 'The bridge request body is not valid JSON.'), id);
      response.status(normalized.status).json(normalized.body);
      return;
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      const normalized = normalizeError(new BridgeError(413, 'PAYLOAD_TOO_LARGE', 'The bridge request body exceeds the configured limit.'), id);
      response.status(normalized.status).json(normalized.body);
      return;
    }
    const normalized = normalizeError(error, id);
    response.status(normalized.status).json(normalized.body);
  });

  return app;
}
