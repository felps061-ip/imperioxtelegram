import crypto from "node:crypto";
import { QueueFullError } from "./errors.js";
import { maskCpf } from "./cpf.js";

const ACTIVE_STATUSES = new Set(["queued", "processing"]);

function publicJob(job, position) {
  return {
    protocol: job.protocol,
    status: job.status,
    cpfMasked: job.cpfMasked,
    position,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorCode: job.errorCode,
  };
}

export class InMemoryJobQueue {
  #handler;
  #logger;
  #maxPending;
  #retention;
  #jobs = new Map();
  #deduplication = new Map();
  #pending = [];
  #runningJob;
  #draining = false;
  #stopped = false;
  #idleWaiters = [];

  constructor({ handler, logger, maxPending = 50, retention = 200 }) {
    this.#handler = handler;
    this.#logger = logger;
    this.#maxPending = maxPending;
    this.#retention = retention;
  }

  enqueue({ requesterId, chatId, cpf, sourceMessage, requestType = "inss" }) {
    if (this.#stopped) {
      throw new Error("A fila esta encerrada.");
    }

    const requesterKey = String(requesterId);
    const deduplicationKey = `${requesterKey}:${requestType}:${cpf}`;
    const existingProtocol = this.#deduplication.get(deduplicationKey);
    if (existingProtocol) {
      const existing = this.#jobs.get(existingProtocol);
      if (existing && ACTIVE_STATUSES.has(existing.status)) {
        return { job: publicJob(existing, this.#position(existing.protocol)), duplicate: true };
      }
    }

    if (this.#pending.length >= this.#maxPending) {
      throw new QueueFullError();
    }

    const protocol = this.#newProtocol();
    const job = {
      protocol,
      requesterId: requesterKey,
      chatId: String(chatId),
      cpf,
      requestType,
      sourceMessage,
      cpfMasked: maskCpf(cpf),
      deduplicationKey,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: undefined,
      finishedAt: undefined,
      errorCode: undefined,
    };

    this.#jobs.set(protocol, job);
    this.#deduplication.set(deduplicationKey, protocol);
    this.#pending.push(protocol);
    this.#logger.info("Solicitacao adicionada a fila.", {
      protocol,
      requesterId: requesterKey,
      cpf: job.cpfMasked,
      position: this.#position(protocol),
    });
    this.#scheduleDrain();

    return { job: publicJob(job, this.#position(protocol)), duplicate: false };
  }

  getForRequester(protocol, requesterId) {
    const job = this.#jobs.get(String(protocol).toUpperCase());
    if (!job || job.requesterId !== String(requesterId)) {
      return undefined;
    }

    return publicJob(job, this.#position(job.protocol));
  }

  stopAccepting() {
    this.#stopped = true;
  }

  async waitForIdle() {
    if (!this.#runningJob && this.#pending.length === 0 && !this.#draining) {
      return;
    }

    await new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #newProtocol() {
    let protocol;
    do {
      protocol = crypto.randomBytes(4).toString("hex").toUpperCase();
    } while (this.#jobs.has(protocol));
    return protocol;
  }

  #position(protocol) {
    if (this.#runningJob?.protocol === protocol) {
      return 0;
    }

    const index = this.#pending.indexOf(protocol);
    return index === -1 ? undefined : index + 1;
  }

  #scheduleDrain() {
    if (this.#draining) {
      return;
    }

    queueMicrotask(() => {
      void this.#drain();
    });
  }

  async #drain() {
    if (this.#draining) {
      return;
    }

    this.#draining = true;
    try {
      while (this.#pending.length > 0) {
        const protocol = this.#pending.shift();
        const job = this.#jobs.get(protocol);
        if (!job) {
          continue;
        }

        this.#runningJob = job;
        job.status = "processing";
        job.startedAt = new Date().toISOString();
        this.#logger.info("Processamento iniciado.", { protocol: job.protocol, cpf: job.cpfMasked });

        try {
          await this.#handler(job);
          job.status = "completed";
          this.#logger.info("Processamento concluido.", { protocol: job.protocol });
        } catch (error) {
          job.status = "failed";
          job.errorCode = error?.code || "UNEXPECTED_ERROR";
          this.#logger.error("Processamento falhou.", { protocol: job.protocol, error });
        } finally {
          job.finishedAt = new Date().toISOString();
          job.cpf = undefined;
          job.sourceMessage = undefined;
          this.#deduplication.delete(job.deduplicationKey);
          job.deduplicationKey = undefined;
          this.#runningJob = undefined;
          this.#prune();
        }
      }
    } finally {
      this.#draining = false;
      if (this.#pending.length > 0) {
        this.#scheduleDrain();
      } else {
        for (const resolve of this.#idleWaiters.splice(0)) {
          resolve();
        }
      }
    }
  }

  #prune() {
    if (this.#jobs.size <= this.#retention) {
      return;
    }

    for (const [protocol, job] of this.#jobs) {
      if (!ACTIVE_STATUSES.has(job.status)) {
        this.#jobs.delete(protocol);
      }
      if (this.#jobs.size <= this.#retention) {
        break;
      }
    }
  }
}
