import { WECHAT_BROWSER_UA, WECHAT_IMPORT_LIMITS } from "./limits.js";
import {
  assertPublicHostname,
  classifyWechatRedirect,
  decideWechatResourceRequest,
  type HostLookup,
  lookupHostAddresses,
} from "./network.js";
import { AsyncSemaphore } from "./rate-limit.js";
import { interpretWechatHtml } from "./extract.js";
import { canonicalizeWechatArticleUrl } from "./url.js";
import { isTerminalWechatImportError, WechatImportError } from "./types.js";

export interface FetchedWechatPage {
  html: string;
  method: "http" | "playwright";
}

export interface WechatBrowserRoute {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

export interface WechatBrowserPage {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface WechatBrowserContext {
  route(
    pattern: string,
    handler: (route: WechatBrowserRoute) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<WechatBrowserPage>;
  close(): Promise<void>;
}

export interface WechatBrowser {
  newContext(options?: object): Promise<WechatBrowserContext>;
}

const browserSlots = new AsyncSemaphore(WECHAT_IMPORT_LIMITS.playwrightConcurrency);

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "SemaphoreTimeout");
}

async function closeQuietly(resource: { close(): Promise<void> } | null): Promise<void> {
  if (!resource) {
    return;
  }

  try {
    await resource.close();
  } catch {
    // 抓取失败时也必须释放页面和上下文。
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WechatImportError("CONTENT_TOO_LARGE");
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new WechatImportError("CONTENT_TOO_LARGE");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WechatImportError("CONTENT_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

function isHtmlResponse(response: Response, html: string): boolean {
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();

  if (!mime) {
    return /<html|<!doctype html|<div/i.test(html);
  }

  if (["text/html", "application/xhtml+xml", "application/xml", "text/plain"].includes(mime)) {
    return true;
  }

  return false;
}

async function fetchHttpHtml(
  articleUrl: string,
  fetchImpl: typeof fetch,
  lookupHost: HostLookup,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const cache = new Map<string, string[]>();
  let current = articleUrl;
  const seen = new Set<string>();

  for (let hop = 0; hop <= WECHAT_IMPORT_LIMITS.maxRedirects; hop += 1) {
    if (seen.has(current)) {
      throw new WechatImportError("UPSTREAM_ERROR");
    }

    seen.add(current);
    await assertPublicHostname(new URL(current).hostname, lookupHost, cache);
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "User-Agent": WECHAT_BROWSER_UA,
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === WECHAT_IMPORT_LIMITS.maxRedirects) {
        throw new WechatImportError("UPSTREAM_ERROR");
      }

      const location = response.headers.get("location");
      if (!location) {
        throw new WechatImportError("UPSTREAM_ERROR");
      }
      const next = new URL(location, current).toString();
      const kind = classifyWechatRedirect(next);

      if (kind === "verification") {
        throw new WechatImportError("WECHAT_VERIFICATION_REQUIRED");
      }

      if (kind === "reject") {
        throw new WechatImportError(
          "ARTICLE_UNAVAILABLE",
          "文章链接跳转到了不受支持的地址，已停止读取。",
        );
      }

      current = canonicalizeWechatArticleUrl(next) ?? next;
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      throw new WechatImportError("ARTICLE_UNAVAILABLE");
    }

    if (response.status === 429) {
      throw new WechatImportError("WECHAT_VERIFICATION_REQUIRED");
    }

    if (response.status !== 200) {
      throw new WechatImportError("UPSTREAM_ERROR");
    }

    const html = await readLimitedText(response, maxBytes);

    if (!isHtmlResponse(response, html)) {
      throw new WechatImportError("UPSTREAM_ERROR");
    }

    return html;
  }

  throw new WechatImportError("UPSTREAM_ERROR");
}

async function fetchWithPlaywright(
  articleUrl: string,
  getBrowser: () => Promise<WechatBrowser>,
  acquireBrowser: () => Promise<() => void>,
  lookupHost: HostLookup,
  navigationTimeoutMs: number,
  selectorTimeoutMs: number,
): Promise<string> {
  const release = await acquireBrowser().catch((error: unknown) => {
    if (isTimeoutError(error)) {
      throw new WechatImportError("RATE_LIMITED", "当前导入请求过多，请稍后再试。");
    }

    throw error;
  });
  let context: WechatBrowserContext | null = null;
  let page: WechatBrowserPage | null = null;

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: WECHAT_BROWSER_UA,
      locale: "zh-CN",
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 900 },
    });
    const cache = new Map<string, string[]>();
    await context.route("**/*", async (route) => {
      const target = route.request().url();

      if (decideWechatResourceRequest(target) !== "allow") {
        await route.abort();
        return;
      }

      try {
        const url = new URL(target);
        if (url.protocol === "https:") {
          await assertPublicHostname(url.hostname, lookupHost, cache);
        }
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    page = await context.newPage();
    await page.goto(articleUrl, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    });

    try {
      await page.waitForSelector("#js_content", { timeout: selectorTimeoutMs });
    } catch {
      // 删除页和验证页没有正文节点，交给统一解析器判断。
    }

    return await page.content();
  } catch (error) {
    if (error instanceof WechatImportError) {
      throw error;
    }

    if (isTimeoutError(error)) {
      throw new WechatImportError("FETCH_TIMEOUT");
    }

    throw new WechatImportError("UPSTREAM_ERROR");
  } finally {
    await closeQuietly(page);
    await closeQuietly(context);
    release();
  }
}

