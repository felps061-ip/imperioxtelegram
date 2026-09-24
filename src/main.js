import { isValidCpf, maskCpf, normalizeCpf } from "./cpf.js";
import fs from "node:fs/promises";
import path from "node:path";
import { parseIncomingText } from "./commands.js";
import { loadConfig } from "./config.js";
import { QueueFullError } from "./errors.js";
import { InMemoryJobQueue } from "./job-queue.js";
import { getLocalApplicationDirectory, loadLocalEnvironment } from "./local-environment.js";
import { createLogger } from "./logger.js";
import { PromobankWorker } from "./promobank-worker.js";
import { WhatsAppClient } from "./whatsapp-client.js";

function publicFailureMessage(code) {
  if (["LOGIN_REQUIRED", "LOGIN_FAILED", "LOGIN_PAGE_UNAVAILABLE"].includes(code)) {
    return "A sessao do Promobank precisa do login manual da TI no Chrome dedicado.";
  }
  if (code === "QUERY_TIMEOUT") return "O Promobank nao disponibilizou a impressao no prazo.";
  return "Nao foi possivel concluir a consulta. A TI verificara o erro.";
}

async function run() {
  loadLocalEnvironment();
  const config = loadConfig();
  const logDirectory = path.join(getLocalApplicationDirectory(), "logs");
  await fs.mkdir(logDirectory, { recursive: true });
  const logFile = path.join(logDirectory, "bot-" + new Date().toISOString().slice(0, 10) + ".log");
  const logger = createLogger({ level: config.logLevel, filePath: logFile });
  const worker = new PromobankWorker({ config: config.promobank, logger });
  const whatsapp = new WhatsAppClient({ config: config.whatsapp, logger });

  const queue = new InMemoryJobQueue({
    logger,
    maxPending: config.queue.maxPending,
    handler: async (job) => {
      const contactRequest = job.requestType === "contacts";
      const protocolMessage = await whatsapp.sendPrivateText(
        job.sourceMessage,
        contactRequest
          ? `Protocolo ${job.protocol}: iniciando a consulta de contatos de ${job.cpfMasked}.`
          : `Protocolo ${job.protocol}: iniciando a consulta de ${job.cpfMasked}.`,
      );

      try {
        if (contactRequest) {
          const phones = await worker.fetchContactPhones(job.cpf, job.protocol);
          const resultText = phones.length > 0
            ? `Protocolo ${job.protocol} - telefones encontrados para ${job.cpfMasked}:\n${phones.join("\n")}`
            : `Protocolo ${job.protocol}: nenhum telefone encontrado para ${job.cpfMasked}.`;
          const resultMessage = await whatsapp.sendPrivateText(job.sourceMessage, resultText);
          const [protocolDelivery, resultDelivery] = await Promise.allSettled([
            protocolMessage.delivery,
            resultMessage.delivery,
          ]);
          logger.info("Entrega da consulta de contatos processada.", {
            protocol: job.protocol,
            protocolDelivered: protocolDelivery.status === "fulfilled",
            resultDelivered: resultDelivery.status === "fulfilled",
            phonesFound: phones.length,
          });
          return;
        }

        const pdfs = await worker.fetchInssPdfs(job.cpf, job.protocol, config.promobank.downloadDirectory);
        for (const pdf of pdfs) {
          const savedPdf = await fs.stat(pdf.filePath);
          if (!savedPdf.isFile() || savedPdf.size !== pdf.bytes.byteLength) {
            throw new Error("Um PDF salvo nao corresponde ao arquivo preparado para envio.");
          }
        }
        logger.info("PDFs confirmados no disco antes do envio.", {
          protocol: job.protocol,
          count: pdfs.length,
        });

        const privatePdfs = [];
        for (let index = 0; index < pdfs.length; index += 1) {
          const pdf = pdfs[index];
          const enrollment = pdf.enrollment ? ` - ${pdf.enrollment}` : "";
          privatePdfs.push(await whatsapp.sendPrivatePdfFile(job.sourceMessage, pdf.filePath, {
            filename: path.basename(pdf.filePath),
            caption: `Extrato INSS ${index + 1}/${pdfs.length} - protocolo ${job.protocol} - ${job.cpfMasked}${enrollment}`,
          }));
        }

        const [protocolDelivery, ...pdfDeliveries] = await Promise.allSettled([
          protocolMessage.delivery,
          ...privatePdfs.map((privatePdf) => privatePdf.delivery),
        ]);

        if (protocolDelivery.status === "fulfilled") {
          logger.info("Mensagem de protocolo entregue.", { protocol: job.protocol });
        } else {
          logger.warn("Mensagem de protocolo nao foi entregue.", {
            protocol: job.protocol,
            error: protocolDelivery.reason,
          });
        }

        for (let index = 0; index < pdfDeliveries.length; index += 1) {
          const delivery = pdfDeliveries[index];
          const pdf = pdfs[index];
          if (delivery.status === "fulfilled") {
            await fs.unlink(pdf.filePath);
            logger.info("PDF temporario removido apos entrega confirmada.", {
              protocol: job.protocol,
              document: index + 1,
              total: pdfs.length,
            });
          } else {
            logger.warn("PDF mantido no cache porque a entrega nao foi confirmada.", {
              protocol: job.protocol,
              document: index + 1,
              total: pdfs.length,
              error: delivery.reason,
              filePath: pdf.filePath,
            });
          }
        }
      } catch (error) {
        await whatsapp.sendPrivateText(
          job.sourceMessage,
          `Protocolo ${job.protocol}: ${publicFailureMessage(error?.code)}`,
        ).catch(() => {});
        throw error;
      }
    },
  });

  await worker.prepareForManualLogin();

  const shutdown = async (signal) => {
    logger.info("Encerramento solicitado.", { signal });
    queue.stopAccepting();
    await Promise.allSettled([queue.waitForIdle(), whatsapp.stop(), worker.stop()]);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await whatsapp.run(async ({ message }) => {
    const text = message.body?.trim();
    const request = parseIncomingText(text);
    if (!["inss", "contacts"].includes(request.type)) return false;

    const cpf = normalizeCpf(request.cpf);
    if (!isValidCpf(cpf)) {
      await whatsapp.sendPrivateText(message, "CPF invalido. Confira os numeros e envie novamente no grupo.");
      return true;
    }

    try {
      const requesterId = message.author || message.from;
      const { job, duplicate } = queue.enqueue({
        requesterId,
        chatId: requesterId,
        cpf,
        requestType: request.type,
        sourceMessage: message,
      });
      if (duplicate) {
        await whatsapp.sendPrivateText(message, `Essa consulta ja esta em andamento. Protocolo ${job.protocol}.`);
        return true;
      }
      await whatsapp.sendPrivateText(
        message,
        `Solicitacao recebida para ${maskCpf(cpf)}. Protocolo ${job.protocol}. Posicao na fila: ${job.position}.`,
      );
    } catch (error) {
      if (error instanceof QueueFullError) {
        await whatsapp.sendPrivateText(message, "A fila esta cheia. Tente novamente em alguns minutos.");
        return true;
      }
      throw error;
    }
    return true;
  });
}

run().catch((error) => {
  const logger = createLogger({ level: process.env.LOG_LEVEL || "info" });
  logger.error("Falha fatal ao iniciar.", { error });
  process.exitCode = 1;
});
