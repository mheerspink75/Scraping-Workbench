import { createHash, randomUUID } from 'node:crypto';
import type {
  ActionRequest,
  ActionResult,
  DomQuery,
  DomSnapshot,
  EvalRequest,
  PendingPermission,
  PermissionRequest,
  PermissionScope,
  PermissionTokenResponse,
  QueryRequest,
  QueryResponse,
  SessionState,
  WorkflowRequest,
  WorkflowResult,
  WorkflowStepResult,
} from './contracts.js';
import { isMutatingAction, type BrowserBackend } from './browser-backend.js';
import { AppError } from './errors.js';
import { PermissionManager } from './permissions.js';
import { SessionManager } from './session-manager.js';

export interface BrowserServiceOptions {
  maxWorkflowSteps: number;
  now?: () => number;
}

type PermissionDetails = Pick<PermissionRequest, 'selector' | 'text' | 'url'>;

function safePermissionSummaryUrl(value: string | null | undefined): string {
  if (!value) return '[empty-url]';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[unsupported-url]';
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return url.href.slice(0, 2_000);
  } catch {
    return '[invalid-url]';
  }
}

function permissionRequestHash(action: PermissionScope['action'], details: PermissionDetails): string {
  const canonicalDetails = action === 'navigate'
    ? { selector: null, text: null, url: details.url ?? null }
    : action === 'type'
      ? { selector: details.selector ?? null, text: details.text ?? null, url: null }
      : action === 'evaluate'
        ? { selector: null, text: details.text ?? null, url: null }
        : { selector: details.selector ?? null, text: null, url: null };
  const canonical = JSON.stringify({ action, ...canonicalDetails });
  return createHash('sha256').update(canonical).digest('hex');
}

export class BrowserService {
  private readonly maxWorkflowSteps: number;
  private readonly now: () => number;

  constructor(
    private readonly backend: BrowserBackend,
    private readonly sessions: SessionManager,
    private readonly permissions: PermissionManager,
    options: BrowserServiceOptions,
  ) {
    this.maxWorkflowSteps = options.maxWorkflowSteps;
    this.now = options.now ?? Date.now;
  }

  async startSession(metadata?: Record<string, string>): Promise<SessionState> {
    return this.sessions.start(metadata);
  }

  async endSession(sessionId: string): Promise<void> {
    await this.sessions.end(sessionId);
  }

  sessionState(sessionId: string): SessionState {
    return this.sessions.state(sessionId);
  }

  listSessions(): SessionState[] {
    return this.sessions.list();
  }

  async dom(sessionId: string, query: DomQuery): Promise<DomSnapshot> {
    this.assertBodySession(query.sessionId, sessionId);
    await this.sessions.assertTab(sessionId, query.tabId);
    return this.backend.domSnapshot(sessionId, query);
  }

  async query(sessionId: string, request: QueryRequest): Promise<QueryResponse> {
    this.assertBodySession(request.sessionId, sessionId);
    await this.sessions.assertTab(sessionId, request.tabId);
    return this.backend.query(sessionId, request);
  }

  async action(sessionId: string, request: ActionRequest, headerToken?: string): Promise<ActionResult> {
    this.assertBodySession(request.sessionId, sessionId);
    const handle = await this.sessions.assertTab(sessionId, request.tabId);
    if (isMutatingAction(request.action)) {
      const scope: PermissionScope = {
        sessionId,
        tabId: handle.tabId,
        action: request.action,
        requestHash: permissionRequestHash(request.action, request),
      };
      this.permissions.consume(headerToken || request.permissionToken, scope);
    }
    return this.backend.performAction(sessionId, request);
  }

  async evaluate(sessionId: string, request: EvalRequest, headerToken?: string): Promise<unknown> {
    this.assertBodySession(request.sessionId, sessionId);
    const handle = await this.sessions.assertTab(sessionId, request.tabId);
    this.permissions.consume(headerToken || request.permissionToken, {
      sessionId,
      tabId: handle.tabId,
      action: 'evaluate',
      requestHash: permissionRequestHash('evaluate', { text: request.code }),
    });
    return this.backend.evaluate(sessionId, request);
  }