export function createWechatPageFetcher(options: {
  fetchImpl?: typeof fetch;
  lookupHost?: HostLookup;
  getBrowser?: () => Promise<WechatBrowser>;
  acquireBrowser?: () => Promise<() => void>;
  httpTimeoutMs?: number;
  maxHtmlBytes?: number;
  navigationTimeoutMs?: number;
  selectorTimeoutMs?: number;
} = {}): (url: string) => Promise<FetchedWechatPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? lookupHostAddresses;
  const getBrowser = options.getBrowser;
  const acquireBrowser =
    options.acquireBrowser ??
    (() => browserSlots.acquire(WECHAT_IMPORT_LIMITS.playwrightAcquireTimeoutMs));

  return async (url: string) => {
    let fallbackReason: unknown;

    try {
      const html = await fetchHttpHtml(
        url,
        fetchImpl,
        lookupHost,
        options.httpTimeoutMs ?? WECHAT_IMPORT_LIMITS.httpTimeoutMs,
        options.maxHtmlBytes ?? WECHAT_IMPORT_LIMITS.htmlBytes,
      );
      const verdict = interpretWechatHtml(html, "http");

      if (verdict.kind === "terminal") {
        throw verdict.error;
      }

      if (verdict.kind === "article") {
        return { html, method: "http" };
      }

      fallbackReason = new WechatImportError("CONTENT_NOT_FOUND");
    } catch (error) {
      if (error instanceof WechatImportError && isTerminalWechatImportError(error)) {
        throw error;
      }

      fallbackReason = error;
    }

    if (!getBrowser) {
      if (fallbackReason instanceof WechatImportError) {
        throw fallbackReason;
      }

      if (isTimeoutError(fallbackReason)) {
        throw new WechatImportError("FETCH_TIMEOUT");
      }

      throw new WechatImportError("UPSTREAM_ERROR");
    }

    const html = await fetchWithPlaywright(
      url,
      getBrowser,
      acquireBrowser,
      lookupHost,
      options.navigationTimeoutMs ?? WECHAT_IMPORT_LIMITS.playwrightNavigationTimeoutMs,
      options.selectorTimeoutMs ?? WECHAT_IMPORT_LIMITS.playwrightSelectorTimeoutMs,
    );
    const verdict = interpretWechatHtml(html, "final");

    if (verdict.kind === "terminal") {
      throw verdict.error;
    }

    if (verdict.kind !== "article") {
      throw new WechatImportError("CONTENT_NOT_FOUND");
    }

    return { html, method: "playwright" };
  };
}
