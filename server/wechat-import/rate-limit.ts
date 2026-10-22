import { WECHAT_IMPORT_LIMITS } from "./limits.js";

export type WechatImportRateKind = "anonymous" | "authenticated";

export class WechatImportRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly options: {
      windowMs?: number;
      anonymousLimit?: number;
      authenticatedLimit?: number;
      now?: () => number;
    } = {},
  ) {}

  consume(key: string, kind: WechatImportRateKind, now = this.options.now?.() ?? Date.now()): boolean {
    const limit =
      kind === "anonymous"
        ? (this.options.anonymousLimit ?? WECHAT_IMPORT_LIMITS.anonymousImportsPerHour)
        : (this.options.authenticatedLimit ?? WECHAT_IMPORT_LIMITS.authenticatedImportsPerHour);
    const windowMs = this.options.windowMs ?? WECHAT_IMPORT_LIMITS.rateWindowMs;
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }
        const error = new Error("semaphore timeout");
        error.name = "SemaphoreTimeout";
        reject(error);
      }, timeoutMs);

      const grant = () => {
        clearTimeout(timer);
        this.active += 1;
        resolve(() => this.release());
      };

      this.queue.push(grant);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    next?.();
  }
}
