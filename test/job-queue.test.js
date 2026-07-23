import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryJobQueue } from "../src/job-queue.js";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("processa um trabalho por vez e elimina o CPF ao terminar", async () => {
  const events = [];
  const queue = new InMemoryJobQueue({
    logger: silentLogger,
    handler: async (job) => {
      events.push(`start:${job.cpfMasked}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${job.cpfMasked}`);
    },
  });

  const first = queue.enqueue({ requesterId: "1", chatId: "1", cpf: "52998224725" });
  const second = queue.enqueue({ requesterId: "2", chatId: "2", cpf: "16899535009" });
  await queue.waitForIdle();

  assert.deepEqual(events, [
    "start:***.***.***-25",
    "end:***.***.***-25",
    "start:***.***.***-09",
    "end:***.***.***-09",
  ]);
  assert.equal(queue.getForRequester(first.job.protocol, "1").status, "completed");
  assert.equal(queue.getForRequester(second.job.protocol, "2").status, "completed");
});

test("reaproveita protocolo de uma consulta duplicada ainda ativa", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = new InMemoryJobQueue({
    logger: silentLogger,
    handler: async () => gate,
  });

  const first = queue.enqueue({ requesterId: "1", chatId: "1", cpf: "52998224725" });
  const duplicate = queue.enqueue({ requesterId: "1", chatId: "1", cpf: "52998224725" });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.protocol, first.job.protocol);
  release();
  await queue.waitForIdle();
});
