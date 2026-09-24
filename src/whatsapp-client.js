import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "node:fs/promises";
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

function messageText(message) {
  let content = message?.message;
  if (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
  if (content?.viewOnceMessage?.message) content = content.viewOnceMessage.message;
  if (content?.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
  return content?.conversation || content?.extendedTextMessage?.text || "";
}

function disconnectCode(error) {
  return error?.output?.statusCode || error?.data?.statusCode || error?.statusCode;
}

function messageTimestampSeconds(message) {
  const value = message?.messageTimestamp;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolvePrivateRecipientJid({ key, socketUserId, participantPhoneJids = new Map() }) {
  const participant = key?.participant ? jidNormalizedUser(key.participant) : undefined;
  const candidates = [
    key?.participantPn,
    key?.senderPn,
    participant ? participantPhoneJids.get(participant) : undefined,
    participant && !participant.endsWith("@lid") ? participant : undefined,
    key?.fromMe ? socketUserId : undefined,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = jidNormalizedUser(candidate);
    if (normalized.endsWith("@s.whatsapp.net")) return normalized;
  }

  return undefined;
}

export class WhatsAppClient {
  #socket;
  #groupName;
  #groupId;
  #sessionDirectory;
  #logger;
  #handler;
  #stopping = false;
  #processed = new Set();
  #startedAtSeconds = Math.floor(Date.now() / 1_000);
  #participantPhoneJids = new Map();
  #participantRefreshPromise;
  #validatedRecipients = new Map();
  #deliveryStatuses = new Map();
  #deliveryWaiters = new Map();

  constructor({ config, logger }) {
    this.#groupName = config.groupName;
    this.#sessionDirectory = config.sessionDirectory;
    this.#logger = logger;
  }

  async run(handler) {
    this.#handler = handler;
    await this.#connect(true);
  }

  async #connect(waitUntilReady = false) {
    const { state, saveCreds } = await useMultiFileAuthState(this.#sessionDirectory);
    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["Promobank", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.#socket = socket;

    let settleReady;
    let settleFailure;
    const ready = new Promise((resolve, reject) => {
      settleReady = resolve;
      settleFailure = reject;
    });

    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates) {
        if (!key?.id || typeof update?.status !== "number") continue;
        this.#recordDeliveryStatus(key.id, update.status);
      }
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (socket !== this.#socket) return;
      this.#logger.info("Evento de mensagem recebido do WhatsApp.", {
        type,
        count: messages.length,
        groupReady: Boolean(this.#groupId),
      });
      if (!this.#groupId || !["notify", "append"].includes(type)) return;
      for (const message of messages) void this.#handleMessage(message);
    });
    socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.#logger.info("Leia o novo QR code no WhatsApp: Aparelhos conectados > Conectar aparelho.");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        try {
          const groups = await socket.groupFetchAllParticipating();
          const matches = Object.values(groups).filter((group) => group.subject?.trim() === this.#groupName);
          if (matches.length !== 1) {
            throw new Error(
              matches.length === 0
                ? `O grupo ${this.#groupName} nao foi encontrado.`
                : `Ha mais de um grupo chamado ${this.#groupName}. Renomeie o grupo de teste para um nome unico.`,
            );
          }
          this.#groupId = matches[0].id;
          this.#indexParticipants(matches[0].participants);
          this.#logger.info("WhatsApp pronto e grupo confirmado.", {
            group: this.#groupName,
            participantsWithPrivateJid: this.#participantPhoneJids.size,
          });
          settleReady();
        } catch (error) {
          this.#logger.error("Nao foi possivel confirmar o grupo do WhatsApp.", { error });
          settleFailure(error);
          socket.end(error);
        }
      }

      if (connection === "close" && !this.#stopping) {
        const code = disconnectCode(lastDisconnect?.error);
        if (code === DisconnectReason.loggedOut) {
          const error = new Error("A sessao do WhatsApp foi desconectada pelo celular. Exclua a sessao local e leia um novo QR code.");
          this.#logger.error(error.message);
          settleFailure(error);
          return;
        }
        this.#logger.warn("WhatsApp desconectado; reconectando.", { code });
        setTimeout(() => void this.#connect(false).catch((error) => this.#logger.error("Falha ao reconectar o WhatsApp.", { error })), 2_000);
      }
    });

    if (waitUntilReady) await ready;
  }

  async #handleMessage(message) {
    const messageId = message?.key?.id;
    if (!messageId || this.#processed.has(messageId)) return;
    this.#processed.add(messageId);
    if (this.#processed.size > 1_000) this.#processed.delete(this.#processed.values().next().value);

    const messageTimestamp = messageTimestampSeconds(message);
    if (messageTimestamp && messageTimestamp < this.#startedAtSeconds - 10) return;

    if (message.key.remoteJid !== this.#groupId) {
      this.#logger.info("Mensagem ignorada por nao pertencer ao grupo configurado.", {
        messageId,
        fromGroup: Boolean(message.key.remoteJid?.endsWith("@g.us")),
      });
      return;
    }
    let author = resolvePrivateRecipientJid({
      key: message.key,
      socketUserId: this.#socket?.user?.id,
      participantPhoneJids: this.#participantPhoneJids,
    });
    if (!author && message.key.participant?.endsWith("@lid")) {
      await this.#refreshParticipants();
      author = resolvePrivateRecipientJid({
        key: message.key,
        socketUserId: this.#socket?.user?.id,
        participantPhoneJids: this.#participantPhoneJids,
      });
    }
    if (!author) {
      this.#logger.warn("Mensagem do grupo sem telefone privado identificavel.", {
        messageId,
        hasParticipantPn: Boolean(message.key.participantPn),
        participantUsesLid: Boolean(message.key.participant?.endsWith("@lid")),
      });
      return;
    }

    try {
      const body = messageText(message);
      this.#logger.info("Mensagem do grupo encaminhada ao processador.", {
        messageId,
        fromMe: Boolean(message.key.fromMe),
        hasText: Boolean(body),
      });
      await this.#handler({
        message: {
          id: messageId,
          body,
          author: jidNormalizedUser(author),
          from: this.#groupId,
          fromMe: Boolean(message.key.fromMe),
        },
        groupId: this.#groupId,
      });
    } catch (error) {
      this.#logger.error("Falha ao tratar mensagem do WhatsApp.", {
        error,
        messageId,
        group: this.#groupName,
      });
    }
  }

  async sendPrivateText(message, text) {
    const recipient = await this.#validatedPrivateRecipient(message);
    const result = await this.#socket.sendMessage(recipient, { text });
    const delivery = this.#trackDelivery(result, "texto");
    this.#logger.info("Mensagem privada enviada pelo WhatsApp.", {
      sourceMessageId: message?.id,
      sentMessageId: result?.key?.id,
      deliveryPending: true,
    });
    return { result, delivery };
  }

  async sendPrivatePdf(message, bytes, { filename, caption }) {
    const recipient = await this.#validatedPrivateRecipient(message);
    const result = await this.#socket.sendMessage(recipient, {
      document: Buffer.from(bytes),
      mimetype: "application/pdf",
      fileName: filename || "extrato-inss.pdf",
      caption,
    });
    const delivery = this.#trackDelivery(result, "pdf", { bytes: bytes.byteLength });
    this.#logger.info("PDF enviado no privado pelo WhatsApp.", {
      sourceMessageId: message?.id,
      sentMessageId: result?.key?.id,
      bytes: bytes.byteLength,
      deliveryPending: true,
    });
    return { result, delivery };
  }

  async sendPrivatePdfFile(message, filePath, { filename, caption }) {
    const bytes = await fs.readFile(filePath);
    return this.sendPrivatePdf(message, bytes, { filename, caption });
  }

  async stop() {
    this.#stopping = true;
    this.#socket?.end(new Error("Encerramento solicitado."));
    this.#socket = undefined;
  }

  #indexParticipants(participants = []) {
    for (const participant of participants) {
      const phoneJid = participant.phoneNumber
        ? jidNormalizedUser(participant.phoneNumber)
        : participant.jid
          ? jidNormalizedUser(participant.jid)
          : undefined;
      if (!phoneJid?.endsWith("@s.whatsapp.net")) continue;
      for (const id of [participant.id, participant.lid]) {
        if (id) this.#participantPhoneJids.set(jidNormalizedUser(id), phoneJid);
      }
    }
  }

  async #refreshParticipants() {
    if (!this.#socket || !this.#groupId) return;
    if (!this.#participantRefreshPromise) {
      const socket = this.#socket;
      this.#participantRefreshPromise = socket.groupMetadata(this.#groupId)
        .then((metadata) => {
          if (socket === this.#socket) this.#indexParticipants(metadata.participants);
        })
        .catch((error) => {
          this.#logger.warn("Nao foi possivel atualizar os participantes do grupo.", { error });
        })
        .finally(() => {
          this.#participantRefreshPromise = undefined;
        });
    }
    await this.#participantRefreshPromise;
  }

  #privateRecipient(message) {
    if (!message?.author) throw new Error("Nao foi possivel identificar o remetente da mensagem do grupo.");
    if (message.author.endsWith("@lid")) throw new Error("O telefone privado do remetente nao foi resolvido.");
    return message.author;
  }

  async #validatedPrivateRecipient(message) {
    const requestedRecipient = this.#privateRecipient(message);
    const cached = this.#validatedRecipients.get(requestedRecipient);
    if (cached) return cached;

    const matches = await this.#socket.onWhatsApp(requestedRecipient);
    const match = matches.find((item) => item.exists && item.jid);
    if (!match) throw new Error("O destinatario privado nao foi confirmado pelo WhatsApp.");

    const recipient = jidNormalizedUser(match.jid);
    if (!recipient.endsWith("@s.whatsapp.net")) {
      throw new Error("O WhatsApp nao retornou um telefone privado valido.");
    }

    this.#validatedRecipients.set(requestedRecipient, recipient);
    this.#logger.info("Destinatario privado validado pelo WhatsApp.", {
      recipientIsConnectedAccount: jidNormalizedUser(this.#socket.user?.id) === recipient,
    });
    return recipient;
  }

  #trackDelivery(result, kind, extra = {}, timeoutMs = 60_000) {
    const messageId = result?.key?.id;
    if (!messageId) return Promise.reject(new Error("O WhatsApp nao retornou o identificador da mensagem enviada."));
    if (Number(result.status) >= 3 || (this.#deliveryStatuses.get(messageId) || 0) >= 3) {
      this.#logger.info("Entrega privada confirmada imediatamente.", { kind, messageId, ...extra });
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#deliveryWaiters.delete(messageId);
        this.#logger.warn("Entrega privada nao confirmada no prazo.", { kind, messageId, timeoutMs, ...extra });
        reject(new Error("O WhatsApp nao confirmou a entrega da mensagem privada no prazo."));
      }, timeoutMs);
      this.#deliveryWaiters.set(messageId, {
        resolve: () => {
          clearTimeout(timer);
          this.#logger.info("Entrega privada confirmada pelo WhatsApp.", { kind, messageId, ...extra });
          resolve();
        },
      });
    });
  }

  #recordDeliveryStatus(messageId, status) {
    const previous = this.#deliveryStatuses.get(messageId) || 0;
    if (status > previous) this.#deliveryStatuses.set(messageId, status);
    if (this.#deliveryStatuses.size > 1_000) {
      this.#deliveryStatuses.delete(this.#deliveryStatuses.keys().next().value);
    }

    if (status >= 3) {
      const waiter = this.#deliveryWaiters.get(messageId);
      this.#deliveryWaiters.delete(messageId);
      waiter?.resolve();
    }
  }
}
