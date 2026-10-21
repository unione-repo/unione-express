import { createClient } from "./options.js";

const PASSED_HEADERS = ["list-unsubscribe", "list-subscribe", "list-help", "list-owner", "list-archive", "in-reply-to", "references"];

/**
 * Nodemailer transport that sends through email/send of the API; the job_id of the API is the messageId.
 *
 *     const transporter = nodemailer.createTransport(new UniOneTransport({ apiKey: "YOUR_API_KEY" }));
 *
 * Recipients are to, cc and bcc (the display name goes to the "to_name" substitution); with cc the "To" and "CC"
 * headers are set. Attachments with a cid become inline_attachments named by the cid. Headers X-*, List-*,
 * In-Reply-To and References are passed. `mail.data.tags` and `mail.data.metadata` go to tags / global_metadata.
 */
export class UniOneTransport {
  /**
   * @param {import("./options.js").UniOneOptions & {client?: {apiClient: {call: Function}}}} [options]
   *   client: an SDK client to reuse, otherwise one is created from the options / environment
   */
  constructor(options = {}) {
    this.name = "UniOne";
    this.version = "1.2.3";
    this.client = options.client ?? createClient(options);
  }

  /**
   * @param {object} mail Nodemailer MailMessage
   * @param {(err: Error|null, info?: object) => void} callback
   */
  send(mail, callback) {
    mail.normalize((error, data) => {
      if (error) {
        callback(error);
        return;
      }
      let message;
      try {
        message = toMessage(data, mail.message.getEnvelope());
      } catch (e) {
        callback(e);
        return;
      }
      this.client.apiClient.call("/email/send.json", { message }).then(
        (response) => callback(null, {
          messageId: response.job_id,
          envelope: mail.message.getEnvelope(),
          accepted: response.emails ?? [],
          rejected: Object.keys(response.failed_emails ?? {}),
          response,
        }),
        callback,
      );
    });
  }
}

/** @returns {{name: string, address: string}[]} */
function addresses(value) {
  if (!value) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).flatMap((item) => (typeof item === "string"
    ? [{ name: "", address: item }]
    : item.group ? addresses(item.group) : [{ name: item.name ?? "", address: item.address }]));
}

function format(list) {
  return list.map((a) => (a.name ? `"${a.name.replace(/"/g, "'")}" <${a.address}>` : a.address)).join(", ");
}

function text(value) {
  if (value === undefined || value === null || value === false) {
    return undefined;
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function base64(attachment) {
  const { content, encoding } = attachment;
  if (Buffer.isBuffer(content)) {
    return content.toString("base64");
  }
  if (encoding === "base64") {
    return String(content).replace(/\s+/g, "");
  }
  return Buffer.from(String(content ?? ""), encoding || "utf8").toString("base64");
}

/**
 * Normalized Nodemailer data -> "message" of email/send.
 * @param {object} data result of mail.normalize()
 * @param {{from: string, to: string[]}} [envelope]
 */
export function toMessage(data, envelope) {
  const from = addresses(data.from)[0];
  if (!from) {
    throw new Error("The message has no sender (from).");
  }
  const named = [...addresses(data.to), ...addresses(data.cc), ...addresses(data.bcc)];
  const names = new Map(named.map((a) => [a.address.toLowerCase(), a.name]));
  const emails = envelope?.to?.length ? envelope.to : named.map((a) => a.address);
  const message = {
    recipients: emails.map((email) => {
      const name = names.get(email.toLowerCase());
      return name ? { email, substitutions: { to_name: name } } : { email };
    }),
    subject: text(data.subject) ?? "",
    from_email: from.address,
  };
  if (from.name) {
    message.from_name = from.name;
  }
  const replyTo = addresses(data.replyTo)[0];
  if (replyTo) {
    message.reply_to = replyTo.address;
    if (replyTo.name) {
      message.reply_to_name = replyTo.name;
    }
  }
  const body = {};
  if (text(data.html) !== undefined) {
    body.html = text(data.html);
  }
  if (text(data.text) !== undefined) {
    body.plaintext = text(data.text);
  }
  if (Object.keys(body).length) {
    message.body = body;
  }

  const headers = {};
  const cc = addresses(data.cc);
  if (cc.length) {
    headers.To = format(addresses(data.to));
    headers.CC = format(cc);
  }
  const raw = data.headers ?? {};
  const entries = Array.isArray(raw) ? raw.map((h) => [h.key, h.value]) : Object.entries(raw);
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-") || PASSED_HEADERS.includes(lower)) {
      const first = Array.isArray(value) ? value[0] : value;
      headers[name] = String(first && typeof first === "object" ? first.value : first);
    }
  }
  if (Object.keys(headers).length) {
    message.headers = headers;
  }
  if (Array.isArray(data.tags) && data.tags.length) {
    message.tags = data.tags.map(String);
  }
  if (data.metadata && typeof data.metadata === "object") {
    message.global_metadata = Object.fromEntries(Object.entries(data.metadata).map(([k, v]) => [k, String(v)]));
  }

  for (const attachment of data.attachments ?? []) {
    const inline = Boolean(attachment.cid);
    const item = {
      type: attachment.contentType || "application/octet-stream",
      name: inline ? attachment.cid : (attachment.filename || "attachment"),
      content: base64(attachment),
    };
    (message[inline ? "inline_attachments" : "attachments"] ??= []).push(item);
  }
  return message;
}
