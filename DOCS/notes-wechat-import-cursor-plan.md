# zhaoolee/notes：微信公众号文章导入 Markdown 功能实施任务书

> **交付对象**：Cursor + Grok 4.7（在 `https://github.com/zhaoolee/notes` 仓库根目录执行）
> **任务性质**：直接实现功能、补齐测试、运行验证，而不只是再次输出设计方案
> **优先级**：P0/P1 一次完成；P2 保留为后续扩展
> **编写日期**：2026-10-17

---

## 0. 给 Cursor / Grok 4.7 的执行指令（先读）

> 2026-10-22 更新：用户已要求公众号导入始终仅限登录用户，本文后续提及的匿名导入
> 属于原始方案，实施时以此更新及 `DOCS/auth-and-sync.md` 为准。动态页面的脚本、
> 样式和隐藏模板文字不能用于判断访问错误；正文尚未渲染时应进入已有浏览器兜底。

你正在维护 `zhaoolee/notes`，一个使用 React + TypeScript + Vite + Zustand + Express 的锤子便签 Web 应用。**仓库已经集成 Playwright / Chromium、Markdown 编辑与预览、图片持久化、便签创建、匿名本地存储和登录用户的云端工作区同步。**

**你的目标是完成以下功能，而不是给出新的建议：**

1. 用户在 Web 页面点击“导入公众号文章”，粘贴一条微信公众号文章分享链接。
2. 后端获取公众号文章 HTML，抽取正文与基本元数据，转成可编辑 Markdown。
3. 下载文章图片，并复用仓库已有的 `/images/...` 资源存储和内容哈希去重能力。
4. 前端展示标题、来源、Markdown 预览、图片处理结果和警告；用户点击“创建便签”才生成新便签。
5. 新便签复用现有 `createNote()`、路由、分类和工作区保存流程。不得覆盖当前正在编辑的便签。
6. 处理网络失败、验证页、删除/受限文章、复杂内容降级、重复点击和错误提示。
7. 编写离线测试与必要的页面交互测试，运行类型检查、构建、相关测试，修复所有本次改动引入的问题。

**执行规则：**

- 先阅读仓库最新的 `AGENTS.md`、`package.json`、`server/index.ts`、`src/App.tsx`、`src/store/useAppStore.ts`、`src/lib/notes.ts`、`src/lib/images.ts`、`src/lib/workspace-save.ts`、`src/components/NoteSidebar.tsx`，以最新代码为准。本任务书引用的是调研时的 `main` 版本；如果代码有变化，以当前仓库结构适配。
- **必须复用已有 Playwright `getBrowser()` 和 Docker 浏览器运行时。禁止再启动一套 Playwright 服务、独立 Python 服务或增加 Camoufox 作为首版依赖。**
- 优先实现可预测、无 AI 参与的内容转换，不调用 DeepSeek/OpenAI 来改写原文。
- 不重构无关模块；不修改现有“发布到微信公众号草稿”的功能。**文章导入**和**公众号发布**必须是独立路径。
- 每完成一个阶段自测后继续下一阶段，不要停在 TODO 或伪代码；遇到无法在线复现的微信限制时，保留可靠的降级和测试覆盖，明确报告，而不是实现验证码绕过。
- 不要在代码、日志或测试里提交真实用户 Cookie、账号凭据或带敏感参数的请求样本。
- 完成后输出：修改文件清单、功能概述、验证命令和结果、已知限制、后续建议。若某项未完成，说明具体原因。

---

## 1. 用户体验与范围

### 1.1 目标交互

```text
打开 notes
   ↓
点击“导入公众号文章”
   ↓
弹出导入对话框，粘贴微信文章 URL
   ↓
点击“解析文章”
   ↓
后端抓取 HTML → 清理正文 → 下载图片 → 生成 Markdown
   ↓
显示文章标题 / 公众号名 / 发布时间 / 原文链接
   ↓
Markdown 预览 + 图片成功/失败数量 + 兼容性警告
   ↓
用户点击“创建便签”
   ↓
createNote(markdown, folderId, isStarred)
   ↓
打开新便签编辑页面，复用已有本地保存 / 云同步
```

### 1.2 MVP 必须实现（P0）

- 支持 `https://mp.weixin.qq.com/s/xxxx` 和 `https://mp.weixin.qq.com/s?...` 两类常见文章 URL（必须保留 `__biz`、`mid`、`idx`、`sn` 等识别文章所需的参数）。
- 前后端校验 URL；正文抓取采取 **HTTP 请求优先，已有 Playwright 浏览器兜底**。
- 提取标题、公众号名（如可获取）、发布时间（如可获取）、正文。
- 支持段落、换行、标题、加粗、斜体、超链接、图片、引用、列表、代码块等常见内容。
- 处理微信图片的 `data-src` 等懒加载属性；图片存入原有 `/images` 目录，Markdown 中使用稳定的 `/images/{hash}.{ext}` 路径。
- 显示导入预览，确认后**创建新的**便签；取消不创建便签。
- 出错时不创建空白笔记、不覆盖原有笔记；用户能重试。
- 对强制登录部署尊重现有 `REQUIRE_LOGIN` 机制；公开部署有基本限流与并发控制。
- 单元测试 + API 测试 + 前端核心交互验证，不依赖真实微信网络作为 CI 前提。

