import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { WECHAT_BROWSER_UA, WECHAT_IMPORT_LIMITS } from "./limits.js";
import {
  assertPublicHostname,
  decideWechatResourceRequest,
  isAllowedWechatImageHost,
  type HostLookup,
  lookupHostAddresses,
} from "./network.js";
import type { WechatImportImageStats, WechatImportWarning } from "./types.js";

export interface WechatImageBytes {
  buffer: Buffer;
  contentType: string | null;
}

export interface StoredWechatImage {
  path: string;
  reused: boolean;
}

export interface WechatImageLocalizeOptions {
  maxImages?: number;
  maxBudgetBytes?: number;
  concurrency?: number;
}

interface ContentImage {
  element: Element;
  url: string | null;
  alt: string;
}

function sniffHeader(buffer: Buffer, text: string): boolean {
  return buffer.subarray(0, text.length).toString("ascii") === text;
}

export function sniffWechatImageExtension(
  buffer: Buffer,
): "png" | "jpg" | "gif" | "webp" | "bmp" | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }

  if (buffer.length >= 6 && (sniffHeader(buffer, "GIF87a") || sniffHeader(buffer, "GIF89a"))) {
    return "gif";
  }

  if (
    buffer.length >= 12 &&
    sniffHeader(buffer, "RIFF") &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }

  if (buffer.length >= 2 && sniffHeader(buffer, "BM")) {
    return "bmp";
  }

  const sample = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase();

  if (sample.startsWith("<svg") || sample.startsWith("<?xml") || sample.includes("<script")) {
    return null;
  }

  return null;
}

export function resolveWechatImageUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";

  if (!trimmed || /^(?:javascript|data|blob|file):/i.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed);

    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }

    if (!isAllowedWechatImageHost(url.hostname)) {
      return null;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isTrackingPixel(element: Element, $: CheerioAPI): boolean {
  const width = Number($(element).attr("width") || "");
  const height = Number($(element).attr("height") || "");
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 1 && height <= 1;
}

function pushWarning(warnings: WechatImportWarning[], warning: WechatImportWarning): void {
  const exists = warnings.some(
    (item) => item.code === warning.code && item.message === warning.message && item.sourceUrl === warning.sourceUrl,
  );

  if (!exists) {
    warnings.push(warning);
  }
}

async function readLimitedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") || "0");

  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("image too large");
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error("image too large");
    }
    return buffer;
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
        throw new Error("image too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export function createWechatImageDownloader(options: {
  fetchImpl?: typeof fetch;
  lookupHost?: HostLookup;
  timeoutMs?: number;
  maxBytes?: number;
} = {}): (url: string) => Promise<WechatImageBytes> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? lookupHostAddresses;
  const timeoutMs = options.timeoutMs ?? WECHAT_IMPORT_LIMITS.imageTimeoutMs;
  const maxBytes = options.maxBytes ?? WECHAT_IMPORT_LIMITS.maxImageBytes;

  return async (imageUrl: string) => {
    const cache = new Map<string, string[]>();
    let current = resolveWechatImageUrl(imageUrl);

    if (!current) {
      throw new Error("image url rejected");
    }

    for (let hop = 0; hop <= WECHAT_IMPORT_LIMITS.maxRedirects; hop += 1) {
      const url = new URL(current);
      await assertPublicHostname(url.hostname, lookupHost, cache);
      const response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Referer: "https://mp.weixin.qq.com/",
          "User-Agent": WECHAT_BROWSER_UA,
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (hop === WECHAT_IMPORT_LIMITS.maxRedirects) {
          throw new Error("too many image redirects");
        }

        const location = response.headers.get("location");
        if (!location) {
          throw new Error("image redirect missing location");
        }
        const next = resolveWechatImageUrl(new URL(location, current).toString());
        if (!next) {
          throw new Error("image redirect rejected");
        }
        current = next;
        continue;
      }

      if (!response.ok) {
        throw new Error(`image status ${response.status}`);
      }

      return {
        buffer: await readLimitedBuffer(response, maxBytes),
        contentType: response.headers.get("content-type"),
      };
    }

    throw new Error("image download failed");
  };
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
}

