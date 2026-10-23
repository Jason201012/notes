import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { NotesDataStore } from "../../server/auth.js";
import {
  InvalidSitePublishConfigurationError,
  parseSitePublishDraft,
  SITE_PUBLISH_CONFIGURATION_MAX_BYTES,
  SitePublishConfigurationConflictError,
} from "../../server/site-publishing/configuration.js";
import { createSitePublishDraft } from "../../src/features/site-publishing/model.js";
import { validateSiteExportRequest } from "../../server/site-publishing/build.js";

const execFileAsync = promisify(execFile);
const localLogoPath = `/images/${"c".repeat(64)}.png`;
const note = {
  createdAt: 1_600_000_000_000,
  deletedAt: null,
  folderId: null,
  id: "note-1",
  isStarred: false,
  markdown: "SECRET_NOTE_BODY_MARKER",
  normalOrder: 0,
  pinnedAt: null,
  updatedAt: 1_600_000_100_000,
};

function createDraft(title = "我的便签网站") {
  const draft = createSitePublishDraft("https://example.test");
  draft.settings.title = title;
  draft.settings.logoPath = localLogoPath;
  draft.selections = [{ noteId: note.id, categoryId: "guides" }];
  return draft;
}

function createWorkspace(label: string) {
  return {
    activeNoteId: `workspace-note-${label}`,
    folders: [],
    notes: [
      {
        ...note,
        id: `workspace-note-${label}`,
        markdown: `WORKSPACE_MARKDOWN_${label}`,
      },
    ],
    version: 1,
  };
}