### 1.3 本轮尽量完成（P1）

- 表格转 GFM；特殊微信代码块去行号；重复图片只保存一次。
- 多种错误页检测：文章删除、审核中、验证/访问频率限制、非文章页、正文缺失。
- 媒体降级：视频、语音、音乐、小程序、投票、商品卡片等不要被静默吞掉；显示占位及可用的原始链接。
- 检测当前工作区是否已导入同一来源链接，给出提示但允许用户继续导入。
- 解析结果中保留警告清单；图片失败不阻断整篇文章导入。

### 1.4 本轮不做（P2）

- AI 自动摘要、润色、改写、自动分类、翻译。
- 绕过微信验证码、扫码登录、使用私人 Cookie、规避付费/删除/访问限制。
- 批量抓取、定时订阅公众号、历史文章全集爬取。
- 任意网页的通用导入器；仅服务微信公开文章。
- 复杂排版 1:1 视觉复刻：Markdown 的目标是语义和内容保真，不是复现全部 CSS 动效。

---

## 2. 已确认的现有代码（避免重复造轮子）

调研确认的关键入口：

| 功能 | 现有代码 | 实现要求 |
|---|---|---|
| Express 服务、路由 | `server/index.ts` | 在这里注册一个新的导入路由 |
| Playwright/Chromium | `server/index.ts` 中 `getBrowser()` | 复用已有浏览器单例；为每次抓取创建独立 `context/page`，结束时释放 |
| 图片持久化 | `server/index.ts` 中 `persistImage()`、`detectImageFormat()` | 复用字节内容哈希去重及存储逻辑，必要时小范围提取为共享模块 |
| 当前图片 URL 导入 | `POST /api/images/import` | 参考其返回结构；新功能推荐服务端直接复用持久化函数，避免服务端自调 HTTP |
| 笔记创建 | `src/store/useAppStore.ts` 的 `createNote(markdown, folderId, isStarred)` | 创建一篇新笔记，而非替换当前 Markdown |
| 分类解析 | `src/lib/notes.ts` 的 `getFolderIdFromCategory()` | 复用活动分类；回收站下要归入“全部” |
| 工作区保存 | `src/lib/workspace-save.ts` 和 `src/App.tsx` | 沿用现有流程，切勿在导入 API 中直接覆盖整个 workspace |
| 移动端/桌面端页面 | `src/App.tsx`、`src/components/NoteSidebar.tsx` | 增加轻量入口与对话框 |
| Markdown 渲染 | `react-markdown`、`remark-gfm` | 沿用当前预览能力 |
| 旧公众号功能 | `server/wechat-official.ts`、`src/components/WechatArticle.tsx`、`/api/wechat` | 这是**发布/复制到公众号**，不是公众号文章导入；不能混用 |
| 服务端构建 | `tsconfig.server.json` | 新增 `server/**/*.ts` 代码已经会被纳入 |
| 浏览器运行时 | `Dockerfile.app`、`Dockerfile.backend` | 已基于 Playwright 镜像，默认无需增加浏览器二进制 |

当前仓库为 ESM/NodeNext；服务端 TS 相对导入按项目习惯使用 `.js` 扩展名。若需要依赖，更新 `package.json` 和 lockfile，并确保生产镜像 `npm ci --omit=dev` 能安装运行时依赖。

---

## 3. 目标代码结构

建议新增：

```text
server/
  wechat-import/
    types.ts                 # 导入数据类型和错误码
    url.ts                   # 微信文章 URL 识别、归一化、安全校验
    fetch.ts                 # HTTP 抓取与 Playwright 兜底
    extract.ts               # 微信 HTML 元数据提取、正文 DOM 清洗
    convert.ts               # DOM → Markdown 和特殊节点处理
    images.ts                # 从 DOM 收集、下载、去重、替换微信图片
    service.ts               # 组合整个导入流程

src/
  components/
    WechatImportDialog.tsx   # URL 输入、进度状态、预览、确认创建
  lib/
    wechat-import.ts         # 前端 API 客户端及类型

backend/tests/
  wechat-import.test.ts      # 解析器、转换器、安全校验离线测试
  wechat-import-api.test.ts  # API 响应、限流/认证/错误处理测试
  fixtures/wechat-import/   # 经脱敏的静态 HTML fixtures

frontend/tests/
  wechat-import.test.ts      # 可测试的状态/交互规则（按现有测试风格）
```

