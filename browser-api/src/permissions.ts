import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  ActionName,
  PendingPermission,
  PermissionScope,
  PermissionTokenResponse,
} from './contracts.js';
import { MUTATING_ACTIONS } from './contracts.js';
import { AppError } from './errors.js';

interface StoredToken {
  requestId: string;
  scope: PermissionScope;
  issuedAt: number;
  expiresAt: number;
}

export interface PermissionManagerOptions {
  requestTtlMs: number;
  tokenTtlMs: number;
  now?: () => number;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function iso(time: number): string {
  return new Date(time).toISOString();
}

export class PermissionManager {
  private readonly requests = new Map<string, PendingPermission>();
  private readonly tokens = new Map<string, StoredToken>();
  private readonly requestTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly now: () => number;

  constructor(options: PermissionManagerOptions) {
    this.requestTtlMs = options.requestTtlMs;
    this.tokenTtlMs = options.tokenTtlMs;
    this.now = options.now ?? Date.now;
  }

  request(scope: PermissionScope, reason?: string, summary: PendingPermission['summary'] = {}): PendingPermission {
    if (!MUTATING_ACTIONS.has(scope.action)) {
      throw new AppError(400, 'ACTION_NOT_MUTATING', 'Only mutating actions require approval.');
    }
    this.cleanup();
    const now = this.now();
    const pending: PendingPermission = {
      requestId: randomUUID(),
      sessionId: scope.sessionId,
      tabId: scope.tabId,
      action: scope.action,
      requestHash: scope.requestHash,
      summary,
      ...(reason ? { reason } : {}),
      createdAt: iso(now),
      expiresAt: iso(now + this.requestTtlMs),
    };
    this.requests.set(pending.requestId, pending);
    return pending;
  }

  approve(requestId: string, ttlMs = this.tokenTtlMs): PermissionTokenResponse {
    this.cleanup();
    const pending = this.requests.get(requestId);
    if (!pending) {
      throw new AppError(404, 'PERMISSION_REQUEST_NOT_FOUND', 'The permission request does not exist or has expired.');
    }
    this.requests.delete(requestId);
    const issuedAt = this.now();
    const expiresAt = issuedAt + Math.min(this.tokenTtlMs, Math.max(1_000, ttlMs));
    const rawToken = `browser-permission-${randomBytes(32).toString('base64url')}`;
    const scope: PermissionScope = {
      sessionId: pending.sessionId,
      tabId: pending.tabId,
      action: pending.action,
      requestHash: pending.requestHash,
    };
    this.tokens.set(tokenDigest(rawToken), {
      requestId,
      scope,
      issuedAt,
      expiresAt,
    });
    return {
      token: rawToken,
      requestId,
      scope,
      issuedAt: iso(issuedAt),
      expiresAt: iso(expiresAt),
    };
  }

  deny(requestId: string): void {
    this.cleanup();
    if (!this.requests.delete(requestId)) {
      throw new AppError(404, 'PERMISSION_REQUEST_NOT_FOUND', 'The permission request does not exist or has expired.');
    }
  }

  consume(token: string | undefined, expected: PermissionScope): void {
    this.cleanup();
    if (!token) {
      throw new AppError(403, 'PERMISSION_REQUIRED', `Explicit approval is required for ${expected.action}.`);
    }
    const digest = tokenDigest(token);
    const stored = this.tokens.get(digest);
    // Burn a presented token even when its scope is wrong. A token must never
    // be reusable after an attempted cross-scope use.
    this.tokens.delete(digest);
    if (!stored) {
      throw new AppError(403, 'PERMISSION_INVALID', 'The permission token is invalid or has expired.');
    }
    if (stored.expiresAt <= this.now()) {
      throw new AppError(403, 'PERMISSION_EXPIRED', 'The permission token has expired.');
    }
    if (
      stored.scope.sessionId !== expected.sessionId
      || stored.scope.tabId !== expected.tabId
      || stored.scope.action !== expected.action
      || stored.scope.requestHash !== expected.requestHash
    ) {
      throw new AppError(403, 'PERMISSION_SCOPE_MISMATCH', 'The permission token is not valid for this session, tab, and action.');
    }
  }

  revokeSession(sessionId: string): void {
    for (const [id, request] of this.requests) {
      if (request.sessionId === sessionId) this.requests.delete(id);
    }
    for (const [digest, token] of this.tokens) {
      if (token.scope.sessionId === sessionId) this.tokens.delete(digest);
    }
  }

  pendingForSession(sessionId: string): PendingPermission[] {
    this.cleanup();
    return [...this.requests.values()].filter((request) => request.sessionId === sessionId);
  }

  summaryForSession(sessionId: string): { pending: number; active: number } {
    this.cleanup();
    let pending = 0;
    let active = 0;
    for (const request of this.requests.values()) if (request.sessionId === sessionId) pending += 1;
    for (const token of this.tokens.values()) if (token.scope.sessionId === sessionId) active += 1;
    return { pending, active };
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (Date.parse(request.expiresAt) <= now) this.requests.delete(id);
    }
    for (const [digest, token] of this.tokens) {
      if (token.expiresAt <= now) this.tokens.delete(digest);
    }
  }
}
