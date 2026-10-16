import express from "express";
import { createClient, resolveOptions } from "./options.js";
import { handleWebhook } from "./webhook.js";

/**
 * Puts the UniOne API client to `req.unione` (one client for all requests).
 * @param {import("./options.js").UniOneOptions & {client?: object}} [options]
 * @returns {import("express").RequestHandler}
 */
export function clientMiddleware(options = {}) {
  const client = options.client ?? createClient(options);
  return (req, res, next) => {
    req.unione = client;
    next();
  };
}

/**
 * Router of the webhook endpoint: GET/HEAD -> 200 (URL check of webhook/set), POST -> signature check, then
 * onNotification(callback, payload, req) and onEvent(event, user, req) for each event; wrong signature -> 401.
 * Mount it before express.json(): the signature is computed over the raw body.
 * @param {import("./options.js").UniOneOptions & import("./webhook.js").WebhookHandlers & {path?: string, limit?: string}} [options]
 * @returns {import("express").Router}
 */
export function webhookRouter(options = {}) {
  const settings = resolveOptions(options);
  const path = options.path ?? settings.webhookPath;
  const router = express.Router();
  router.get(path, (req, res) => {
    res.status(200).type("text/plain").send("OK");
  });
  router.post(path, express.raw({ type: () => true, limit: options.limit ?? "10mb" }), async (req, res, next) => {
    try {
      const body = Buffer.isBuffer(req.body) || typeof req.body === "string" ? req.body : req.rawBody;
      const { status, text } = await handleWebhook(body, settings.webhookKey, options, req);
      res.status(status).type("text/plain").send(text);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