可根据真实仓库结构合并少量文件，但不要把几百行微信公众号 DOM 解析逻辑全部堆进现有 5000+ 行的 `server/index.ts`。如果 `getBrowser()`、`persistImage()` 都在 `server/index.ts` 内，可以通过**依赖注入**将其传给新服务；或者只提取必要的共享模块，不为了该功能大改旧逻辑。

---

## 4. API 合约

### 4.1 路由

`POST /api/import/wechat/preview`

请求：

```json
{
  "url": "https://mp.weixin.qq.com/s/example-id"
}
```

成功响应 HTTP 200（示例）：

```json
{
  "title": "示例文章标题",
  "accountName": "示例公众号",
  "author": null,
  "publishedAt": "2026-10-17T08:00:00+08:00",
  "sourceUrl": "https://mp.weixin.qq.com/s/example-id",
  "markdown": "# 示例文章标题\n\n> 来源：[示例公众号](https://mp.weixin.qq.com/s/example-id)\n> 发布时间：2026-10-17\n\n---\n\n这里是正文。\n\n![示例图片](/images/hash.png)",
  "images": {
    "total": 1,
    "imported": 1,
    "failed": 0,
    "reused": 0
  },
  "warnings": [],
  "fetchMethod": "http"
}
```

**类型约束：**

```ts
type WechatImportWarningCode =
  | "IMAGE_DOWNLOAD_FAILED"
  | "UNSUPPORTED_EMBED"
  | "PUBLISH_TIME_UNKNOWN"
  | "CONTENT_SIMPLIFIED"
  | "IMAGE_LIMIT_REACHED";

interface WechatImportWarning {
  code: WechatImportWarningCode;
  message: string;
  sourceUrl?: string;
}

interface WechatPreviewResponse {
  title: string;
  accountName: string | null;
  author: string | null;
  publishedAt: string | null; // ISO 8601；无可靠值则为 null
  sourceUrl: string;
  markdown: string;
  images: {
    total: number;
    imported: number;
    failed: number;
    reused: number;
  };
  warnings: WechatImportWarning[];
  fetchMethod: "http" | "playwright";
}
```

失败响应统一格式：

```json
{
  "error": {
    "code": "ARTICLE_UNAVAILABLE",
    "message": "文章已删除或无法访问，请检查链接。"
  }
}
```

建议错误码 / 状态：

| 状态 | 代码 | 说明 |
|---|---|---|
| 400 | `INVALID_URL` | 非微信文章链接、非法 URL、缺少必需参数 |
| 401 | `AUTH_REQUIRED` | `REQUIRE_LOGIN=true` 时沿用现有认证行为；可统一前端解析 |
| 403 | `IMPORT_DISABLED` | 管理员关闭导入功能 |
| 413 | `CONTENT_TOO_LARGE` | 文章 HTML 或总资源超过安全上限 |
| 422 | `ARTICLE_UNAVAILABLE` | 已删除、审核中、不可公开访问 |
| 422 | `WECHAT_VERIFICATION_REQUIRED` | 微信验证页 / 人机校验，不自动绕过 |
| 422 | `CONTENT_NOT_FOUND` | 页面成功返回但没有有效文章正文 |
| 429 | `RATE_LIMITED` | 达到频率/并发限制 |
| 502 | `UPSTREAM_ERROR` | 微信上游请求失败或内容类型异常 |
| 504 | `FETCH_TIMEOUT` | 超时 |

不要直接向用户返回堆栈、浏览器内部路径或第三方完整错误详情。保留足够的服务端日志供排查。

### 4.2 保存边界（非常重要）

- `/api/import/wechat/preview` **仅负责抓取、转换和保存图片资源**；**不写 `NoteDocument`，不调用云端 workspace PUT**。
- 用户点击“创建便签”后，在前端调用当前 `createNote()`。这可以自然使用现有自动保存和多端同步。
- 预览阶段持久化了图片，用户随后取消可能产生未引用图片。MVP 允许少量这样的图片（内容哈希可复用），但必须在代码中注明；不要在取消时直接删除图片，因为图片可能被其他便签共用。后续再设计按引用计数/保留期清理机制。
- 如果预览解析失败，不应返回半成品“成功”；如果正文完整、只有部分图片失败，可以 `200 + warnings`，由用户决定是否创建。

---

## 5. 服务端抓取策略

### 5.1 URL 处理

1. 允许用户粘贴带首尾空白的分享链接；可以从含微信分享文字的文本中识别出**唯一一条**文章 URL，多条时提示明确选择，不能随意导入第一条。
2. HTML 实体 `&amp;` 恢复为 `&`，去掉 URL fragment（`#...`）。
3. 只允许 `https:`，主机名严格匹配 `mp.weixin.qq.com`，路径仅允许实际文章页 `/s` 或 `/s/...`；拒绝其他公众号页面、重定向站、IP URL、携带账号密码的 URL。
4. **保留文章身份参数**（如 `__biz`、`mid`、`idx`、`sn`）；不能为了去重把所有 query 参数剥掉。
5. 跳转也必须重新验证目标域名和协议；如果转到验证域名或未知域名，判定为不可访问/验证页，而不是盲目继续。
6. URL 检测/规范化必须有单元测试，尤其包含 `?`、`&amp;`、`#fragment`、`//evil.example`、`mp.weixin.qq.com.evil.example`、`http://localhost`、`javascript:`。

