import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const MAX_SITE_IMAGE_BYTES = 10 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(ip, prefix, "ipv6");

export function isPublicSiteImageAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPublicSiteImageAddress(mapped[1]);
  const family = isIP(normalized);
  if (!family) return false;
  if (family === 6 && (normalized.startsWith("::ffff:") || normalized.startsWith("64:ff9b:"))) return false;
  return !blocked.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export function validateRemoteSiteImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("图片地址不正确。"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) throw new Error("外站图片只支持公开的 HTTPS 地址。");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicSiteImageAddress(host)) throw new Error("图片不能引用内网地址。");
  return url;
}

export function isAllowedSiteImageDnsAddress(hostname: string, address: string): boolean {
  // Match the project's proxy support: Clash/Surge TUN maps public names into
  // 198.18.0.0/15. Permit these DNS answers only for names (never literal IP
  // URLs); the pinned connection still verifies TLS against the original name.
  const fakeIp = /^198\.(18|19)\.\d+\.\d+$/.test(address);
  return isPublicSiteImageAddress(address) || (!isIP(hostname) && fakeIp);
}

async function downloadImage(value: string, signal: AbortSignal, redirects = 0): Promise<Buffer> {
  const url = validateRemoteSiteImageUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((record) => !isAllowedSiteImageDnsAddress(hostname, record.address))) throw new Error("图片不能引用内网地址。");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => request.destroy(new Error("图片读取超时。")), 15_000);
    const request = httpsRequest(url, {
      signal,
      family: pinned.family,
      headers: { "User-Agent": "Notes-Hugo-Exporter/1.0", Accept: "image/*" },
      // Pin the exact validated DNS answer, retaining the URL hostname for TLS.
      lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const target = response.headers.location;
        response.resume();
        clearTimeout(timer);
        if (!target || redirects >= 3) { reject(new Error("图片重定向过多。")); return; }
        void downloadImage(new URL(target, url).href, signal, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200 || Number(response.headers["content-length"] ?? 0) > MAX_SITE_IMAGE_BYTES) {
        response.resume(); clearTimeout(timer); reject(new Error("图片无法下载或超过 10MB。")); return;
      }
      let length = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_SITE_IMAGE_BYTES) { request.destroy(new Error("单张图片不能超过 10MB。")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    });
    request.on("error", (error) => { clearTimeout(timer); reject(error); });
    request.end();
  });
}

async function readAllowedFile(directory: string, relativePath: string): Promise<Buffer> {
  const root = await fs.realpath(directory);
  const filename = await fs.realpath(path.resolve(root, relativePath));
  if (!filename.startsWith(`${root}${path.sep}`)) throw new Error("图片路径超出允许范围。");
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_SITE_IMAGE_BYTES) throw new Error("图片无法读取或超过 10MB。");
  return fs.readFile(filename);
}

export function createSiteImageReader(options: { imagesDirectory: string; publicDirectory: string; publicOrigin: string }) {
  return async (source: string, signal: AbortSignal): Promise<{ buffer: Buffer; extension: string }> => {
    signal.throwIfAborted();
    let buffer: Buffer;
    if (/^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=\r\n]+$/.test(source)) {
      if (source.length > MAX_SITE_IMAGE_BYTES * 1.4) throw new Error("单张图片不能超过 10MB。");
      buffer = Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
    } else {
      let relative = source;
      if (/^https?:\/\//i.test(source)) {
        const url = new URL(source);
        if (url.origin === new URL(options.publicOrigin).origin && url.pathname.startsWith("/images/")) relative = url.pathname;
      }
      if (relative.startsWith("/images/") && !relative.startsWith("//")) {
        const pathname = decodeURIComponent(relative.split(/[?#]/)[0]);
        const basename = pathname.slice("/images/".length);
        if (!basename || basename.includes("/") || basename.includes("\\") || basename === "." || basename === "..") throw new Error("图片路径不正确。");
        buffer = await readAllowedFile(options.imagesDirectory, basename);
      } else if (relative.startsWith("/") && !relative.startsWith("//") && !relative.includes("\\")) {
        buffer = await readAllowedFile(options.publicDirectory, decodeURIComponent(relative.split(/[?#]/)[0]).slice(1));
      } else {
        buffer = await downloadImage(source.startsWith("//") ? `https:${source}` : source, signal);
      }
    }
    if (!buffer.length || buffer.length > MAX_SITE_IMAGE_BYTES) throw new Error("图片为空或超过 10MB。");
    const metadata = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
    // Sharp reports AVIF as the HEIF container with AV1 compression.
    const format = metadata.format === "heif" && metadata.compression === "av1" ? "avif" : metadata.format;
    if (!format || !["png", "jpeg", "gif", "webp", "avif"].includes(format)) throw new Error("网站图片仅支持 PNG、JPEG、GIF、WebP 或 AVIF。");
    return { buffer, extension: format === "jpeg" ? "jpg" : format };
  };
}
