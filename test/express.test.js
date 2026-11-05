import assert from "node:assert";
import http from "node:http";
import nodeTest from "node:test";
import express from "express";
import nodemailer from "nodemailer";
import {
  UniOneTransport,
  clientMiddleware,
  createClient,
  resolveOptions,
  signBody,
  verifySignature,
  webhookRouter,
} from "../src/index.js";
import { PLATFORM } from "../src/options.js";

const API_KEY = "test-key";
const BASE_PATH = "/en/transactional/api/v1";
const SEND_REPLY = { status: "success", job_id: "1ZymBc-00041N-9X", emails: ["user@example.com"], failed_emails: {} };
const WEBHOOK_BODY = {
  auth: "00000000000000000000000000000000",
  events_by_user: [
    {
      user_id: 1,
      project_id: "6432890213745872",
      events: [
        {
          event_name: "transactional_email_status",
          event_data: {
            job_id: "1a3Q2V-0000OZ-S0",
            email: "user@example.com",
            status: "delivered",
            event_time: "2015-11-30 15:09:42",
          },
        },
        {
          event_name: "transactional_spam_block",
          event_data: {
            block_time: "2015-11-30 15:09:42",
            block_type: "one_smtp",
            domain: "example.com",
            SMTP_blocks_count: 1,
            domain_status: "blocked",
          },
        },
      ],
    },
  ],
};
// WEBHOOK_BODY signed with API_KEY
const WEBHOOK = signBody(JSON.stringify(WEBHOOK_BODY), API_KEY);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Mock of the API on 127.0.0.1: records the calls ({path, platform, key, body}) and answers `api.reply` once
 * ({status, body}), otherwise success (the email/send reply for email/send).
 */
async function mockApi() {
  const api = { calls: [], reply: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const text = Buffer.concat(chunks).toString("utf8");
      const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) : url.pathname;
      api.calls.push({
        path,
        platform: url.searchParams.get("platform"),
        key: req.headers["x-api-key"],
        body: text ? JSON.parse(text) : {},
      });
      const success = path === "/email/send.json" ? SEND_REPLY : { status: "success" };
      const reply = api.reply ?? { status: 200, body: success };
      api.reply = null;
      res.writeHead(reply.status, { "Content-Type": "application/json", "Connection": "close" });
      res.end(JSON.stringify(reply.body));
    });
  });
  api.url = (await listen(server)) + BASE_PATH;
  server.unref(); // does not keep the test process alive
  api.close = () => close(server);
  return api;
}

/** No settings of the package from the environment of the machine (no real key, no real host). */
function clearEnv() {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("UNIONE_")) {
      delete process.env[name];
    }
  }
}

const api = await mockApi();

/** A test from a clean state: the environment cleared, no calls of the mock. */
function test(name, fn) {
  nodeTest(name, async () => {
    clearEnv();
    api.calls.length = 0;
    api.reply = null;
    await fn();
  });
}

/** Calls fn() with console.warn recorded, returns the warnings. */
async function warnings(fn) {
  const seen = [];
  const warn = console.warn;
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return seen;
}

function post(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

/** The platform of the requests: this package, then the SDK. */
function assertPlatform(call) {
  assert.ok(call.platform.startsWith(`${PLATFORM},node-sdk.`), call.platform);
  assert.strictEqual(PLATFORM, "express.1.3.0");
}

/** The test mail through `transporter`: one email/send with the fields of the mail. */
async function checkMail(transporter, api) {
  const info = await transporter.sendMail({
    from: { name: "Shop", address: "shop@example.com" },
    to: { name: "User", address: "user@example.com" },
    subject: "Test",
    text: "Hello",
    html: "<b>Hello</b>",
  });
  assert.strictEqual(info.messageId, "1ZymBc-00041N-9X");
  const sends = api.calls.filter((call) => call.path === "/email/send.json");
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].key, API_KEY);
  assertPlatform(sends[0]);
  assert.deepStrictEqual(sends[0].body.message, {
    recipients: [{ email: "user@example.com", substitutions: { to_name: "User" } }],
    subject: "Test",
    from_email: "shop@example.com",
    from_name: "Shop",
    body: { html: "<b>Hello</b>", plaintext: "Hello" },
  });
}

