import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { createServerClient } = require("../dist/main/index.js");
const { parse, serialize } = require("cookie");
const backend = JSON.parse(
  await readFile(new URL("./supabase-status.json", import.meta.url), "utf8"),
);
assert.ok(
  ["127.0.0.1", "localhost"].includes(new URL(backend.API_URL).hostname),
);
assert.ok(backend.ANON_KEY && backend.SERVICE_ROLE_KEY);

const credentials = {
  email: `cookie-adapter-${randomUUID()}@example.com`,
  password: `Test-${randomUUID()}!`,
};
const createdUser = await fetch(`${backend.API_URL}/auth/v1/admin/users`, {
  method: "POST",
  headers: {
    apikey: backend.SERVICE_ROLE_KEY,
    Authorization: `Bearer ${backend.SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    ...credentials,
    email_confirm: true,
    user_metadata: { padding: "x".repeat(1800) },
  }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(createdUser.status, 200, "Create the disposable test user");
const user = await createdUser.json();
assert.ok(user.id);

const bundle = await build({
  stdin: {
    contents: [
      'import { createBrowserClient } from "./dist/module/index.js";',
      'import { parse, serialize } from "cookie";',
      "globalThis.ssrValidation = { createBrowserClient, parse, serialize };",
    ].join("\n"),
    resolveDir: resolve("."),
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
});

class ServerCookieAdapter {
  constructor(request, response) {
    this.values = new Map(Object.entries(parse(request.headers.cookie ?? "")));
    this.response = response;
    this.reads = 0;
    this.writes = 0;
    this.headerBatches = [];
  }

  getAll() {
    this.reads += 1;
    return [...this.values].map(([name, value]) => ({ name, value }));
  }

  setAll(cookies, headers) {
    this.writes += 1;
    this.headerBatches.push(headers);
    const setCookie = this.response.getHeader("Set-Cookie") ?? [];
    for (const { name, value, options } of cookies) {
      if (options.maxAge === 0) {
        this.values.delete(name);
      } else {
        this.values.set(name, value);
      }
      setCookie.push(serialize(name, value, options));
    }
    this.response.setHeader("Set-Cookie", setCookie);
    for (const [name, value] of Object.entries(headers)) {
      this.response.setHeader(name, value);
    }
  }
}

async function handleRequest(request, response) {
  const route = new URL(request.url, "http://127.0.0.1").pathname;
  if (route === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><script src="/client.js"></script>');
    return;
  }
  if (route === "/client.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(bundle.outputFiles[0].text);
    return;
  }
  if (!route.startsWith("/server/")) {
    response.statusCode = 404;
    response.end();
    return;
  }

  const cookies = new ServerCookieAdapter(request, response);
  const client = createServerClient(backend.API_URL, backend.ANON_KEY, {
    cookies,
    cookieOptions: { name: "server-session" },
  });
  let result;
  switch (route) {
    case "/server/sign-in":
      result = await client.auth.signInWithPassword(credentials);
      break;
    case "/server/refresh":
      result = await client.auth.refreshSession();
      break;
    case "/server/sign-out":
      result = await client.auth.signOut({ scope: "local" });
      break;
    case "/server/user":
      result = await client.auth.getUser();
      break;
    default:
      throw new Error(`Unexpected route: ${route}`);
  }
  response.statusCode = result.error ? 401 : 200;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({
      userId: result.data?.user?.id ?? result.data?.session?.user?.id ?? null,
      error: result.error?.message ?? null,
      reads: cookies.reads,
      writes: cookies.writes,
      headerBatches: cookies.headerBatches,
    }),
  );
}

const server = createServer({ maxHeaderSize: 65536 }, (request, response) => {
  handleRequest(request, response).catch((error) => {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: error.message }));
  });
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const passed = [];
const browserErrors = [];
const record = (name) => {
  passed.push(name);
  console.log(`PASS ${name}`);
};
const authCookies = async (context, prefix) =>
  (await context.cookies()).filter(({ name }) => name.startsWith(prefix));
const serverRequest = (page, route) =>
  page.evaluate(async (path) => {
    const response = await fetch(path, { method: "POST" });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.json(),
    };
  }, route);

function assertServerWrite(result) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.writes > 0);
  assert.equal(
    result.headers["cache-control"],
    "private, no-cache, no-store, must-revalidate, max-age=0",
  );
  assert.equal(result.headers.expires, "0");
  assert.equal(result.headers.pragma, "no-cache");
  assert.equal(
    result.body.headerBatches.filter((headers) => Object.keys(headers).length)
      .length,
    1,
  );
}

async function initializeBrowserClient(page) {
  await page.evaluate(
    ({ apiUrl, anonKey }) => {
      class BrowserCookieAdapter {
        reads = 0;
        writes = 0;
        headerBatches = [];

        getAll() {
          this.reads += 1;
          return Object.entries(ssrValidation.parse(document.cookie)).map(
            ([name, value]) => ({ name, value }),
          );
        }

        async setAll(cookies, headers) {
          await Promise.resolve();
          this.writes += 1;
          this.headerBatches.push(headers);
          for (const { name, value, options } of cookies) {
            document.cookie = ssrValidation.serialize(name, value, options);
          }
        }
      }
      globalThis.cookieAdapter = new BrowserCookieAdapter();
      globalThis.browserClient = ssrValidation.createBrowserClient(
        apiUrl,
        anonKey,
        {
          cookies: cookieAdapter,
          cookieOptions: { name: "browser-session" },
          isSingleton: false,
          auth: { autoRefreshToken: false, detectSessionInUrl: false },
        },
      );
    },
    { apiUrl: backend.API_URL, anonKey: backend.ANON_KEY },
  );
}

async function browserAction(page, action) {
  return page.evaluate(
    async ({ action, credentials }) => {
      const result =
        action === "signInWithPassword"
          ? await browserClient.auth.signInWithPassword(credentials)
          : action === "signOut"
            ? await browserClient.auth.signOut({ scope: "local" })
            : await browserClient.auth[action]();
      if (result.error) throw new Error(result.error.message);
      return {
        userId: result.data?.user?.id ?? result.data?.session?.user?.id ?? null,
        sessionPresent: Boolean(result.data?.session),
        reads: cookieAdapter.reads,
        writes: cookieAdapter.writes,
        headerBatches: cookieAdapter.headerBatches,
      };
    },
    { action, credentials },
  );
}

try {
  const serverContext = await browser.newContext();
  await serverContext.addCookies([
    { name: "unrelated", value: "keep", url: origin },
  ]);
  const serverPage = await serverContext.newPage();
  serverPage.on("pageerror", (error) => browserErrors.push(error.message));
  await serverPage.goto(origin);

  const signIn = await serverRequest(serverPage, "/server/sign-in");
  assertServerWrite(signIn);
  assert.equal(signIn.body.userId, user.id);
  assert.ok((await authCookies(serverContext, "server-session")).length > 1);
  record("server sign-in writes chunked cookies and cache headers");

  await serverPage.reload();
  const serverUser = await serverRequest(serverPage, "/server/user");
  assert.equal(serverUser.status, 200, JSON.stringify(serverUser.body));
  assert.equal(serverUser.body.userId, user.id);
  assert.ok(serverUser.body.reads > 0);
  record("new server client restores and verifies the session after reload");

  const refresh = await serverRequest(serverPage, "/server/refresh");
  assertServerWrite(refresh);
  assert.equal(refresh.body.userId, user.id);
  record("server refresh persists replacement cookies and cache headers");

  assertServerWrite(await serverRequest(serverPage, "/server/sign-out"));
  assert.equal((await authCookies(serverContext, "server-session")).length, 0);
  assert.ok(
    (await serverContext.cookies()).some(({ name }) => name === "unrelated"),
  );
  assert.equal((await serverRequest(serverPage, "/server/user")).status, 401);
  record(
    "server sign-out clears all auth chunks and preserves unrelated cookies",
  );
  await serverContext.close();

  const browserContext = await browser.newContext();
  await browserContext.addCookies([
    { name: "unrelated", value: "keep", url: origin },
  ]);
  const page = await browserContext.newPage();
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(origin);
  await initializeBrowserClient(page);
  const browserSignIn = await browserAction(page, "signInWithPassword");
  assert.equal(browserSignIn.userId, user.id);
  assert.ok(browserSignIn.writes > 0);
  assert.ok((await authCookies(browserContext, "browser-session")).length > 1);
  record(
    "browser sign-in writes real document.cookie through an async adapter",
  );

  await page.reload();
  await initializeBrowserClient(page);
  const restored = await browserAction(page, "getSession");
  assert.equal(restored.userId, user.id);
  assert.ok(restored.sessionPresent && restored.reads > 0);
  assert.equal((await browserAction(page, "getUser")).userId, user.id);
  record(
    "new browser client restores cookies and verifies the user after reload",
  );

  const browserRefresh = await browserAction(page, "refreshSession");
  assert.equal(browserRefresh.userId, user.id);
  assert.ok(browserRefresh.writes > 0);
  assert.ok(
    browserRefresh.headerBatches.every(
      (headers) => !Object.keys(headers).length,
    ),
  );
  record(
    "browser refresh awaits the stateful adapter without server-only headers",
  );

  await browserAction(page, "signOut");
  assert.equal(
    (await authCookies(browserContext, "browser-session")).length,
    0,
  );
  assert.equal((await browserAction(page, "getSession")).sessionPresent, false);
  assert.ok(
    (await browserContext.cookies()).some(({ name }) => name === "unrelated"),
  );
  record(
    "browser sign-out clears all auth chunks and preserves unrelated cookies",
  );
  assert.deepEqual(browserErrors, []);
  console.log(
    JSON.stringify({
      passed: passed.length,
      scenarios: passed,
      node: process.version,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
