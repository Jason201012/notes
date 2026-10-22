export const WECHAT_IMPORT_LIMITS = {
  htmlBytes: 5 * 1024 * 1024,
  httpTimeoutMs: 8_000,
  maxRedirects: 3,
  playwrightNavigationTimeoutMs: 12_000,
  playwrightSelectorTimeoutMs: 6_000,
  playwrightAcquireTimeoutMs: 15_000,
  playwrightConcurrency: 2,
  maxImages: 50,
  maxImageBytes: 20 * 1024 * 1024,
  maxImageBudgetBytes: 80 * 1024 * 1024,
  imageConcurrency: 4,
  imageTimeoutMs: 12_000,
  anonymousImportsPerHour: 5,
  authenticatedImportsPerHour: 30,
  rateWindowMs: 60 * 60 * 1000,
  minArticleChars: 8,
} as const;

export const WECHAT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const WECHAT_IMAGE_HOSTS = new Set([
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
  "mmecoa.qpic.cn",
  "res.wx.qq.com",
  "wx.qlogo.cn",
]);
