/**
 * REST client for the deqi-server.
 *
 * The desktop app uses fetch() against the deqi-server's HTTP
 * endpoints. The base URL is configurable so dev (where the
 * server runs on a known port) and prod (where Tauri spawns
 * a sidecar) work the same way.
 */

import type {
  SessionSummary,
  SessionDetails,
  ModelInfo,
  ToolInfo,
  ServerConfig,
  SearchResponse,
  ScheduleItem,
  ScheduleCadence,
  FileNode,
  MobilePair,
} from './types';

export class DeqiApi {
  constructor(private baseUrl: string = 'http://127.0.0.1:7700') {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`GET ${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`POST ${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`PATCH ${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`PUT ${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  private async delete<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' });
    if (!res.ok) {
      throw new Error(`DELETE ${path}: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.get('/health');
  }

  listSessions(cwd?: string): Promise<{ sessions: SessionSummary[] }> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    return this.get(`/v1/sessions${q}`);
  }

  createSession(): Promise<{ session: SessionDetails }> {
    return this.post('/v1/sessions');
  }

  getSession(id: string): Promise<{ session: SessionDetails }> {
    return this.get(`/v1/sessions/${id}`);
  }

  getSessionMessages(id: string): Promise<{
    messages: Array<{ id: string; role: string; content: unknown; ts: string }>;
  }> {
    return this.get(`/v1/sessions/${id}/messages`);
  }

  listModels(): Promise<{ models: ModelInfo[] }> {
    return this.get('/v1/models');
  }

  listTools(): Promise<{ tools: ToolInfo[] }> {
    return this.get('/v1/tools');
  }

  // v5.1: in-app feedback channel. Server appends to
  // ~/.deqi/feedback.jsonl. Idempotent on clientId.
  submitFeedback(input: {
    clientId?: string;
    kind: 'bug' | 'feature' | 'comment' | 'question';
    message: string;
    rating?: number;
    surface: string;
    sessionId?: string;
    desktopId?: string;
    appVersion: string;
  }): Promise<{ ok: true; id: string; deduped?: boolean }> {
    return this.post('/v1/feedback', input);
  }

  getConfig(): Promise<ServerConfig> {
    return this.get('/v1/config');
  }

  // v2.2: behavior + default model
  patchConfig(patch: Partial<ServerConfig>): Promise<{ ok: true; config: ServerConfig }> {
    return this.patch('/v1/config', patch);
  }

  // v2.2: add or update a single provider (apiKey/baseUrl/path)
  putProvider(
    name: string,
    patch: { apiKey?: string; baseUrl?: string; path?: string },
  ): Promise<{ ok: true; config: ServerConfig }> {
    return this.put(`/v1/config/providers/${encodeURIComponent(name)}`, patch);
  }

  // ─── v2.1 ────────────────────────────────────────────────────────

  search(q: string, limit = 20): Promise<SearchResponse> {
    return this.get(`/v1/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }

  listSchedule(): Promise<{ items: ScheduleItem[] }> {
    return this.get('/v1/schedule');
  }

  createSchedule(input: {
    name: string;
    prompt: string;
    cadence: ScheduleCadence;
    enabled?: boolean;
  }): Promise<{ item: ScheduleItem }> {
    return this.post('/v1/schedule', input);
  }

  updateSchedule(
    id: string,
    patch: Partial<ScheduleItem>,
  ): Promise<{ item: ScheduleItem }> {
    return this.patch(`/v1/schedule/${id}`, patch);
  }

  deleteSchedule(id: string): Promise<{ ok: true; id: string }> {
    return this.delete(`/v1/schedule/${id}`);
  }

  runScheduleNow(id: string): Promise<{ ok: true; item: ScheduleItem }> {
    return this.post(`/v1/schedule/${id}/run`);
  }

  listFiles(path = '.', root?: string): Promise<{ root: string; path: string; node: FileNode }> {
    const q = new URLSearchParams({ path });
    if (root) q.set('root', root);
    return this.get(`/v1/files?${q.toString()}`);
  }

  listPairs(): Promise<{ items: MobilePair[] }> {
    return this.get('/v1/pair');
  }

  createPair(deviceName: string): Promise<{ item: MobilePair; expiresInSec: number }> {
    return this.post('/v1/pair', { deviceName });
  }

  deletePair(id: string): Promise<{ ok: true; id: string }> {
    return this.delete(`/v1/pair/${id}`);
  }
}