  requestPermission(
    sessionId: string,
    action: PermissionScope['action'],
    tabId?: number,
    details: PermissionDetails = {},
    reason?: string,
  ): PendingPermission {
    const current = this.sessions.get(sessionId);
    const resolvedTabId = tabId ?? current.handle.tabId;
    if (resolvedTabId !== current.handle.tabId) {
      throw new AppError(403, 'TAB_NOT_ACCESSIBLE', 'Permission can only be requested for the current tab.');
    }
    const summary: PendingPermission['summary'] = {
      ...(details.selector ? { selector: details.selector } : {}),
      ...(details.url ? { url: safePermissionSummaryUrl(details.url) } : {}),
      ...(details.text !== null && details.text !== undefined ? { textLength: details.text.length } : {}),
    };
    return this.permissions.request({
      sessionId,
      tabId: resolvedTabId,
      action,
      requestHash: permissionRequestHash(action, details),
    }, reason, summary);
  }

  approvePermission(requestId: string, ttlMs?: number): PermissionTokenResponse {
    return this.permissions.approve(requestId, ttlMs);
  }

  denyPermission(requestId: string): void {
    this.permissions.deny(requestId);
  }

  pendingPermissions(sessionId: string): PendingPermission[] {
    this.sessions.get(sessionId);
    return this.permissions.pendingForSession(sessionId);
  }

  async workflow(sessionId: string, request: WorkflowRequest): Promise<WorkflowResult> {
    this.sessions.get(sessionId);
    if (request.steps.length > this.maxWorkflowSteps) {
      throw new AppError(400, 'WORKFLOW_TOO_LONG', `A workflow may contain at most ${this.maxWorkflowSteps} steps.`);
    }
    const existing = request.workflowId ? this.sessions.getWorkflow(sessionId) : undefined;
    if (request.workflowId && (!existing || existing.workflowId !== request.workflowId)) {
      throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'The workflow does not exist for this session.');
    }
    if (existing?.status === 'running') {
      throw new AppError(409, 'WORKFLOW_IN_PROGRESS', 'Another workflow is already running for this session.');
    }
    if (existing && existing.status === 'completed') {
      throw new AppError(409, 'WORKFLOW_ALREADY_COMPLETED', 'A completed workflow cannot be restarted.');
    }

    const startIndex = existing?.currentStep ?? 0;
    const stopOnError = request.stopOnError ?? true;
    let hadFailure = false;
    let hadPermissionDenial = false;
    const workflow: WorkflowResult = existing ?? {
      workflowId: request.workflowId ?? randomUUID(),
      sessionId,
      status: 'running',
      currentStep: startIndex,
      steps: [],
      startedAt: new Date(this.now()).toISOString(),
    };
    workflow.status = 'running';
    workflow.currentStep = startIndex;
    this.sessions.setWorkflow(sessionId, workflow);

    for (let index = startIndex; index < request.steps.length; index += 1) {
      const step = request.steps[index];
      if (!step) continue;
      workflow.currentStep = index;
      this.sessions.updateWorkflow(sessionId, workflow);
      try {
        const result = await this.action(sessionId, step);
        const stepResult: WorkflowStepResult = { index, action: step.action, ok: true, result };
        workflow.steps.push(stepResult);
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError(500, 'WORKFLOW_STEP_FAILED', 'Workflow step failed.');
        const stepResult: WorkflowStepResult = {
          index,
          action: step.action,
          ok: false,
          error: { code: appError.code, message: appError.message },
        };
        workflow.steps.push(stepResult);
        hadFailure = true;
        if (appError.code.startsWith('PERMISSION_')) hadPermissionDenial = true;
        if (stopOnError) {
          workflow.status = appError.code.startsWith('PERMISSION_') ? 'denied' : 'failed';
          workflow.finishedAt = new Date(this.now()).toISOString();
          this.sessions.updateWorkflow(sessionId, workflow);
          return workflow;
        }
      }
      if (index === request.steps.length - 1) {
        workflow.currentStep = request.steps.length;
      }
      this.sessions.updateWorkflow(sessionId, workflow);
    }
    workflow.status = hadPermissionDenial ? 'denied' : hadFailure ? 'failed' : 'completed';
    workflow.currentStep = request.steps.length;
    workflow.finishedAt = new Date(this.now()).toISOString();
    this.sessions.updateWorkflow(sessionId, workflow);
    return workflow;
  }

  workflowState(sessionId: string, workflowId: string): WorkflowResult {
    const workflow = this.sessions.getWorkflow(sessionId);
    if (!workflow || workflow.workflowId !== workflowId) {
      throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'The workflow does not exist for this session.');
    }
    return workflow;
  }

  private assertBodySession(bodySessionId: string | undefined, headerSessionId: string): void {
    if (bodySessionId && bodySessionId !== headerSessionId) {
      throw new AppError(403, 'SESSION_MISMATCH', 'The body sessionId does not match the session header.');
    }
  }
}