### 5.2 一级：HTTP HTML 获取（优先）

- 使用 Node `fetch` 和适当 User-Agent、`Accept-Language`；总超时推荐 8 秒（可以根据测试调整）。
- `redirect: 'manual'`，每次跳转单独做 URL 校验，最多 2～3 次。
- 限定 `text/html` 或兼容可识别的响应类型；按流读取并限制字节数（建议 HTML 最大 5 MiB），不能先无上限 `arrayBuffer()` 再判断。
- HTTP 200 **不代表成功**；必须在结果中检测有效正文节点及足够的正文文本。
- 检测微信“文章已删除”“内容审核中”“访问过于频繁”“环境异常”“验证码”等页面，返回明确错误分类。
- 不接受未知网站 URL，避免变成 SSRF/开放代理接口。

### 5.3 二级：复用已有 Playwright 兜底

当 HTTP 超时、HTML 不完整、正文因动态加载未出现，且不是明确的删除/验证页时：

- 调用已有 `getBrowser()`，每次创建独立非持久化 `browser.newContext()` / `context.newPage()`，**不要重复 `chromium.launch()`**。
- `page.goto(url, { waitUntil: 'domcontentloaded', timeout: ... })`；然后等待 `#js_content` 或确有必要的备用正文选择器，不要无限等待 `load` 或 `networkidle`。
- 严格限制页面导航和外部资源请求：只准许微信文章及经过审核的必要静态资源域名；阻止非 HTTPS、内网、回环、链路本地等目的地；不要执行任意用户提供的脚本。
- 使用新的无 Cookie 上下文，不附加个人微信登录态；禁止跨用户共享 session/cookie。
- 关闭 `page` 和 `context` 放进 `finally`；抓取失败也必须释放。
- 碰到验证码/安全验证时立即返回 `WECHAT_VERIFICATION_REQUIRED`，不要尝试自动通过。
- 浏览器输出经过同一个解析器处理，不能再搞第二份容易分叉的 Markdown 规则。

> 注意：Playwright 可以提高兼容性，但**不保证**能获取所有微信文章。公开文章的访问限制、删除、验证码都需要明确降级。

### 5.4 错误后备：用户手工内容导入

P1/P2 可增加“无法直接读取？粘贴复制的文章内容”入口；如果范围受限，可以先只在错误信息中提示用户复制正文到原有 Markdown 编辑器。**不必为此推迟 P0 交付。**

---

## 6. 微信正文提取与 Markdown 规则

### 6.1 提取字段

- `title`：优先 `#activity-name` / 微信主标题节点，备用 `og:title`；不能从网页 `<title>` 直接误取“验证页面”。
- `accountName`：优先 `#js_name`，备用真实的公众号元信息节点。
- `author`：有可信单独作者字段才填；不要将公众号名强行复制到作者字段。
- `publishedAt`：可从显示时间、可信脚本发布时间字段提取；正确处理时间戳秒/毫秒和时区。拿不到则 `null`，不要用导入当天冒充发布时间。
- 正文：优先 `#js_content`，必要时尝试确实符合微信文章结构的备用正文容器；避免抓到全文页脚、二维码、点赞/评论按钮和公众号介绍卡片。

### 6.2 DOM 清洗（先于 Turndown）

- 去除 `script`、`style`、导航、操作按钮、广告和 UI 控件；保留正文中的真实文字和链接。
- 处理微信常见 `section`、`span`、`p` 深层嵌套，恢复块级段落，避免将整篇压成一行。
- 将 `font-weight: bold/600/700/...` 恢复为 `<strong>`，`font-style: italic` 恢复为 `<em>`；不要把纯颜色、字号、居中效果误转成 Markdown 的标题语义。
- 对空段落、多个 `<br>`、不可见零宽字符、奇怪的连续空行做有限规范化，但**不能吞掉合法正文**。
- 代码块优先针对微信 `.code-snippet__fix` / `.code-snippet__line-index` 等结构定制规则：去行号、保留换行及缩进、能识别的语言名写入围栏代码块；防止 Turndown 把代码变成普通文本。
- 表格使用 `turndown-plugin-gfm`；有合并单元格时优先保留可读 HTML 表格或给出警告，不要悄悄扔掉数据。
- 图片节点优先用 `data-src`，再考虑 `src` 等有效属性；优先保留真实 `alt`，没有则可用“图片 N”。
- 超链接仅保留安全协议（http/https/mailto 视项目需求），清理 `javascript:` 等危险链接。
- 视频/语音/音乐/小程序/投票/商品等：创建 `[视频内容，暂无法直接转换]` 一类明确占位，并附能确认安全的原链接；附加 `UNSUPPORTED_EMBED` 警告。
- 复杂 SVG/HTML 特效与交互卡片：保留可见文本、图片和链接，必要时加 `CONTENT_SIMPLIFIED`，不追求视觉像素级复刻。

