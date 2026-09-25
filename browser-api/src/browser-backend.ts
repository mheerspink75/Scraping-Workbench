import type {
  ActionName,
  ActionRequest,
  ActionResult,
  DomQuery,
  DomSnapshot,
  EvalRequest,
  QueryRequest,
  QueryResponse,
} from './contracts.js';

export interface BrowserSessionHandle {
  sessionId: string;
  tabId: number;
}

export interface BrowserBackend {
  launch(): Promise<void>;
  createSession(sessionId: string): Promise<BrowserSessionHandle>;
  closeSession(sessionId: string): Promise<void>;
  getCurrentTab(sessionId: string): Promise<BrowserSessionHandle>;
  assertTab(sessionId: string, tabId: number): Promise<void>;
  performAction(sessionId: string, request: ActionRequest): Promise<ActionResult>;
  domSnapshot(sessionId: string, query: DomQuery): Promise<DomSnapshot>;
  query(sessionId: string, request: QueryRequest): Promise<QueryResponse>;
  evaluate(sessionId: string, request: EvalRequest): Promise<unknown>;
  close(): Promise<void>;
}

export function isMutatingAction(action: ActionName): boolean {
  return action === 'click' || action === 'type' || action === 'navigate' || action === 'evaluate';
}
