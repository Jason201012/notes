import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { canonicalizeWechatArticleUrl } from "./url.js";
import { WECHAT_IMAGE_HOSTS } from "./limits.js";
import { WechatImportError } from "./types.js";

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("100.64.0.0", 10, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.0.0.0", 24, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedAddresses.addAddress("255.255.255.255", "ipv4");
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("ff00::", 8, "ipv6");

export type HostLookup = (hostname: string) => Promise<string[]>;

export async function lookupHostAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) {
    return [hostname];
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function isBlockedIpAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  const ip = mapped?.[1] ?? normalized;
  const family = isIP(ip);

  if (family === 0) {
    return true;
  }

  // 198.18.0.0/15 是本地代理常用的 fake-ip 段。Clash、Surge 会把公网域名解析到这里，
  // 再按主机名转发。把它当成内网会让文章链接和图片在开着代理的电脑上全部失败。
  if (family === 4 && isProxyFakeIpAddress(ip)) {
    return false;
  }

  return blockedAddresses.check(ip, family === 4 ? "ipv4" : "ipv6");
}

function isProxyFakeIpAddress(address: string): boolean {
  const [first, second] = address.split(".");
  return first === "198" && (second === "18" || second === "19");
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function isAllowedWechatImageHost(hostname: string): boolean {
  return WECHAT_IMAGE_HOSTS.has(normalizedHost(hostname));
}

export function decideWechatResourceRequest(rawUrl: string): "allow" | "block" {
  if (rawUrl === "about:blank") {
    return "allow";
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return "block";
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    return "block";
  }

  const hostname = normalizedHost(url.hostname);

  if (!hostname || isIP(hostname)) {
    return "block";
  }

  if (hostname === "mp.weixin.qq.com" || isAllowedWechatImageHost(hostname)) {
    return "allow";
  }

  return "block";
}

export async function assertPublicHostname(
  hostname: string,
  lookupHost: HostLookup,
  cache: Map<string, string[]>,
): Promise<void> {
  const host = normalizedHost(hostname);

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new WechatImportError("UPSTREAM_ERROR");
  }

  let addresses = cache.get(host);

  if (!addresses) {
    try {
      addresses = await lookupHost(host);
    } catch {
      throw new WechatImportError("UPSTREAM_ERROR");
    }

    cache.set(host, addresses);
  }

  if (addresses.length === 0 || addresses.some((address) => isBlockedIpAddress(address))) {
    throw new WechatImportError("UPSTREAM_ERROR");
  }
}

export type WechatRedirectKind = "article" | "verification" | "reject";

export function classifyWechatRedirect(target: string): WechatRedirectKind {
  if (canonicalizeWechatArticleUrl(target)) {
    return "article";
  }

  let url: URL;

  try {
    url = new URL(target);
  } catch {
    return "reject";
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    return "reject";
  }

  const hostname = normalizedHost(url.hostname);

  if (
    hostname === "mp.weixin.qq.com" ||
    hostname === "weixin.qq.com" ||
    hostname.endsWith(".weixin.qq.com")
  ) {
    return "verification";
  }

  return "reject";
}
