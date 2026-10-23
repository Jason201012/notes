import type { SitePublishAccountConfiguration, SitePublishDraft } from "./model.js";
import { loadSitePublishDraft, saveSitePublishDraft, sitePublishStorageKey, type SitePublishStorage } from "./draft-storage.js";
import type { NoteDocument } from "../../types/app.js";

export type AccountSyncStatus = "loading" | "saving" | "saved" | "error" | "conflict";
export interface AccountSyncState { status: AccountSyncStatus; error: string }
export interface AccountSiteTransport {
  read(signal: AbortSignal): Promise<SitePublishAccountConfiguration | null>;
  write(draft: SitePublishDraft, expectedUpdatedAt: number | null, signal: AbortSignal): Promise<SitePublishAccountConfiguration>;
}
export class SiteConfigurationConflict extends Error {}
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

export function createAccountSiteTransport(fetchImpl: typeof fetch = fetch): AccountSiteTransport {
  async function request(method: string, signal: AbortSignal, body?: unknown) {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const response = await fetchImpl("/api/site-publishing/config", {
      method, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), credentials: "same-origin", cache: "no-store",
      headers: serialized ? { "Content-Type": "application/json" } : undefined,
      body: serialized,
      // Let a small final edit finish when the user closes or reloads the page.
      keepalive: serialized !== undefined && new TextEncoder().encode(serialized).length < 60_000,
    });
    const data = await response.json().catch(() => null);
    if (response.status === 409) throw new SiteConfigurationConflict("另一台设备更新了发布设置。");
    if (!response.ok) throw new Error(data?.error || "账号发布设置同步失败，请重试。");
    if (data?.draft === null && data.updatedAt === null && method === "GET") return null;
    if (!data?.draft?.settings || !Array.isArray(data.draft.categories) || !Array.isArray(data.draft.selections) || !Number.isSafeInteger(data.updatedAt) || data.updatedAt <= 0) {
      throw new Error("账号发布设置响应不正确，请重试。");
    }
    return data as SitePublishAccountConfiguration;
  }
  return {
    read: (signal) => request("GET", signal),
    write: async (draft, expectedUpdatedAt, signal) => {
      const result = await request("PUT", signal, { draft, expectedUpdatedAt });
      if (!result) throw new Error("账号发布设置响应不正确。");
      return result;
    },
  };
}

interface SyncMetadata { baseUpdatedAt: number | null; pending: boolean }
interface SyncOptions {
  scope: string;
  storage: SitePublishStorage | null;
  notes: NoteDocument[];
  transport?: AccountSiteTransport;
  debounceMs?: number;
  onDraft: (draft: SitePublishDraft) => void;
  onState: (state: AccountSyncState) => void;
}

/** Serializes saves and uses compare-and-swap revisions to avoid replacing another device's work. */
export class SitePublishingAccountSync {
  readonly scope: string;
  private draft: SitePublishDraft;
  private baseUpdatedAt: number | null = null;
  private pending = false;
  private linked = false;
  private disposed = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operation: Promise<void> | null = null;
  private abort = new AbortController();
  private remote: SitePublishAccountConfiguration | null = null;
  private metadata: SyncMetadata | null = null;
  private state: AccountSyncState = { status: "loading", error: "" };
  private transport: AccountSiteTransport;
  private metadataKey: string;

  constructor(private options: SyncOptions) {
    this.scope = options.scope;
    this.draft = loadSitePublishDraft(options.storage, options.scope, options.notes);
    this.transport = options.transport ?? createAccountSiteTransport();
    this.metadataKey = `${sitePublishStorageKey(options.scope)}:account-sync`;
    try {
      const raw = JSON.parse(options.storage?.getItem(this.metadataKey) || "null");
      if (raw && typeof raw.pending === "boolean" && (raw.baseUpdatedAt === null || (Number.isSafeInteger(raw.baseUpdatedAt) && raw.baseUpdatedAt > 0))) {
        this.metadata = raw;
        this.baseUpdatedAt = raw.baseUpdatedAt;
        this.pending = raw.pending;
      }
    } catch { /* A broken cache never replaces the account's configuration. */ }
  }

