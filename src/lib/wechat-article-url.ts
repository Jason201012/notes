export interface WechatUrlParseSuccess {
  ok: true;
  url: string;
}

export interface WechatUrlParseFailure {
  ok: false;
  message: string;
}

export type WechatUrlParseResult = WechatUrlParseSuccess | WechatUrlParseFailure;

const ARTICLE_URL_PATTERN =
  /https:\/\/mp\.weixin\.qq\.com\/s(?:\/[A-Za-z0-9_-]+)?(?:\?[^<>\s"'，。；、]*)?/gi;

function fail(message: string): WechatUrlParseFailure {
  return { ok: false, message };
}

function decodeAmp(value: string): string {
  let current = value;
  let previous = "";

  while (current !== previous) {
    previous = current;
    current = current.replaceAll("&amp;", "&");
  }

  return current;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[)）.,。，；;、>》\]]+$/g, "");
}

function isIpHostname(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function canonicalizeWechatArticleUrl(input: string): string | null {
  let url: URL;

  try {
    url = new URL(decodeAmp(input.trim()));
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

  if (hostname !== "mp.weixin.qq.com" || isIpHostname(hostname)) {
    return null;
  }

  url.hostname = hostname;
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path.split("/").includes("..")) {
    return null;
  }

  const shortLink = /^\/s\/([A-Za-z0-9_-]+)$/.exec(path);

  if (shortLink) {
    url.pathname = `/s/${shortLink[1]}`;
    return url.toString();
  }

  if (path !== "/s") {
    return null;
  }

  const hasIdentity = ["__biz", "mid", "idx", "sn"].some((key) =>
    url.searchParams.has(key),
  );

  if (!hasIdentity) {
    return null;
  }

  url.pathname = "/s";
  return url.toString();
}

function explainRejected(input: string): string {
  if (/javascript\s*:/i.test(input)) {
    return "请输入微信公众号文章链接，不支持脚本地址。";
  }

  const token = input.match(/[a-z][a-z0-9+.-]*:[^\s]+/i)?.[0] ?? input;

  try {
    const url = new URL(token);

    if (url.username || url.password) {
      return "文章链接不能包含账号或密码。";
    }

    if (url.protocol !== "https:") {
      return "公众号文章链接必须使用 https。";
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");

    if (hostname === "localhost" || hostname.endsWith(".local") || isIpHostname(hostname)) {
      return "不支持 IP 或本机地址。";
    }

    if (hostname !== "mp.weixin.qq.com") {
      return "只接受 mp.weixin.qq.com 上的文章链接。";
    }

    return "这不是可识别的公众号文章地址，请使用 /s/ 文章链接。";
  } catch {
    return "请粘贴一条微信公众号文章链接（https://mp.weixin.qq.com/s/...）。";
  }
}

export function parseWechatArticleInput(input: string): WechatUrlParseResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return fail("请粘贴一条微信公众号文章链接。");
  }

  const decoded = decodeAmp(trimmed);
  const urls = [
    ...new Set(
      Array.from(decoded.matchAll(ARTICLE_URL_PATTERN))
        .map((match) => canonicalizeWechatArticleUrl(stripTrailingPunctuation(match[0])))
        .filter((url): url is string => Boolean(url)),
    ),
  ];

  if (urls.length > 1) {
    return fail("文本里有多条公众号文章链接，请只保留一条后再导入。");
  }

  if (urls.length === 1) {
    return { ok: true, url: urls[0] };
  }

  return fail(explainRejected(decoded));
}
