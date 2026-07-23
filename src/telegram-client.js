import { AppError } from "./errors.js";

export class TelegramApiError extends AppError {
  constructor(description, status) {
    super("TELEGRAM_API_ERROR", `Telegram respondeu com erro${status ? ` (${status})` : ""}: ${description}`);
    this.status = status;
  }
}

export class TelegramClient {
  #token;
  #fetch;
  #logger;
  #pollTimeoutSeconds;

  constructor({ token, logger, pollTimeoutSeconds = 25, fetchImpl = globalThis.fetch }) {
    this.#token = token;
    this.#logger = logger;
    this.#pollTimeoutSeconds = pollTimeoutSeconds;
    this.#fetch = fetchImpl;
  }

  async getMe() {
    return this.#requestJson("getMe", {});
  }

  async deleteWebhook() {
    return this.#requestJson("deleteWebhook", { drop_pending_updates: false });
  }

  async sendMessage(chatId, text, options = {}) {
    return this.#requestJson("sendMessage", {
      chat_id: String(chatId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...options,
    });
  }

  async sendDocument(chatId, bytes, { filename, caption, protectContent = false } = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([bytes], { type: "application/pdf" }), filename || "extrato-inss.pdf");
    if (caption) {
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
    }
    form.append("protect_content", String(protectContent));

    return this.#request("sendDocument", {
      method: "POST",
      body: form,
      timeoutMs: 90_000,
    });
  }

  async run(handler, { signal }) {
    await this.deleteWebhook();
    let offset = 0;

    while (!signal.aborted) {
      try {
        const updates = await this.#requestJson(
          "getUpdates",
          {
            offset,
            timeout: this.#pollTimeoutSeconds,
            allowed_updates: ["message"],
          },
          { timeoutMs: (this.#pollTimeoutSeconds + 10) * 1000, signal },
        );

        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handler(update);
          } catch (error) {
            this.#logger.error("Falha ao tratar atualizacao do Telegram.", { error });
          }
        }
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") {
          break;
        }

        this.#logger.warn("Falha temporaria no long polling do Telegram; nova tentativa em 2 segundos.", { error });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async #requestJson(method, payload, { timeoutMs = 30_000, signal } = {}) {
    return this.#request(method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs,
      signal,
    });
  }

  async #request(method, { timeoutMs, signal, ...options }) {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) {
      signals.push(signal);
    }

    const response = await this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
      ...options,
      signal: AbortSignal.any(signals),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new TelegramApiError("resposta invalida", response.status);
    }

    if (!response.ok || !data.ok) {
      throw new TelegramApiError(data.description || "erro desconhecido", response.status);
    }

    return data.result;
  }
}