/** An API error of email/send: sendMail() fails with the ApiError of the SDK. */
async function checkMailError(transporter, api) {
  api.reply = { status: 400, body: { status: "error", message: "Unknown recipient", code: 204 } };
  const mail = { from: "shop@example.com", to: "user@example.com", subject: "Hi", text: "Hi" };
  await assert.rejects(transporter.sendMail(mail), (error) => {
    assert.strictEqual(error.name, "ApiError");
    assert.strictEqual(error.kind, "api");
    assert.strictEqual(error.errorCode, 204);
    assert.strictEqual(error.httpStatus, 400);
    assert.strictEqual(error.method, "email/send");
    assert.strictEqual(error.retryable, false);
    return true;
  });
}

/** The webhook endpoint at `url`: GET 200, signed POST 200 (the handlers get it), a wrong signature 401. */
async function checkWebhook(url, received) {
  assert.strictEqual((await fetch(url)).status, 200);
  assert.strictEqual((await post(url, WEBHOOK)).status, 200);
  assert.deepStrictEqual(received.map((item) => item.kind), ["notification", "event", "event"]);
  assert.strictEqual(received[1].event.eventName, "transactional_email_status");
  assert.strictEqual(received[1].event.eventData?.email, "user@example.com");
  assert.strictEqual((await post(url, WEBHOOK.replace("user@", "evil@"))).status, 401);
  assert.strictEqual((await post(url, "{}")).status, 401);
  assert.strictEqual(received.length, 3);
}

/** An Express app on 127.0.0.1 with `use(app)`; returns its URL and close(). */
async function serve(use) {
  const app = express();
  use(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => close(server) };
}

function transporter() {
  return nodemailer.createTransport(new UniOneTransport({ apiKey: API_KEY, host: api.url }));
}

test("createClient: API key and host from the environment", async () => {
  process.env.UNIONE_API_KEY = API_KEY;
  process.env.UNIONE_HOST = api.url;
  await createClient().system.ping();
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].path, "/system/ping.json");
  assert.strictEqual(api.calls[0].key, API_KEY);
  assertPlatform(api.calls[0]);
});

test("createClient without an API key fails", () => {
  assert.throws(() => createClient(), /API key is not set/);
});

test("resolveOptions: options over the environment, the webhook key falls back to the API key", () => {
  process.env.UNIONE_API_KEY = "env-key";
  process.env.UNIONE_TIMEOUT = "5";
  process.env.UNIONE_WEBHOOK_PATH = "/hooks";
  const options = resolveOptions({ apiKey: API_KEY });
  assert.strictEqual(options.apiKey, API_KEY);
  assert.strictEqual(options.webhookKey, API_KEY);
  assert.strictEqual(options.timeout, 5);
  assert.strictEqual(options.webhookPath, "/hooks");
  assert.strictEqual(resolveOptions().webhookKey, "env-key");
  process.env.UNIONE_WEBHOOK_KEY = "hook-key";
  assert.strictEqual(resolveOptions({ apiKey: API_KEY }).webhookKey, "hook-key");
  assert.strictEqual(resolveOptions({ webhookPath: "/own" }).webhookPath, "/own");
  delete process.env.UNIONE_WEBHOOK_PATH;
  assert.strictEqual(resolveOptions().webhookPath, "/unione/webhook");
});

test("clientMiddleware: the client in req.unione", async () => {
  const app = await serve((a) => {
    a.use(clientMiddleware({ apiKey: API_KEY, host: api.url }));
    a.get("/ping", async (req, res) => res.json(await req.unione.system.ping()));
  });
  try {
    const response = await fetch(app.url + "/ping");
    assert.strictEqual(response.status, 200);
    assert.strictEqual(api.calls[0].path, "/system/ping.json");
    assertPlatform(api.calls[0]);
  } finally {
    await app.close();
  }
});

