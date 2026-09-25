import { randomUUID } from 'node:crypto';
import type { SessionState, WorkflowResult } from './contracts.js';
import type { BrowserBackend, BrowserSessionHandle } from './browser-backend.js';
import { AppError } from './errors.js';
import { PermissionManager } from './permissions.js';

export interface SessionRecord {
  id: string;
  handle: BrowserSessionHandle;
  metadata: Record<string, string>;
  createdAt: number;
  expiresAt: number;
  workflow?: WorkflowResult;
}

export interface SessionManagerOptions {
  ttlMs: number;
  now?: () => number;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly backend: BrowserBackend,
    private readonly permissions: PermissionManager,
    options: SessionManagerOptions,
  ) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => {
      void this.cleanup();
    }, Math.min(60_000, this.ttlMs));
    this.cleanupTimer.unref();
  }

  async start(metadata: Record<string, string> = {}): Promise<SessionState> {
    await this.cleanup();
    const id = randomUUID();
    const handle = await this.backend.createSession(id);
    const now = this.now();
    const record: SessionRecord = {
      id,
      handle,
      metadata: { ...metadata },
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(id, record);
    return this.toState(record);
  }

  async end(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new AppError(404, 'SESSION_NOT_FOUND', 'The browser session does not exist or has expired.');
    this.sessions.delete(sessionId);
    this.permissions.revokeSession(sessionId);
    await this.backend.closeSession(sessionId);
    if (record.workflow && record.workflow.status === 'running') {
      record.workflow.status = 'failed';
      record.workflow.finishedAt = new Date(this.now()).toISOString();
    }
  }

  get(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new AppError(404, 'SESSION_NOT_FOUND', 'The browser session does not exist or has expired.');
    if (record.expiresAt <= this.now()) {
      void this.end(sessionId);
      throw new AppError(410, 'SESSION_EXPIRED', 'The browser session has expired.');
    }
    return record;
  }

  async assertTab(sessionId: string, tabId: number): Promise<BrowserSessionHandle> {
    const record = this.get(sessionId);
    if (record.handle.tabId !== tabId) {
      throw new AppError(403, 'TAB_NOT_ACCESSIBLE', 'The requested tab is not the session\'s current tab.');
    }
    await this.backend.assertTab(sessionId, tabId);
    return record.handle;
  }

  async current(sessionId: string): Promise<BrowserSessionHandle> {
    return this.assertTab(sessionId, this.get(sessionId).handle.tabId);
  }

  setWorkflow(sessionId: string, workflow: WorkflowResult): void {
    const record = this.get(sessionId);
    if (record.workflow && record.workflow.status === 'running') {
      throw new AppError(409, 'WORKFLOW_IN_PROGRESS', 'Another workflow is already running for this session.');
    }
    record.workflow = workflow;
  }

  updateWorkflow(sessionId: string, workflow: WorkflowResult): void {
    this.get(sessionId).workflow = workflow;
  }

  getWorkflow(sessionId: string): WorkflowResult | undefined {
    return this.get(sessionId).workflow;
  }

  state(sessionId: string): SessionState {
    const record = this.get(sessionId);
    return this.toState(record);
  }

  list(): SessionState[] {
    void this.cleanup();
    return [...this.sessions.values()].map((record) => this.toState(record));
  }

  async cleanup(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()].filter((record) => record.expiresAt <= now);
    for (const record of expired) {
      try {
        await this.end(record.id);
      } catch {
        this.sessions.delete(record.id);
        this.permissions.revokeSession(record.id);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    const ids = [...this.sessions.keys()];
    for (const id of ids) {
      try {
        await this.end(id);
      } catch {
        // Continue closing the rest of the contexts.
      }
    }
  }

  private toState(record: SessionRecord): SessionState {
    const state: SessionState = {
      sessionId: record.id,
      tabId: record.handle.tabId,
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
      permissions: this.permissions.summaryForSession(record.id),
    };
    if (record.workflow) {
      state.activeWorkflow = {
        workflowId: record.workflow.workflowId,
        currentStep: record.workflow.currentStep,
        status: record.workflow.status,
      };
    }
    return state;
  }
}
