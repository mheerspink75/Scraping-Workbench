import type {
  ActionRequest,
  ActionResult,
  DomQuery,
  DomSnapshot,
  EvalRequest,
  QueryRequest,
  QueryResponse,
} from '../../src/contracts.js';
import type { BrowserBackend, BrowserSessionHandle } from '../../src/browser-backend.js';
import { AppError } from '../../src/errors.js';

export class FakeBrowserBackend implements BrowserBackend {
  readonly calls: Array<{ method: string; value: unknown }> = [];
  private readonly sessions = new Map<string, BrowserSessionHandle>();
  private nextTab = 1;

  async launch(): Promise<void> {
    this.calls.push({ method: 'launch', value: undefined });
  }

  async createSession(sessionId: string): Promise<BrowserSessionHandle> {
    const handle = { sessionId, tabId: this.nextTab++ };
    this.sessions.set(sessionId, handle);
    this.calls.push({ method: 'createSession', value: handle });
    return handle;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.calls.push({ method: 'closeSession', value: sessionId });
  }

  async getCurrentTab(sessionId: string): Promise<BrowserSessionHandle> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'missing fake session');
    return session;
  }

  async assertTab(sessionId: string, tabId: number): Promise<void> {
    const session = await this.getCurrentTab(sessionId);
    if (session.tabId !== tabId) throw new AppError(403, 'TAB_NOT_ACCESSIBLE', 'tab mismatch');
  }

  async performAction(sessionId: string, request: ActionRequest): Promise<ActionResult> {
    this.calls.push({ method: 'performAction', value: { sessionId, request } });
    return { action: request.action, selector: request.selector ?? null, text: request.text ?? null };
  }

  async domSnapshot(sessionId: string, query: DomQuery): Promise<DomSnapshot> {
    this.calls.push({ method: 'domSnapshot', value: { sessionId, query } });
    return {
      tabId: query.tabId,
      url: 'https://example.test/',
      title: 'Example',
      visibleElementCount: 1,
      elements: [{ tag: 'h1', id: 'heading', text: 'Example', attributes: { class: 'title' }, visible: true }],
      truncated: false,
      capturedAt: new Date().toISOString(),
    };
  }

  async query(sessionId: string, request: QueryRequest): Promise<QueryResponse> {
    this.calls.push({ method: 'query', value: { sessionId, request } });
    return {
      tabId: request.tabId,
      selector: request.selector,
      count: 1,
      matches: [{ index: 0, tag: 'h1', text: 'Example', attributes: { id: 'heading' }, visible: true }],
      truncated: false,
    };
  }

  async evaluate(sessionId: string, request: EvalRequest): Promise<unknown> {
    this.calls.push({ method: 'evaluate', value: { sessionId, request } });
    return 42;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    this.calls.push({ method: 'close', value: undefined });
  }
}