export async function localizeWechatImages(
  html: string,
  runtime: {
    downloadImage: (url: string) => Promise<WechatImageBytes>;
    persistImage: (image: WechatImageBytes) => Promise<StoredWechatImage>;
  },
  options: WechatImageLocalizeOptions = {},
): Promise<{ html: string; images: WechatImportImageStats; warnings: WechatImportWarning[] }> {
  const $ = load(`<div id="wechat-import-root">${html}</div>`);
  const maxImages = options.maxImages ?? WECHAT_IMPORT_LIMITS.maxImages;
  const maxBudgetBytes = options.maxBudgetBytes ?? WECHAT_IMPORT_LIMITS.maxImageBudgetBytes;
  const warnings: WechatImportWarning[] = [];
  const stats: WechatImportImageStats = { total: 0, imported: 0, failed: 0, reused: 0 };
  const images: ContentImage[] = [];

  $("#wechat-import-root img").each((index, element) => {
    if (element.type !== "tag" || isTrackingPixel(element, $)) {
      return;
    }

    const raw = $(element).attr("data-src") || $(element).attr("src") || "";
    const alt = ($(element).attr("alt") || "").trim() || `图片 ${images.length + 1}`;
    images.push({
      element,
      url: resolveWechatImageUrl(raw),
      alt,
    });
    void index;
  });

  stats.total = images.length;
  const selected = images.slice(0, maxImages);
  const overflow = images.slice(maxImages);
  const results = new Map<string, { path: string; reused: boolean } | { failed: true }>();
  let bytesUsed = 0;
  let limitWarned = overflow.length > 0;

  if (overflow.length > 0) {
    pushWarning(warnings, {
      code: "IMAGE_LIMIT_REACHED",
      message: `文章图片超过 ${maxImages} 张，其余图片已改为占位。`,
    });
  }

  await runPool(
    [...new Set(selected.flatMap((image) => (image.url ? [image.url] : [])))],
    options.concurrency ?? WECHAT_IMPORT_LIMITS.imageConcurrency,
    async (url) => {
      if (bytesUsed >= maxBudgetBytes) {
        results.set(url, { failed: true });
        limitWarned = true;
        return;
      }

      try {
        const downloaded = await runtime.downloadImage(url);
        const extension = sniffWechatImageExtension(downloaded.buffer);

        if (!extension || downloaded.buffer.length === 0) {
          throw new Error("unsupported image");
        }

        if (bytesUsed + downloaded.buffer.length > maxBudgetBytes) {
          limitWarned = true;
          throw new Error("image budget exceeded");
        }

        const stored = await runtime.persistImage(downloaded);
        bytesUsed += downloaded.buffer.length;
        results.set(url, stored);
      } catch {
        results.set(url, { failed: true });
      }
    },
  );

  if (limitWarned && overflow.length === 0) {
    pushWarning(warnings, {
      code: "IMAGE_LIMIT_REACHED",
      message: "文章图片总体积超过上限，其余图片已改为占位。",
    });
  }

  const seenUrls = new Set<string>();

  for (const image of selected) {
    if (!image.url) {
      stats.failed += 1;
      replaceFailedImage($, image.element, image.alt, null);
      pushWarning(warnings, {
        code: "IMAGE_DOWNLOAD_FAILED",
        message: `图片“${image.alt}”不是可保存的微信图片，已保留占位。`,
      });
      continue;
    }

    const result = results.get(image.url);

    if (!result || "failed" in result) {
      stats.failed += 1;
      replaceFailedImage($, image.element, image.alt, image.url);
      pushWarning(warnings, {
        code: "IMAGE_DOWNLOAD_FAILED",
        message: `图片“${image.alt}”下载失败，正文中保留了占位。`,
        sourceUrl: image.url,
      });
      continue;
    }

    if (seenUrls.has(image.url) || result.reused) {
      stats.reused += 1;
    } else {
      stats.imported += 1;
    }

    seenUrls.add(image.url);
    $(image.element).replaceWith(
      $("<img>").attr("src", result.path).attr("alt", image.alt),
    );
  }

  for (const image of overflow) {
    stats.failed += 1;
    replaceFailedImage($, image.element, image.alt, image.url);
  }

  return {
    html: $("#wechat-import-root").html() ?? "",
    images: stats,
    warnings,
  };
}

function replaceFailedImage(
  $: CheerioAPI,
  element: Element,
  alt: string,
  sourceUrl: string | null,
): void {
  const paragraph = $("<p></p>");

  if (sourceUrl && decideWechatResourceRequest(sourceUrl) === "allow") {
    paragraph.append(`图片下载失败：${alt} `);
    paragraph.append($("<a></a>").attr("href", sourceUrl).text("原图"));
  } else {
    paragraph.text(`图片下载失败：${alt}`);
  }

  $(element).replaceWith(paragraph);
}
