import { setTimeout as delay } from "node:timers/promises";
import { isValidCpf, maskCpf, normalizeCpf } from "./cpf.js";
import { parseIncomingText } from "./commands.js";
import { loadConfig } from "./config.js";
import { QueueFullError } from "./errors.js";
import { InMemoryJobQueue } from "./job-queue.js";
import { loadLocalEnvironment } from "./local-environment.js";
import { createLogger } from "./logger.js";
import { PromobankWorker } from "./promobank-worker.js";
import { TelegramClient } from "./telegram-client.js";

const STATUS_LABELS = Object.freeze({
  queued: "aguardando na fila",
  processing: "em processamento",
  completed: "concluido",
  failed: "falhou",
});

function helpText(userId, authorized) {
  if (!authorized) {
    return [
      "Este bot e restrito a vendedores autorizados.",
      `Seu ID do Telegram e <code>${userId}</code>.`,
      "Envie esse ID ao administrador para solicitar acesso.",
    ].join("\n");
  }

  return [
    "<b>Extrato INSS</b>",
    "Envie somente o CPF, com ou sem pontuacao, ou use:",
    "<code>/inss 123.456.789-00</code>",
    "",
    "Para consultar um protocolo:",
    "<code>/status PROTOCOLO</code>",
    "",
    "Por seguranca, use somente esta conversa privada.",
  ].join("\n");
}

function publicFailureMessage(code) {
  switch (code) {
    case "REMOTE_SESSION_CONFLICT":
      return "O login do Promobank esta ativo em outro computador. Um operador precisa verificar a sessao.";
    case "LOGIN_REQUIRED":
    case "LOGIN_FAILED":
    case "LOGIN_PAGE_UNAVAILABLE":
      return "A sessao do Promobank precisa de intervencao do operador.";
    case "QUERY_TIMEOUT":
      return "O Promobank nao disponibilizou a impressao dentro do prazo. Tente novamente mais tarde.";
    case "INVALID_PDF":
    case "PDF_HTTP_ERROR":
    case "PDF_DOWNLOAD_FAILED":
    case "PDF_POPUP_FAILED":
      return "O Promobank respondeu, mas nao foi possivel obter um PDF valido.";
    default:
      return "Nao foi possivel concluir a consulta. O erro foi registrado para verificacao.";
  }
}

async function run() {
  loadLocalEnvironment();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const abortController = new AbortController();
  const telegram = new TelegramClient({
    token: config.telegram.token,
    logger,
    pollTimeoutSeconds: config.telegram.pollTimeoutSeconds,
  });
  const worker = new PromobankWorker({ config: config.promobank, logger });

  const queue = new InMemoryJobQueue({
    logger,
    maxPending: config.queue.maxPending,
    handler: async (job) => {
      await telegram.sendMessage(
        job.chatId,
        `Protocolo <code>${job.protocol}</code>: iniciando consulta de ${job.cpfMasked}.`,
      );

      try {
        const pdf = await worker.fetchInssPdf(job.cpf, job.protocol);
        await telegram.sendDocument(job.chatId, pdf, {
          filename: `extrato-inss-${job.protocol}.pdf`,
          caption: `Extrato INSS — protocolo <code>${job.protocol}</code> — ${job.cpfMasked}`,
          protectContent: config.telegram.protectContent,
        });
      } catch (error) {
        await telegram
          .sendMessage(
            job.chatId,
            `Protocolo <code>${job.protocol}</code>: ${publicFailureMessage(error?.code)}`,
          )
          .catch((notificationError) => {
            logger.warn("Nao foi possivel avisar o solicitante sobre a falha.", {
              protocol: job.protocol,
              error: notificationError,
            });
          });
        throw error;
      }
    },
  });

  const handleUpdate = async (update) => {
    const message = update.message;
    if (!message?.from || typeof message.text !== "string") {
      return;
    }

    const userId = String(message.from.id);
    const chatId = String(message.chat.id);
    const command = parseIncomingText(message.text);

    if (message.chat.type !== "private") {
      if (["inss", "invalid_inss"].includes(command.type)) {
        await telegram.sendMessage(chatId, "Por seguranca, envie o CPF em uma conversa privada com o bot.");
      }
      return;
    }

    const authorized = config.telegram.allowedUserIds.has(userId);
    if (command.type === "my_id" || command.type === "help") {
      await telegram.sendMessage(chatId, helpText(userId, authorized));
      return;
    }

    if (!authorized) {
      await telegram.sendMessage(chatId, helpText(userId, false));
      return;
    }

    if (command.type === "invalid_inss") {
      await telegram.sendMessage(chatId, "Informe o CPF depois do comando. Exemplo: <code>/inss 123.456.789-00</code>.");
      return;
    }

    if (command.type === "invalid_status") {
      await telegram.sendMessage(chatId, "Informe o protocolo. Exemplo: <code>/status ABCD1234</code>.");
      return;
    }

    if (command.type === "status") {
      const job = queue.getForRequester(command.protocol, userId);
      if (!job) {
        await telegram.sendMessage(chatId, "Protocolo nao encontrado para o seu usuario.");
        return;
      }

      const position = job.position ? ` Posicao atual: ${job.position}.` : "";
      await telegram.sendMessage(
        chatId,
        `Protocolo <code>${job.protocol}</code>: ${STATUS_LABELS[job.status] || job.status}.${position}`,
      );
      return;
    }

    if (command.type !== "inss") {
      await telegram.sendMessage(chatId, helpText(userId, true));
      return;
    }

    const cpf = normalizeCpf(command.cpf);
    if (!isValidCpf(cpf)) {
      await telegram.sendMessage(chatId, "CPF invalido. Confira os 11 digitos e tente novamente.");
      return;
    }

    try {
      const { job, duplicate } = queue.enqueue({ requesterId: userId, chatId, cpf });
      if (duplicate) {
        await telegram.sendMessage(
          chatId,
          `Essa consulta ja esta ${STATUS_LABELS[job.status]}. Protocolo <code>${job.protocol}</code>.`,
        );
        return;
      }

      await telegram.sendMessage(
        chatId,
        `Solicitacao recebida para ${maskCpf(cpf)}. Protocolo <code>${job.protocol}</code>. Posicao: ${job.position}.`,
      );
    } catch (error) {
      if (error instanceof QueueFullError) {
        await telegram.sendMessage(chatId, "A fila esta cheia no momento. Tente novamente em alguns minutos.");
        return;
      }
      throw error;
    }
  };

  const bot = await telegram.getMe();
  logger.info("Bot Telegram conectado.", { botId: bot.id, botUsername: bot.username });

  const requestShutdown = (signalName) => {
    logger.info("Encerramento solicitado.", { signal: signalName });
    queue.stopAccepting();
    abortController.abort();
  };
  process.once("SIGINT", () => requestShutdown("SIGINT"));
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));

  try {
    await telegram.run(handleUpdate, { signal: abortController.signal });
  } finally {
    queue.stopAccepting();
    await Promise.race([queue.waitForIdle(), delay(30_000)]);
    await worker.stop();
    logger.info("MVP encerrado.");
  }
}

run().catch((error) => {
  const logger = createLogger({ level: process.env.LOG_LEVEL || "info" });
  logger.error("Falha fatal ao iniciar o MVP.", { error });
  process.exitCode = 1;
});