### 6.3 Markdown 转换

推荐新增生产依赖：

```bash
npm install cheerio turndown turndown-plugin-gfm
npm install -D @types/turndown @types/turndown-plugin-gfm
```

> 具体 `@types` 依赖以安装时包生态和 TypeScript 编译为准；如内置类型存在，不重复安装。`cheerio`、`turndown` 等用于运行时，不能错误放入 `devDependencies` 导致 Docker 生产容器缺包。

转换策略：

```text
HTML (http 或 playwright)
    ↓
识别微信错误页面
    ↓
提取标题、公众号、作者、发布时间
    ↓
定位 #js_content
    ↓
清理非正文、规范语义节点、标记特殊内容
    ↓
采集和本地化图片并改写 DOM 中的 src
    ↓
Turndown + GFM 自定义规则
    ↓
Markdown 后处理（空行、围栏、重复标题、资源路径）
    ↓
拼接来源说明和正文
```

**生成 Markdown 的示例：**

````markdown
# 公众号文章标题

> 来源：[某某公众号](https://mp.weixin.qq.com/s/example-id)
> 发布时间：2026-10-17 08:00

---

这里是文章正文，包含 **加粗**、链接和图片。

![图片描述](/images/content-hash.png)

```ts
console.log('保持代码缩进');
```
````

文档头部的原始 URL 既方便用户回溯，也可供前端实现非强制的重复来源提示。**若无发布时间，直接省略发布时间一行。**不要生成“null”“未知日期”等虚假信息。

### 6.4 校验转换质量

- 没有有效标题可用“公众号文章”作为兜底，但正文必须存在并超过最低可辨识阈值，避免把“请在微信客户端打开”误当正文。
- 计算原始正文可见文本与 Markdown（去掉来源元数据后）的文本完整度；对大幅丢字的结果报错或警告。此度量用于发现明显失败，不作为纯数学的完整正确保证。
- 同一篇文章中的重复标题不要插入两次。
- 输出 Markdown 绝对不能包含 `<script>`、事件处理器、危险协议或恶意注入内容。

---

## 7. 图片下载 / 本地化

### 7.1 复用现有存储

已存在：

- `server/index.ts` 的 `downloadImageFromUrl()`（可参考其响应处理）。
- `persistImage(request, {buffer, mimeType, filename})`：校验图片格式，以 SHA-256 内容哈希命名，返回 `path` 与 `url`。
- `/images` 静态目录与 Docker 持久化挂载。

新功能应把**经过安全校验、限制体积的图片字节**交给现有持久化逻辑，复用 `path` 写入 Markdown。不需要为新功能再建图片数据库，不要使用微信公众号图片 URL 作为最终稳定地址。

### 7.2 下载规则

- 仅允许明确审核过的微信图片 CDN 域名（如 `mmbiz.qpic.cn`、实际 fixture 验证的其他域名）；重定向逐跳校验，禁止私有 IP / 内网地址。禁止对正文中任意第三方 URL 无限制抓取。
- 下载时允许设置微信图片常见所需的 `Referer`，但不使用真实用户 Cookie。
- 限制：建议每张图片沿用当前 **20 MiB** 上限；文章最多 50 张图片、总图片预算 80 MiB、并发 3～4、单张 10～15 秒。具体数字应作为代码常量，并按现实测试微调。
- 流式限制下载大小，不要把未知大小的超大响应全读进内存后才拦截。
- 保留 PNG/JPEG/GIF/WebP 等现有支持格式；GIF 默认保留动画，**不要为了省事统一转 PNG**。
- 根据响应内容/魔数确定真实格式，而不是完全相信 URL 上的 `wx_fmt`；复用现有 `detectImageFormat()`。
- 同篇重复图片 URL 只下载一次；不同 URL 但字节完全相同由 `persistImage()` 的 SHA-256 去重。
- 若单图下载失败，Markdown 用明确的原图链接或可读占位保留位置，同时记录 `IMAGE_DOWNLOAD_FAILED`；绝不能静默丢图。
- 每张图片先完成 URL→资源映射，再执行最终 Markdown 转换，防止各种 HTML 路径遗漏图片替换。
- 对微信伪图片、追踪像素、空图和远程 SVG 特殊内容遵循白名单与安全校验。

### 7.3 关于多用户

继续使用仓库当前的内容寻址图片存储及权限模型；不要随意改变 `/images` 的共享语义。不要通过猜测其他用户图片名来删除公共文件。缓存和预览结果不能在不同用户间泄露隐私内容。

---

## 8. 前端交互与状态

### 8.1 入口

- 在便签操作入口增加“导入公众号文章”，**与“新建便签”相邻但不取代它**。
- 桌面端顶栏或便签侧栏可打开；手机端从可见菜单/工具栏进入，保证触控方便。
- 新建独立 `WechatImportDialog.tsx`，不要把几百行状态机塞进 `App.tsx`。
- 沿用现有项目的样式、色彩、弹窗、响应式设计，不引入全新 UI 框架。

### 8.2 对话框状态机

```text
idle       → 输入 URL
loading    → 解析中（禁用重复提交，显示阶段提示）
preview    → 结果预览（含警告和图片统计）
error      → 显示可理解错误，保留输入方便重试
creating   → 同步执行 createNote，成功后关闭并跳转
```

- 按 Enter 或点击“解析文章”触发；处理快速连续点击、关闭对话框后旧请求回包造成状态污染的问题，可使用 `AbortController` 或请求序号。
- 预览使用仓库已有的 Markdown 预览/渲染组件或等价复用；展示 Markdown 正文即可，不需要额外实现富文本编辑器。
- 如果图片部分失败，用户仍可确认导入，但页面应醒目显示“成功 X / 失败 Y”及有问题的图片说明。
- 提供“创建便签”和“取消”；当正文为空/不可用时“创建便签”不可点击。
- 用户确认后根据当前分类复用 `getFolderIdFromCategory()`；在回收站分类时改为“全部”；新便签保持 `isStarred` 等当前已有行为。
- 创建成功后关闭所有与当前页面冲突的菜单/弹窗、切到编辑视图、写入已有笔记路由（参考 `handleCreateNote()`），不要仅调用 `createNote` 而忘记手机端视图、当前 URL 与活动分类。
- **仅确认时创建**，取消/关闭不创建；重复点确认最多创建一篇。

### 8.3 登录 / 公开实例

当前 `REQUIRE_LOGIN=true` 已会拦截未经授权的 `/api/` 请求，必须沿用这个行为。

当 `REQUIRE_LOGIN=false` 时，系统允许匿名本地笔记操作。新远程抓取 API 若也开放给匿名用户，必须提供严格的安全保护：

- 严格域名白名单、请求上限、超时和图像体积限制。
- IP 维度的低频率限流（建议匿名 5 次/小时，登录用户 30 次/小时）；全局浏览器抓取并发上限建议 2。
- 可配置 `WECHAT_IMPORT_ENABLED=false` 作为紧急关闭开关；禁用时 UI 能正确解释。
- 服务器配置 `trust proxy` 时检查 `X-Forwarded-For` 的信任边界；不可盲信客户端自报 IP 作为限流依据。
- 对公网生产环境建议优先限制登录用户访问；如果代码选择默认允许匿名访问，应在 README 明示风险和推荐的反向代理级限流方法。

以上仅为建议默认阈值，可根据实现选择更合理值，但必须有可执行的防滥用机制，不能只依赖前端按钮禁用。

---

## 9. 测试计划（必须离线可重复）

### 9.1 HTML fixtures 覆盖矩阵

在 `backend/tests/fixtures/wechat-import/` 创建**合成/脱敏**的最小 HTML 样本：

| fixture | 应当检验 |
|---|---|
| `basic.html` | 标题、公众号名、发布时间、段落、链接、引号 |
| `nested-sections.html` | 多层 `section/span`、加粗/斜体、换行、空白文本 |
| `lazy-images.html` | `data-src`、重复图片、缺失 src、图片 alt |
| `code-block.html` | 特殊微信代码块、语言、行号去除、空格缩进 |
| `table.html` | 标准表格 → GFM，合并单元格降级 |
| `embedded-media.html` | 视频/语音/小程序等占位和 warnings |
| `deleted.html` | 已删除文章明确错误 |
| `verification.html` | 验证页不被误认为正文 |
| `missing-content.html` | 200 但无正文时报错 |
| `malicious.html` | 恶意链接、脚本、伪造 host、危险标签被清除 |

### 9.2 单元测试

- 微信 URL 规范化；必要查询参数保留；拒绝非微信、HTTP、用户名密码、IP、恶意同形主机。
- 文章标题/公众号名/时间字段提取，缺失字段为 `null`（需要 title 兜底的除外）。
- `#js_content` 抽取、不抓页脚、不丢正文。
- Markdown 标题、段落、粗斜体、列表、引用、表格、代码和链接语义。
- 图片：替换 `data-src`、同 URL 去重、不同 URL 同内容哈希去重、失败警告、保留 GIF。
- 错误页检测与响应错误码；正文为空、HTML 超限、图片超限。
- 安全：危险协议、脚本清理，URL 跳转校验；HTTP 和 Playwright 访问路线不能绕过白名单。

### 9.3 API / 服务测试

- 用**可注入的 fetch / browser / image transport** 和固定 fixtures 模拟网络，禁止让 CI 测试必须真实访问微信公众号。
- HTTP 成功只走一级；HTTP 不完整时走 Playwright 二级；二级仍遇验证页时返回明确失败；两级超时正常释放资源。
- 成功响应类型、图片统计和 warnings 一致；正文缺失不可返回 200。
- 认证：`REQUIRE_LOGIN=true` 时匿名 401；现有认证用户可用。
- 限流：连续请求返回 429；并发超过上限不会无限创建页面。
- `WECHAT_IMPORT_ENABLED=false` 时返回明确可处理状态。
- 测试导入 API 不改变当前 workspace；前端只有点击“创建便签”才增加 note。
- 与现有 `/api/wechat` 发布功能、`/api/images/import` 图片导入功能完全共存。

### 9.4 前端交互测试

- 输入无效 URL 显示错误，不发 API 请求。
- loading 时按钮不可重复触发；关闭对话框后过期响应不会打开/覆盖它。
- API 失败仍保留输入；错误原因能读懂；允许修正 URL 后重试。
- 含图片警告仍显示预览；点击取消不创建 note。
- 点击创建后恰好创建 1 篇；当前旧 note 不受影响。
- 桌面和手机都可以找到入口；新便签编辑视图及 URL/分类正确。
- 匿名工作区本地保存、登录后的云同步都保持原有逻辑。

### 9.5 手动真链路验收

至少用 8～12 条**可公开访问、允许测试**的真实微信文章链接验证：普通图文、长文、多图、代码/技术文章、特殊排版、GIF、表格、包含媒体占位的文章，以及验证/删除页样本（可模拟）。记录每条的结果与 warnings，**不要硬编码任何“微信文章 100% 成功”的结论**。

建议记录并报告三个分离指标：

1. 公开且在普通浏览器里可访问的文章的抓取成功率。
2. 抓取成功文章的正文/语义恢复情况。
3. 已发现微信图片的成功本地化比例。

如果没有方便的真实链接或 CI 环境不能联网，也要完成 fixture 测试，并在最终报告中诚实注明“真实微信站点验证未运行”。

---

## 10. 推荐实施顺序（按阶段连续推进）

### 阶段 A：仓库核对与依赖（P0）

- [ ] 阅读 `AGENTS.md`、项目现有代码、测试方式；确认 Playwright、图片存储、便签创建和认证接口的真实定义。
- [ ] 安装转换依赖，更新锁文件；确认 `npm run typecheck` 能通过。
- [ ] 添加 types、URL 检查及单元测试。

**阶段门槛：** TS 编译无新增错误，URL 防护测试通过。

### 阶段 B：解析器与转换器（P0/P1）

- [ ] 创建经脱敏的 HTML fixtures。
- [ ] 完成微信元信息、正文提取、DOM 清洗、Turndown 自定义规则。
- [ ] 支持文章基本 Markdown、懒加载图片、代码块、表格、媒体占位。
- [ ] 保证 HTML 清洗与 Markdown 输出安全。

**阶段门槛：** fixtures 全部有确定、可断言的结果，无明显正文丢失。

### 阶段 C：抓取与图片处理（P0）

- [ ] HTTP 获取；失败时调用**现有** Playwright `getBrowser()`。
- [ ] 添加超时、跳转校验、内容大小限制和验证/错误页识别。
- [ ] 图片下载、内容哈希存储、Markdown 替换、失败警告。
- [ ] 把浏览器/HTTP 相关依赖做成可测试的注入边界。

**阶段门槛：** 模拟 HTTP→Playwright 兜底的测试通过，图片异常不会让整篇文章无故消失。

### 阶段 D：API 与安全（P0）

- [ ] 注册 `POST /api/import/wechat/preview`。
- [ ] 实现认证约束、限流/并发、关闭开关、统一错误返回。
- [ ] 保证新路由不破坏 `/api/wechat`、`/api/images/import` 和现有后台逻辑。
- [ ] API 测试。

**阶段门槛：** 未授权、无效域名、超限、超时、非公开文章均返回可理解的错误。

### 阶段 E：页面交互（P0/P1）

- [ ] 添加入口与 `WechatImportDialog.tsx`。
- [ ] 实现 URL 输入、解析状态、预览、警告、确认和取消。
- [ ] 复用 `createNote()` 与现有路由/分类/云同步流程。
- [ ] 处理重复导入提醒、取消和并发点击。
- [ ] 手机端与桌面端测试。

**阶段门槛：** 用户能够从粘贴一条文章 URL 到新便签完整走通，原便签不受影响。

### 阶段 F：收尾验证（必须执行）

```bash
npm run typecheck
npm run build
npm run test:backend
npm run test:frontend
npm test
```

- [ ] 修复本次变更导致的所有失败。
- [ ] 检查两个 Docker 构建路径可包含新运行时依赖及浏览器。
- [ ] 补充 README：功能入口、支持的 URL、常见失败原因、图片本地化说明、公开部署的频控风险。
- [ ] 最终输出文件清单、测试结果、真实站点的验证记录、限制和后续可改进项。

---

## 11. Definition of Done（验收标准）

全部满足才能认为任务完成：

- [ ] 在现有 Web App 中可找到“导入公众号文章”入口，桌面端和移动端可用。
- [ ] 输入公开微信文章链接后，能够看到正确正文的 Markdown 预览，而不是原始整页 HTML。
- [ ] 基本格式（标题、段落、加粗、链接、列表、代码块）有效；特殊元素至少有合理降级。
- [ ] 微信正文图片最终转成本系统 `/images/` 路径；内容去重；单图失败有清晰提示。
- [ ] 成功创建新便签，能继续编辑、预览和导出；不覆盖已有便签。
- [ ] 取消时不创建便签；错误时不创建空便签；连续点击不产生多篇相同便签。
- [ ] 原有公众号发布、图片导入、匿名本地存储、登录云同步行为保持不变。
- [ ] 安全校验覆盖 URL/重定向/资源大小/超时/并发/限流；无验证码绕过、无真实 Cookie 依赖。
- [ ] 离线 fixture 测试、相关前后端测试、类型检查、构建通过；若无法完成任何验证项，明确披露而不是假称通过。
- [ ] README 和最终变更说明足够让其他维护者使用与排障。

---

## 12. 可参考的开源实现（阅读思路，不要照搬整个项目）

### 记录定位与当前实现（2026-10-19 核对）

本节记录的是方案阶段的参考清单，不代表已确认直接复制了某个仓库的源码。
清单首项是 `jackwener/wechat-article-to-markdown`；`wanderer-yk/wx2md` 在原方案中
被注明与本项目技术栈最接近。本次核对时，工作区的本文档与 `server/wechat-import/` 尚未纳入
Git 跟踪，在本地可见的 Git 历史中未找到首项仓库名，不能据此推断唯一来源或引入提交。

当前实现按职责拆分为：`fetch.ts` 抓取页面，`extract.ts` 提取元信息和清洗正文，
`images.ts` 本地化图片，`convert.ts` 通过 Turndown + GFM 转为 Markdown，
`service.ts` 编排预览响应。转换后的代码块空白和 Markdown 硬换行属于正文内容，
不得用全局去行尾空格或连续空行折叠再次清理；链接目标中的括号等字符需要编码，
避免破坏 Markdown 链接边界。

### 参考项目

1. **jackwener/wechat-article-to-markdown**
   https://github.com/jackwener/wechat-article-to-markdown
   重点看：`#js_content`、`data-src`、标题/公众号/发布时间提取、微信代码块处理、图片下载。其方案以 Python + Camoufox 为主；本仓库不需要复制其 Python 运行时。

2. **wanderer-yk/wx2md**
   https://github.com/wanderer-yk/wx2md
   重点看：Node.js + Cheerio + Turndown、页面错误分类、微信特殊媒体节点、代码/表格/行内样式转换。与本仓库技术栈最接近。

3. **tianyaxiang/wechat-to-markdown**
   https://github.com/tianyaxiang/wechat-to-markdown
   重点看：转换器 Web 交互、Markdown 预览和用户操作流程。

4. **bzd6661/wechat-article-for-ai**
   https://github.com/bzd6661/wechat-article-for-ai
   重点看：微信复杂内容提取、异常/特殊节点处理。**不照搬验证码处理机制**。

5. **fengxxc/wechatmp2markdown**
   https://github.com/fengxxc/wechatmp2markdown
   重点看：图片模式与不同存储方案；本项目统一选择原有哈希图片存储。

**许可约束：**参考行为、算法思路和公共 HTML 结构没有问题；如果直接复制第三方源码，必须先核对对应具体仓库/文件的实际许可证，遵循署名、版权声明及其他约束。不要假定所有第三方项目均采用 MIT。`zhaoolee/notes` 主仓库采用 Apache-2.0。

---

## 13. Cursor 最终回答模板

完成代码后，使用下述格式回报：

```markdown
## 已实现
- ...

## 核心改动文件
- `...`：...

## 验证结果
- `npm run typecheck`：通过/未通过（说明）
- `npm run build`：通过/未通过（说明）
- `npm run test:backend`：通过/未通过（说明）
- `npm run test:frontend`：通过/未通过（说明）
- `npm test`：通过/未通过（说明）
- 真实公众号文章实测：N/N；未测则明确说明

## 已知限制与失败处理
- ...

## 进一步优化（不阻塞本次交付）
- ...
```

> **最后提醒：这是一个“完成开发”的任务。请不要停在研究、建议或搭建空文件阶段。遇到信息缺失时先查代码、采用最小兼容实现并继续，运行测试后提交可执行结果。**