test("Nodemailer transport: one email/send with the mail", async () => {
  await checkMail(transporter(), api);
});

test("Nodemailer transport: an API error fails the send", async () => {
  await checkMailError(transporter(), api);
});

test("Nodemailer: cc, bcc, reply-to, headers, attachments, tags and metadata", async () => {
  await transporter().sendMail({
    from: "shop@example.com",
    to: { name: "User", address: "user@example.com" },
    cc: "cc@example.com",
    bcc: "bcc@example.com",
    replyTo: { name: "Support", address: "support@example.com" },
    subject: "Report",
    text: "Hello",
    headers: { "X-Order": "42", "List-Unsubscribe": "<mailto:u@example.com>", "Received": "dropped" },
    attachments: [
      { filename: "a.txt", content: "abc", contentType: "text/plain" },
      { filename: "logo.png", content: Buffer.from("png"), contentType: "image/png", cid: "logo" },
    ],
    tags: ["orders"],
    metadata: { order_id: 42 },
  });
  const message = api.calls.find((call) => call.path === "/email/send.json").body.message;
  const emails = message.recipients.map((recipient) => recipient.email).sort();
  assert.deepStrictEqual(emails, ["bcc@example.com", "cc@example.com", "user@example.com"]);
  assert.strictEqual(message.reply_to, "support@example.com");
  assert.strictEqual(message.reply_to_name, "Support");
  assert.strictEqual(message.headers.To, '"User" <user@example.com>');
  assert.strictEqual(message.headers.CC, "cc@example.com");
  assert.strictEqual(message.headers["X-Order"], "42");
  assert.strictEqual(message.headers["List-Unsubscribe"], "<mailto:u@example.com>");
  assert.strictEqual(message.headers.Received, undefined);
  assert.deepStrictEqual(message.attachments, [{ type: "text/plain", name: "a.txt", content: "YWJj" }]);
  assert.deepStrictEqual(message.inline_attachments, [{ type: "image/png", name: "logo", content: "cG5n" }]);
  assert.deepStrictEqual(message.tags, ["orders"]);
  assert.deepStrictEqual(message.global_metadata, { order_id: "42" });
});

test("webhookRouter: GET, signed POST, wrong signature", async () => {
  const received = [];
  const app = await serve((a) => {
    a.use(webhookRouter({
      apiKey: API_KEY,
      onNotification: (callback) => { received.push({ kind: "notification", callback }); },
      onEvent: (event, user) => { received.push({ kind: "event", event, user }); },
    }));
    a.use(express.json());
  });
  try {
    await checkWebhook(app.url + "/unione/webhook", received);
  } finally {
    await app.close();
  }
});

test("webhookRouter: path and key from the environment", async () => {
  process.env.UNIONE_WEBHOOK_KEY = API_KEY;
  process.env.UNIONE_WEBHOOK_PATH = "/hooks/mail";
  const app = await serve((a) => a.use(webhookRouter()));
  try {
    assert.strictEqual((await post(app.url + "/hooks/mail", WEBHOOK)).status, 200);
    assert.strictEqual((await post(app.url + "/unione/webhook", WEBHOOK)).status, 404);
  } finally {
    await app.close();
  }
});

test("webhookRouter without a key: a warning, every POST 401", async () => {
  let app;
  const warned = await warnings(async () => {
    app = await serve((a) => a.use(webhookRouter()));
  });
  try {
    assert.ok(warned.some((text) => text.includes("webhook key is not set")), warned.join("\n"));
    assert.strictEqual((await post(app.url + "/unione/webhook", WEBHOOK)).status, 401);
  } finally {
    await app.close();
  }
});

test("verifySignature", () => {
  assert.strictEqual(verifySignature(WEBHOOK, API_KEY), true);
  assert.strictEqual(verifySignature(Buffer.from(WEBHOOK), API_KEY), true);
  assert.strictEqual(verifySignature(WEBHOOK, "other-key"), false);
  assert.strictEqual(verifySignature(WEBHOOK, ""), false);
  assert.strictEqual(verifySignature("{}", API_KEY), false);
});
