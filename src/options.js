import { UniOneClient } from "unione";

/** The package and its version in the "platform" query parameter of the requests, before the SDK one. */
export const PLATFORM = "express.1.1.3";

/**
 * @typedef {object} UniOneOptions
 * @property {string} [apiKey] User or project API key, default: env UNIONE_API_KEY.
 * @property {string} [host] API host (datacenter) or a full base URL, default: env UNIONE_HOST or https://api.unione.io/en/transactional/api/v1.
 * @property {number} [timeout] Request timeout in seconds, default: env UNIONE_TIMEOUT or 30.
 * @property {string} [webhookKey] API key the webhooks are signed with, default: env UNIONE_WEBHOOK_KEY or apiKey.
 * @property {string} [webhookPath] Path of the webhook endpoint, default: env UNIONE_WEBHOOK_PATH or "/unione/webhook".
 */

/**
 * Settings with the defaults from the environment.
 * @param {UniOneOptions} [options]
 * @returns {Required<UniOneOptions>}
 */
export function resolveOptions(options = {}) {
  const env = typeof process !== "undefined" ? process.env : {};
  const apiKey = options.apiKey ?? env.UNIONE_API_KEY ?? "";
  return {
    apiKey,
    host: options.host ?? env.UNIONE_HOST ?? "",
    timeout: Number(options.timeout ?? env.UNIONE_TIMEOUT ?? 30),
    webhookKey: options.webhookKey || env.UNIONE_WEBHOOK_KEY || apiKey,
    webhookPath: options.webhookPath ?? env.UNIONE_WEBHOOK_PATH ?? "/unione/webhook",
  };
}

/**
 * UniOne API client from the options / environment.
 * @param {UniOneOptions} [options]
 * @returns {UniOneClient}
 */
export function createClient(options = {}) {
  const { apiKey, host, timeout } = resolveOptions(options);
  if (!apiKey) {
    throw new Error("UniOne: the API key is not set (apiKey option or UNIONE_API_KEY).");
  }
  return new UniOneClient(apiKey, { ...(host ? { host } : {}), timeout: timeout * 1000, platform: PLATFORM });
}