  private report(status: AccountSyncStatus, error = "") {
    if (this.disposed) return;
    this.state = { status, error };
    this.options.onState(this.state);
  }

  private cache() {
    saveSitePublishDraft(this.options.storage, this.scope, this.draft);
    try {
      this.options.storage?.setItem(this.metadataKey, JSON.stringify({ baseUpdatedAt: this.baseUpdatedAt, pending: this.pending }));
    } catch { /* Cloud saves remain usable when browser storage is unavailable. */ }
  }

  private apply(configuration: SitePublishAccountConfiguration) {
    this.draft = configuration.draft;
    this.baseUpdatedAt = configuration.updatedAt;
    this.pending = false;
    this.linked = true;
    this.remote = null;
    this.cache();
    this.options.onDraft(this.draft);
    this.report("saved");
  }

  async start(): Promise<void> {
    if (this.disposed || this.operation) return this.operation ?? undefined;
    this.report("loading");
    this.started = true;
    const run = async () => {
      try {
        const remote = await this.transport.read(this.abort.signal);
        if (this.disposed) return;
        this.linked = true;
        if (remote && fingerprint(remote.draft) === fingerprint(this.draft)) {
          this.apply(remote);
          return;
        }
        if (remote && this.pending && this.metadata) {
          if (remote.updatedAt !== this.baseUpdatedAt) {
            this.remote = remote;
            this.report("conflict");
            return;
          }
          // An offline edit based on this exact revision can safely resume.
          this.report("saving");
        } else if (remote) {
          this.apply(remote);
          return;
        } else {
          // Migrate the existing browser draft only when the account has no configuration.
          this.baseUpdatedAt = null;
          this.pending = true;
          this.cache();
          this.report("saving");
        }
        await this.saveLoop();
      } catch (error) {
        if (!this.disposed) this.report("error", error instanceof Error ? error.message : "读取账号设置失败，请重试。");
      }
    };
    this.operation = run().finally(() => { this.operation = null; });
    return this.operation;
  }

  edit(draft: SitePublishDraft): void {
    if (this.disposed || fingerprint(draft) === fingerprint(this.draft)) return;
    this.draft = draft;
    this.pending = true;
    this.cache();
    if (!this.started || this.state.status === "loading" || this.state.status === "conflict") return;
    this.report("saving");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.options.debounceMs ?? 500);
  }

  private async saveLoop() {
    while (this.pending && !this.disposed && this.state.status !== "conflict") {
      const snapshot = this.draft;
      const snapshotJSON = fingerprint(snapshot);
      this.report("saving");
      try {
        const saved = await this.transport.write(snapshot, this.baseUpdatedAt, this.abort.signal);
        if (this.disposed) return;
        this.baseUpdatedAt = saved.updatedAt;
        this.pending = fingerprint(this.draft) !== snapshotJSON;
        this.cache();
        if (!this.pending) this.report("saved");
      } catch (error) {
        if (this.disposed) return;
        if (error instanceof SiteConfigurationConflict) {
          try {
            this.remote = await this.transport.read(this.abort.signal);
            if (!this.disposed) this.report("conflict");
          } catch {
            this.report("error", "无法读取账号的最新设置，请重试。");
          }
        } else this.report("error", error instanceof Error ? error.message : "账号同步失败，请重试。");
        return;
      }
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.disposed) return;
    if (this.operation) {
      await this.operation;
      return this.flush();
    }
    if (!this.linked || this.state.status === "conflict") return;
    if (!this.pending) return;
    this.operation = this.saveLoop().finally(() => { this.operation = null; });
    return this.operation;
  }

  async retry(): Promise<void> {
    if (this.operation) await this.operation;
    if (this.disposed) return;
    // Re-read first; a failed request may have committed before the connection broke.
    this.metadata = { baseUpdatedAt: this.baseUpdatedAt, pending: this.pending };
    await this.start();
  }

  useAccount(): void {
    if (this.remote && !this.disposed) this.apply(this.remote);
  }

  async keepCurrent(): Promise<void> {
    if (!this.remote || this.disposed) return;
    this.baseUpdatedAt = this.remote.updatedAt;
    this.remote = null;
    this.pending = true;
    this.cache();
    this.report("saving");
    await this.flush();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.abort.abort();
  }
}
