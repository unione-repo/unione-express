import type { RequestHandler, Router } from "express";
import type { UniOneClient } from "unione";

export interface UniOneOptions {
  /** User or project API key, default: env UNIONE_API_KEY. */
  apiKey?: string;
  /** API host (datacenter) or a full base URL, default: env UNIONE_HOST. */
  host?: string;
  /** Request timeout in seconds, default: env UNIONE_TIMEOUT or 30. */
  timeout?: number;
  /** API key the webhooks are signed with, default: env UNIONE_WEBHOOK_KEY or apiKey. */
  webhookKey?: string;
  /** Path of the webhook endpoint, default: env UNIONE_WEBHOOK_PATH or "/unione/webhook". */
  webhookPath?: string;
}

export interface WebhookHandlers {
  /** The whole notification: parsed SDK model and decoded JSON. */
  onNotification?: (callback: any, payload: Record<string, any>, context?: any) => unknown;
  /** Each event of the notification with its user/project. */
  onEvent?: (event: any, user: any, context?: any) => unknown;
}

export function resolveOptions(options?: UniOneOptions): Required<UniOneOptions>;
export function createClient(options?: UniOneOptions): UniOneClient;
export function clientMiddleware(options?: UniOneOptions & { client?: UniOneClient }): RequestHandler;
export function webhookRouter(options?: UniOneOptions & WebhookHandlers & { path?: string; limit?: string }): Router;
export function verifySignature(body: string | Buffer, apiKey: string): boolean;
export function signBody(body: string, apiKey: string): string;
export function handleWebhook(body: string | Buffer, key: string, handlers?: WebhookHandlers, context?: any): Promise<{ status: number; text: string }>;
export function toMessage(data: Record<string, any>, envelope?: { from: string; to: string[] }): Record<string, any>;

/** Nodemailer transport: nodemailer.createTransport(new UniOneTransport({ apiKey })). */
export class UniOneTransport {
  constructor(options?: UniOneOptions & { client?: UniOneClient });
  name: string;
  version: string;
  client: UniOneClient;
  send(mail: any, callback: (err: Error | null, info?: any) => void): void;
}

declare global {
  namespace Express {
    interface Request {
      unione?: UniOneClient;
    }
  }
}
