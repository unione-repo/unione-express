import { createHash, timingSafeEqual } from "node:crypto";
import { WebhookApi } from "unione/api/webhook";

const AUTH = /"auth"\s*:\s*"([0-9a-fA-F]{32})"/;
const PLACEHOLDER = "00000000000000000000000000000000";

function md5(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

/**
 * Checks the signature of a webhook notification: the "auth" field is the MD5 of the request body in which the
 * "auth" value is replaced by the API key of the user/project of the webhook.
 * @param {string|Buffer} body raw request body
 * @param {string} apiKey
 */
export function verifySignature(body, apiKey) {
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? "");
  const match = apiKey ? AUTH.exec(raw) : null;
  if (!match) {
    return false;
  }
  const expected = Buffer.from(md5(raw.split(match[1]).join(apiKey)));
  const actual = Buffer.from(match[1].toLowerCase());
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Signs a body whose "auth" is a placeholder of 32 zeros (tests, local development).
 * @param {string} body
 * @param {string} apiKey
 */
export function signBody(body, apiKey) {
  return body.split(PLACEHOLDER).join(md5(body.split(PLACEHOLDER).join(apiKey)));
}

/**
 * @typedef {object} WebhookHandlers
 * @property {(callback: object, payload: object, context?: any) => any} [onNotification] the whole notification
 *   (the parsed SDK model and the decoded JSON)
 * @property {(event: object, user: object, context?: any) => any} [onEvent] each event (eventName, eventData)
 *   with its user/project
 */

/**
 * Handles a POST of the webhook: checks the signature, parses the body and calls the handlers (awaited).
 * The API waits 3 seconds for 200 OK, so the handlers should be fast (queue the work).
 * @param {string|Buffer} body raw request body
 * @param {string} key API key the webhooks are signed with
 * @param {WebhookHandlers} handlers
 * @param {any} [context] passed to the handlers (e.g. the request)
 * @returns {Promise<{status: number, text: string}>}
 */
export async function handleWebhook(body, key, handlers = {}, context = undefined) {
  if (body === undefined || body === null || (typeof body === "object" && !Buffer.isBuffer(body))) {
    return { status: 400, text: "Raw request body is not available" };
  }
  if (!verifySignature(body, key)) {
    return { status: 401, text: "Invalid signature" };
  }
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  let callback;
  let payload;
  try {
    callback = WebhookApi.parseCallback(raw);
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, text: "Invalid body" };
  }
  await handlers.onNotification?.(callback, payload, context);
  for (const user of callback.eventsByUser ?? []) {
    for (const event of user.events ?? []) {
      await handlers.onEvent?.(event, user, context);
    }
  }
  return { status: 200, text: "OK" };
}