async function createTemporaryDirectory(context: TestContext, prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test("账号草稿只保留设置、分类和选择，允许编辑中的半成品并兼容旧 rootPath", () => {
  const draft = createDraft();
  const legacy = {
    settings: {
      author: "",
      categories: [{ id: "unused", name: "不应保留", slug: "unused" }],
      description: "",
      logoPath: undefined,
      origin: "https://half-typed",
      rootPath: "/legacy/blog",
      themeId: "smartisan-blog",
      title: "",
      markdown: "SECRET_NOTE_BODY_MARKER",
    },
    categories: [
      { extra: 1, id: "guides", name: "做法", slug: "guides" },
      { id: "guides", name: "", slug: "NOT A SLUG" },
    ],
    selections: [
      { categoryId: "guides", noteId: "note-1", markdown: "SECRET" },
      { categoryId: "deleted-category", noteId: "unknown-note" },
    ],
    ownerId: "attacker",
    notes: [{ markdown: "SECRET_NOTE_BODY_MARKER" }],
  };

  const parsed = parseSitePublishDraft(legacy);

  assert.equal(parsed.settings.title, "");
  assert.equal(parsed.settings.basePath, "/legacy/blog");
  assert.equal(parsed.settings.logoPath, "");
  assert.equal(parsed.categories.length, 2);
  assert.deepEqual(parsed.categories[0], { id: "guides", name: "做法", slug: "guides" });
  assert.deepEqual(parsed.categories[1], { id: "guides", name: "", slug: "NOT A SLUG" });
  assert.deepEqual(parsed.selections, [
    { noteId: "note-1", categoryId: "guides" },
    { noteId: "unknown-note", categoryId: "deleted-category" },
  ]);
  assert.equal(JSON.stringify(parsed).includes("SECRET_NOTE_BODY_MARKER"), false);
  assert.equal(JSON.stringify(parsed).includes("ownerId"), false);
  assert.equal(JSON.stringify(parsed).includes("unused"), false);

  // 新 basePath 显式存在时优先，即使为空串；只有完全缺失时才读取 rootPath。
  const preferred = parseSitePublishDraft({
    ...legacy,
    settings: { ...legacy.settings, basePath: "", rootPath: "/legacy/blog" },
  });
  assert.equal(preferred.settings.basePath, "");

  // 空选择可以保存（用户尚未勾选便签）；空分类不允许，UI 也不会删除最后一个分类。
  assert.deepEqual(
    parseSitePublishDraft({ ...legacy, selections: [] }).selections,
    [],
  );
  assert.equal(parseSitePublishDraft(draft).categories.length, 5);
});

test("账号草稿按字段边界明确拒绝超长、缺字段、非法 Logo 与超过 1MB 的输入", () => {
  const valid = createDraft();

  const rejected: Array<[unknown, RegExp]> = [
    [null, /格式不正确/],
    [{ ...valid, settings: undefined }, /网站设置不完整/],
    [{ ...valid, settings: { ...valid.settings, title: undefined } }, /网站名称/],
    [{ ...valid, settings: { ...valid.settings, title: 1 } }, /网站名称/],
    [{ ...valid, settings: { ...valid.settings, title: "长".repeat(101) } }, /网站名称不能超过 100/],
    [{ ...valid, settings: { ...valid.settings, description: "长".repeat(501) } }, /网站简介不能超过 500/],
    [{ ...valid, settings: { ...valid.settings, author: "长".repeat(101) } }, /作者名称不能超过 100/],
    [{ ...valid, settings: { ...valid.settings, origin: "长".repeat(501) } }, /站点域名不能超过 500/],
    [{ ...valid, settings: { ...valid.settings, basePath: "/".repeat(161) } }, /部署路径不能超过 160/],
    [{ ...valid, settings: { ...valid.settings, themeId: "unknown" } }, /不支持此网站样式/],
    [{ ...valid, settings: { ...valid.settings, logoPath: "https://evil.test/logo.png" } }, /网站 Logo/],
    [{ ...valid, settings: { ...valid.settings, logoPath: "/images/logo.png" } }, /网站 Logo/],
    [{ ...valid, settings: { ...valid.settings, logoPath: null } }, /网站 Logo/],
    [{ ...valid, categories: [] }, /1–30 个分类/],
    [{ ...valid, categories: Array.from({ length: 31 }, (_, index) => ({ id: `c${index}`, name: "分类", slug: `c${index}` })) }, /1–30 个分类/],
    [{ ...valid, categories: "guides" }, /网站分类格式不正确/],
    [{ ...valid, categories: [{ id: "x".repeat(81), name: "分类", slug: "slug" }] }, /分类的 ID不能超过 80/],
    [{ ...valid, categories: [{ id: "x", name: "长".repeat(31), slug: "slug" }] }, /分类的名称不能超过 30/],
    [{ ...valid, categories: [{ id: "x", name: "分类", slug: "s".repeat(49) }] }, /分类的路径不能超过 48/],
    [{ ...valid, categories: [{ id: "", name: "分类", slug: "slug" }] }, /缺少 ID/],
    [{ ...valid, categories: [{ id: "x", name: 1, slug: "slug" }] }, /分类的名称/],
    [{ ...valid, selections: {} }, /便签选择格式不正确/],
    [{ ...valid, selections: [{ noteId: "n".repeat(201), categoryId: "guides" }] }, /便签选择不能超过 200/],
    [{ ...valid, selections: [{ noteId: "n", categoryId: "c".repeat(81) }] }, /便签分类不能超过 80/],
    [{ ...valid, selections: [{ noteId: "", categoryId: "guides" }] }, /缺少便签或分类/],
  ];

  for (const [value, pattern] of rejected) {
    assert.throws(
      () => parseSitePublishDraft(value),
      (error: unknown) =>
        error instanceof InvalidSitePublishConfigurationError &&
        pattern.test(error.message),
      JSON.stringify(value).slice(0, 160),
    );
  }

  // 分类重复、路径非法、分类名称为空等编辑中状态可以暂存；导出时才严格校验。
  const editable = parseSitePublishDraft({
    ...valid,
    categories: [
      { id: "a", name: "", slug: "x" },
      { id: "a", name: "重复", slug: "x" },
    ],
  });
  assert.equal(editable.categories.length, 2);

  const huge = {
    ...valid,
    selections: Array.from({ length: 6000 }, (_, index) => ({
      categoryId: "guides",
      noteId: `${String(index).padStart(6, "0")}-${"n".repeat(180)}`,
    })),
  };
  const hugeBytes = Buffer.byteLength(JSON.stringify(huge));
  assert.ok(hugeBytes > SITE_PUBLISH_CONFIGURATION_MAX_BYTES);
  assert.throws(() => parseSitePublishDraft(huge), /网站发布设置过大/);
});

test("旧 database 兼容、账号隔离、CAS 冲突与持久化不破坏工作区和公众号配置", async (context) => {
  const dataDirectory = await createTemporaryDirectory(
    context,
    "site-config-store-",
  );
  const databasePath = path.join(dataDirectory, "notes-data.json");
  await writeFile(
    databasePath,
    JSON.stringify({
      anonymousUploadQuota: { count: 3, dateKey: "2026-01-01" },
      hermesInstallLinks: { ownerA: "notes_hi_v1.ticket" },
      users: [],
      version: 1,
      wechatConfigurations: {
        ownerA: {
          appId: "wxaaaaaaaaaaaaaaaa",
          appSecret: "a".repeat(32),
          updatedAt: 100,
        },
      },
      workspaces: {
        ownerA: { updatedAt: 50, workspace: createWorkspace("a") },
        ownerB: { updatedAt: 60, workspace: createWorkspace("b") },
      },
    }),
    "utf8",
  );

  const store = new NotesDataStore(dataDirectory);
  assert.equal(await store.getSitePublishingConfiguration("ownerA"), null);

  const savedA = await store.saveSitePublishingConfiguration(
    "ownerA",
    createDraft("账号 A 的网站"),
    null,
    1_000,
  );
  assert.equal(savedA.updatedAt, 1_000);
  assert.equal(savedA.draft.settings.title, "账号 A 的网站");

  // 时间戳单调，即使调用方传入更小的 now 也不回退。
  const bumped = await store.saveSitePublishingConfiguration(
    "ownerA",
    createDraft("账号 A 第二次"),
    1_000,
    10,
  );
  assert.equal(bumped.updatedAt, 1_001);

  // expected 与当前版本不一致时拒绝覆盖。
  for (const stale of [null, 1_000, 999_999]) {
    await assert.rejects(
      () =>
        store.saveSitePublishingConfiguration(
          "ownerA",
          createDraft("覆盖标题"),
          stale,
        ),
      (error: unknown) =>
        error instanceof SitePublishConfigurationConflictError &&
        error.updatedAt === 1_001,
    );
  }
  assert.equal(
    (await store.getSitePublishingConfiguration("ownerA"))!.draft.settings
      .title,
    "账号 A 第二次",
  );

  const savedB = await store.saveSitePublishingConfiguration(
    "ownerB",
    createDraft("账号 B 的网站"),
    null,
  );
  assert.notEqual(savedB.updatedAt, bumped.updatedAt);

  // 字段校验失败时不写入，也不影响已有记录。
  await assert.rejects(
    () =>
      store.saveSitePublishingConfiguration(
        "ownerA",
        { ...createDraft(), settings: {} },
        1_001,
      ),
    InvalidSitePublishConfigurationError,
  );
  assert.equal(
    (await store.getSitePublishingConfiguration("ownerA"))!.updatedAt,
    1_001,
  );

  // 额外字段被剥离，便签正文不会进入配置。
  const stripped = await store.saveSitePublishingConfiguration(
    "ownerB",
    {
      ...createDraft("账号 B 第二次"),
      markdown: "SECRET_NOTE_BODY_MARKER",
      ownerId: "ownerA",
      notes: [{ markdown: "SECRET_NOTE_BODY_MARKER" }],
    },
    savedB.updatedAt,
  );
  assert.equal(JSON.stringify(stripped.draft).includes("SECRET_NOTE_BODY_MARKER"), false);
  assert.equal(
    (await store.getSitePublishingConfiguration("ownerA"))!.draft.settings
      .title,
    "账号 A 第二次",
  );

  // 新进程/新实例读取同一文件，草稿持久化，工作区和公众号配置保持不变。
  const reopened = new NotesDataStore(dataDirectory);
  const persisted = await reopened.getSitePublishingConfiguration("ownerA");
  assert.deepEqual(persisted, {
    draft: createDraft("账号 A 第二次"),
    updatedAt: 1_001,
  });
  assert.equal(
    (await reopened.getSitePublishingConfiguration("ownerB"))!.draft.settings
      .title,
    "账号 B 第二次",
  );
  assert.equal(
    ((await reopened.getWorkspace("ownerA"))!.workspace.notes[0] as {
      markdown: string;
    }).markdown,
    "WORKSPACE_MARKDOWN_a",
  );
  assert.equal((await reopened.getWorkspace("ownerB"))!.updatedAt, 60);
  assert.equal(
    (await reopened.getWechatConfiguration("ownerA"))!.appId,
    "wxaaaaaaaaaaaaaaaa",
  );

  const raw = JSON.parse(await readFile(databasePath, "utf8")) as {
    sitePublishingConfigurations: Record<string, { draft: unknown }>;
  };
  assert.deepEqual(Object.keys(raw.sitePublishingConfigurations).sort(), [
    "ownerA",
    "ownerB",
  ]);
  assert.equal(
    JSON.stringify(raw.sitePublishingConfigurations).includes(
      "SECRET_NOTE_BODY_MARKER",
    ),
    false,
  );
});

test("损坏的单条账号草稿被丢弃，其他账号、工作区与公众号配置仍可读取", async (context) => {
  const dataDirectory = await createTemporaryDirectory(
    context,
    "site-config-corrupt-",
  );
  const databasePath = path.join(dataDirectory, "notes-data.json");
  await writeFile(
    databasePath,
    JSON.stringify({
      sitePublishingConfigurations: {
        brokenShape: "not-an-object",
        brokenDraft: {
          draft: { settings: { title: "缺少字段" }, categories: [], selections: [] },
          updatedAt: 5,
        },
        brokenTimestamp: { draft: createDraft(), updatedAt: "yesterday" },
        good: { draft: createDraft("好账号"), updatedAt: 7 },
      },
      users: [],
      version: 1,
      wechatConfigurations: {
        good: {
          appId: "wxbbbbbbbbbbbbbbbb",
          appSecret: "b".repeat(32),
          updatedAt: 9,
        },
      },
      workspaces: { good: { updatedAt: 11, workspace: createWorkspace("good") } },
    }),
    "utf8",
  );

  const store = new NotesDataStore(dataDirectory);
  assert.equal(await store.getSitePublishingConfiguration("brokenShape"), null);
  assert.equal(await store.getSitePublishingConfiguration("brokenDraft"), null);
  assert.equal(await store.getSitePublishingConfiguration("brokenTimestamp"), null);
  assert.equal(
    (await store.getSitePublishingConfiguration("good"))!.draft.settings.title,
    "好账号",
  );
  assert.equal((await store.getWorkspace("good"))!.updatedAt, 11);
  assert.equal(
    (await store.getWechatConfiguration("good"))!.appSecret,
    "b".repeat(32),
  );
});

test("201 张便签的账号草稿完整保存，导出校验不再被 200 张截断", async (context) => {
  const dataDirectory = await createTemporaryDirectory(
    context,
    "site-config-201-",
  );
  const draft = createSitePublishDraft();
  draft.selections = Array.from({ length: 201 }, (_, index) => ({
    categoryId: "guides",
    noteId: `note-${index}`,
  }));

  const store = new NotesDataStore(dataDirectory);
  const saved = await store.saveSitePublishingConfiguration("owner", draft, null);
  assert.equal(saved.draft.selections.length, 201);
  assert.deepEqual(saved.draft.selections.at(-1), {
    noteId: "note-200",
    categoryId: "guides",
  });
  assert.equal(
    (await new NotesDataStore(dataDirectory).getSitePublishingConfiguration("owner"))!
      .draft.selections.length,
    201,
  );

  const notes = draft.selections.map((selection, index) => ({
    categoryId: "guides",
    createdAt: note.createdAt,
    deletedAt: null,
    id: selection.noteId,
    markdown: `## 便签 ${index}\n\n正文`,
    updatedAt: note.updatedAt,
  }));
  const request = validateSiteExportRequest({
    categories: draft.categories,
    notes,
    settings: { ...draft.settings, origin: "", basePath: "/" },
  });
  assert.equal(request.notes.length, 201);

  let hugoAvailable = true;
  try {
    await execFileAsync("hugo", ["version"], { timeout: 10_000 });
  } catch {
    hugoAvailable = false;
  }
  if (!hugoAvailable) {
    context.diagnostic("未安装 Hugo，跳过 201 张便签真实构建（导出校验仍已覆盖）");
    return;
  }

  const { buildSiteEntries } = await import("../../server/site-publishing/build.js");
  const entries = await buildSiteEntries(request, {
    readImage: async () => {
      throw new Error("201 张便签测试不包含图片");
    },
    rootDirectory: process.cwd(),
    signal: new AbortController().signal,
  });
  const paths = entries.map((entry) => entry.path);
  assert.equal(
    paths.filter((entry) => /^notes-hugo-site\/content\/guides\/p-[a-f0-9]+\/index\.md$/.test(entry))
      .length,
    201,
  );
  assert.equal(
    paths.filter((entry) => /^notes-hugo-site\/public\/guides\/p-[a-f0-9]+\/index\.html$/.test(entry))
      .length,
    201,
  );
});

async function getUnusedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();

  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("无法分配网站配置测试端口");
  }

  const port = address.port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`后端在网站配置测试前退出，退出码：${child.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);

      if (response.ok) {
        return;
      }
    } catch {
      // 服务仍在启动。
    }

    await delay(100);
  }

  throw new Error("等待网站配置测试后端超时");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(5_000, undefined, { ref: false }).then(() => {
      if (child.exitCode == null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function getCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";")[0];
}

async function postJson(
  baseUrl: string,
  pathname: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    method: "POST",
  });
}

async function putJson(
  baseUrl: string,
  pathname: string,
  body: unknown,
  cookie?: string,
  origin?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    method: "PUT",
  });
}

async function getJson(
  baseUrl: string,
  pathname: string,
  cookie?: string,
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

test("网站发布配置接口：登录归属、同源、校验、CAS、账号隔离与工作区不受影响", async (context) => {
  const dataDirectory = await createTemporaryDirectory(
    context,
    "site-config-http-data-",
  );
  const imageDirectory = await createTemporaryDirectory(
    context,
    "site-config-http-images-",
  );
  const port = await getUnusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_STORAGE_DIR: dataDirectory,
      IMAGE_STORAGE_DIR: imageDirectory,
      PORT: String(port),
      SESSION_SECRET: "site-publishing-config-test-session-secret",
      SUPERADMIN: "config-admin",
      SUPERADMINPASSWORD: "config-admin-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  context.after(async () => {
    await stopChild(child);
  });

  await waitForHealth(baseUrl, child);

  try {
    const adminLogin = await postJson(baseUrl, "/api/superadmin/login", {
      password: "config-admin-password",
      remember: false,
      username: "config-admin",
    });
    assert.equal(adminLogin.status, 200);
    const adminCookie = getCookie(adminLogin);

    const createdUsers: Array<{ id: string; initialPassword: string }> = [];
    for (const username of ["config-user-a", "config-user-b"]) {
      const created = await postJson(
        baseUrl,
        "/api/superadmin/users",
        { username },
        adminCookie,
      );
      assert.equal(created.status, 201);
      createdUsers.push((await created.json()).user);
    }

    const cookies: string[] = [];
    for (const [index, user] of createdUsers.entries()) {
      const login = await postJson(baseUrl, "/api/auth/login", {
        password: user.initialPassword,
        remember: false,
        username: index === 0 ? "config-user-a" : "config-user-b",
      });
      assert.equal(login.status, 200);
      cookies.push(getCookie(login));
    }
    const [cookieA, cookieB] = cookies;

    // 匿名与跨站请求都不能读写配置。
    assert.equal((await getJson(baseUrl, "/api/site-publishing/config")).status, 401);
    assert.equal(
      (
        await putJson(
          baseUrl,
          "/api/site-publishing/config",
          { draft: createDraft(), expectedUpdatedAt: null },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await getJson(
          baseUrl,
          "/api/site-publishing/config",
          cookieA,
        )
      ).status,
      200,
    );
    const crossSite = await putJson(
      baseUrl,
      "/api/site-publishing/config",
      { draft: createDraft(), expectedUpdatedAt: null },
      cookieA,
      "https://evil.test",
    );
    assert.equal(crossSite.status, 403);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/site-publishing/config`, {
          headers: { Cookie: cookieA, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );

    const initial = await getJson(baseUrl, "/api/site-publishing/config", cookieA);
    assert.equal(initial.status, 200);
    assert.match(initial.headers.get("cache-control") || "", /no-store/);
    assert.match(initial.headers.get("pragma") || "", /no-cache/);
    assert.deepEqual(await initial.json(), { draft: null, updatedAt: null });

    // expectedUpdatedAt 必须显式提供为整数正值或 null。
    for (const body of [
      { draft: createDraft() },
      { draft: createDraft(), expectedUpdatedAt: "1" },
      { draft: createDraft(), expectedUpdatedAt: 0 },
      { draft: createDraft(), expectedUpdatedAt: -1 },
      { draft: createDraft(), expectedUpdatedAt: 1.5 },
      { draft: createDraft(), expectedUpdatedAt: true },
    ]) {
      assert.equal(
        (await putJson(baseUrl, "/api/site-publishing/config", body, cookieA))
          .status,
        400,
        JSON.stringify(body),
      );
    }

    // 非法输入明确 400，且不会返回堆栈或磁盘路径。
    for (const draft of [
      undefined,
      { ...createDraft(), settings: { ...createDraft().settings, themeId: "unknown" } },
      { ...createDraft(), categories: [] },
      { ...createDraft(), settings: { ...createDraft().settings, logoPath: "https://evil.test/logo.png" } },
      { ...createDraft(), selections: [{ noteId: "n".repeat(201), categoryId: "guides" }] },
    ]) {
      const response = await putJson(
        baseUrl,
        "/api/site-publishing/config",
        { draft, expectedUpdatedAt: null },
        cookieA,
      );
      assert.equal(response.status, 400, JSON.stringify(draft)?.slice(0, 120));
      const payload = (await response.json()) as { error?: string };
      assert.equal(typeof payload.error, "string");
      assert.doesNotMatch(payload.error || "", /notes-data\.json|\/tmp\/|at /);
    }

    // 额外 ownerId 与便签正文不会影响归属，也不会被存储或回显。
    const firstSave = await putJson(
      baseUrl,
      "/api/site-publishing/config",
      {
        draft: {
          ...createDraft("账号 A 的网站"),
          markdown: "SECRET_NOTE_BODY_MARKER",
        },
        expectedUpdatedAt: null,
        notes: [{ markdown: "SECRET_NOTE_BODY_MARKER" }],
        ownerId: createdUsers[1].id,
      },
      cookieA,
    );
    assert.equal(firstSave.status, 200);
    const firstSaved = (await firstSave.json()) as {
      draft: { settings: { title: string }; selections: unknown[] };
      updatedAt: number;
    };
    assert.equal(firstSaved.draft.settings.title, "账号 A 的网站");
    assert.equal(JSON.stringify(firstSaved).includes("SECRET_NOTE_BODY_MARKER"), false);
    assert.equal(JSON.stringify(firstSaved).includes("ownerId"), false);
    assert.ok(firstSaved.updatedAt > 0);

    // 便签 B 没有被写入，管理员账号也没有。
    assert.deepEqual(
      await (await getJson(baseUrl, "/api/site-publishing/config", cookieB)).json(),
      { draft: null, updatedAt: null },
    );
    assert.deepEqual(
      await (await getJson(baseUrl, "/api/site-publishing/config", adminCookie)).json(),
      { draft: null, updatedAt: null },
    );

    // CAS：旧版本（含 null）返回 409，且不覆盖已保存草稿。
    for (const stale of [null, firstSaved.updatedAt - 1]) {
      const conflict = await putJson(
        baseUrl,
        "/api/site-publishing/config",
        { draft: createDraft("不应覆盖"), expectedUpdatedAt: stale },
        cookieA,
      );
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), {
        error: "网站发布设置已被其他设备更新，请刷新后重试。",
        updatedAt: firstSaved.updatedAt,
      });
    }
    const afterConflict = (await (
      await getJson(baseUrl, "/api/site-publishing/config", cookieA)
    ).json()) as { draft: { settings: { title: string } }; updatedAt: number };
    assert.equal(afterConflict.draft.settings.title, "账号 A 的网站");
    assert.equal(afterConflict.updatedAt, firstSaved.updatedAt);

    const secondSave = await putJson(
      baseUrl,
      "/api/site-publishing/config",
      {
        draft: createDraft("账号 A 第二次"),
        expectedUpdatedAt: firstSaved.updatedAt,
      },
      cookieA,
    );
    assert.equal(secondSave.status, 200);
    const secondSaved = (await secondSave.json()) as { updatedAt: number };
    assert.ok(secondSaved.updatedAt > firstSaved.updatedAt);

    // 账号 B、管理员各自独立。
    assert.equal(
      (
        await putJson(
          baseUrl,
          "/api/site-publishing/config",
          { draft: createDraft("账号 B 的网站"), expectedUpdatedAt: null },
          cookieB,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await putJson(
          baseUrl,
          "/api/site-publishing/config",
          { draft: createDraft("管理员的网站"), expectedUpdatedAt: null },
          adminCookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        (await (
          await getJson(baseUrl, "/api/site-publishing/config", cookieB)
        ).json()) as { draft: { settings: { title: string } } }
      ).draft.settings.title,
      "账号 B 的网站",
    );
    assert.equal(
      (
        (await (
          await getJson(baseUrl, "/api/site-publishing/config", adminCookie)
        ).json()) as { draft: { settings: { title: string } } }
      ).draft.settings.title,
      "管理员的网站",
    );

    // 保存配置不会改动原工作区。
    const workspace = createWorkspace("http");
    const workspaceSave = await fetch(`${baseUrl}/api/workspace`, {
      body: JSON.stringify({ workspace }),
      headers: { "Content-Type": "application/json", Cookie: cookieA },
      method: "PUT",
    });
    assert.equal(workspaceSave.status, 200);
    const workspaceBefore = await (
      await fetch(`${baseUrl}/api/workspace`, { headers: { Cookie: cookieA } })
    ).json();
    await putJson(
      baseUrl,
      "/api/site-publishing/config",
      {
        draft: createDraft("保存配置后"),
        expectedUpdatedAt: secondSaved.updatedAt,
      },
      cookieA,
    );
    assert.deepEqual(
      await (
        await fetch(`${baseUrl}/api/workspace`, { headers: { Cookie: cookieA } })
      ).json(),
      workspaceBefore,
    );

    // 201 个选择不被 200 截断。
    const manySelections = Array.from({ length: 201 }, (_, index) => ({
      categoryId: "guides",
      noteId: `note-${index}`,
    }));
    const manyDraft = createDraft("201 张");
    manyDraft.selections = manySelections;
    const currentA = (await (
      await getJson(baseUrl, "/api/site-publishing/config", cookieA)
    ).json()) as { updatedAt: number };
    const manySave = await putJson(
      baseUrl,
      "/api/site-publishing/config",
      { draft: manyDraft, expectedUpdatedAt: currentA.updatedAt },
      cookieA,
    );
    assert.equal(manySave.status, 200);
    const manySaved = (await manySave.json()) as {
      draft: { selections: unknown[] };
    };
    assert.deepEqual(manySaved.draft.selections, manySelections);

    // 落盘文件只包含账号 ID 键，且没有便签正文。
    const rawDatabase = await readFile(
      path.join(dataDirectory, "notes-data.json"),
      "utf8",
    );
    assert.equal(rawDatabase.includes("SECRET_NOTE_BODY_MARKER"), false);
    assert.equal(
      rawDatabase.includes(createdUsers[1].id),
      true,
      "账号 B 的 ID 应作为独立配置键出现",
    );
    const database = JSON.parse(rawDatabase) as {
      sitePublishingConfigurations: Record<string, unknown>;
    };
    assert.deepEqual(
      Object.keys(database.sitePublishingConfigurations).sort(),
      [createdUsers[0].id, createdUsers[1].id, "superadmin"].sort(),
    );
  } catch (error) {
    if (error instanceof Error) {
      error.message += `\n后端 stdout:\n${stdout}\n后端 stderr:\n${stderr}`;
    }
    throw error;
  }
});
