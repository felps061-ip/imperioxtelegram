import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { OperatorInterventionError, PromobankAutomationError } from "./errors.js";

const SELECTORS = Object.freeze({
  loginCompany: "#inputEmpresa",
  loginUsername: "#inputUsuario",
  loginPassword: "#passField",
  loginSubmit: "#submitButton",
  appFrame: 'iframe[src*="/l/atendimento"]',
  cpfInput: 'input[data-tour="input-consulta"]',
  searchButton: "#consultarCliente",
});

export function assertAllowedPdfUrl(value, baseUrl) {
  let candidate, base;
  try { candidate = new URL(value); base = new URL(baseUrl); }
  catch { throw new PromobankAutomationError("PDF_URL_INVALID", "URL de PDF inválida"); }
  if (candidate.protocol !== "https:" || candidate.origin !== base.origin) throw new PromobankAutomationError("PDF_URL_NOT_ALLOWED", "PDF fora da origem HTTPS autorizada.");
  return candidate;
}

export function isPdfBuffer(bytes) {
  if (!bytes || bytes.byteLength < 5) return false;
  return Buffer.from(bytes).subarray(0, 5).toString("ascii") === "%PDF-";
}

export class PromobankWorker {
  #config; #logger; #browser; #context; #page; #busy = false;

  constructor({ config, logger }) { this.#config = config; this.#logger = logger; }

  async start() {
    if (this.#context) return;
    await fs.mkdir(this.#config.profileDirectory, { recursive: true });

    const debugPort = this.#config.debugPort || 9223;
    const endpoint = `http://127.0.0.1:${debugPort}`;
    await this.#ensureChrome(endpoint);
    this.#logger.info("Conectando ao Chrome dedicado do Promobank.", { profile: this.#config.profileDirectory, debugPort });

    try {
      this.#browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
      const context = this.#browser.contexts()[0] || await this.#browser.newContext();
      this.#context = context;
      this.#context.setDefaultTimeout(60_000);
      this.#page = this.#selectPromobankPage(context);
      if (!this.#page) this.#page = await context.newPage();
      this.#page.on("console", (msg) => { if (msg.text().includes("cloudflare") || msg.type() === "error") this.#logger.warn(`[Browser Log]: ${msg.text()}`); });
    } catch (error) { throw new OperatorInterventionError("CHROME_START_FAILED", "Não foi possível conectar ao Chrome dedicado do Promobank.", { cause: error }); }
  }

  async #ensureChrome(endpoint) {
    if (await this.#isDebugEndpointReady(endpoint)) return;

    const executable = this.#config.chromeExecutable || this.#findChromeExecutable();
    if (!executable) {
      throw new OperatorInterventionError("CHROME_START_FAILED", "Chrome nao encontrado. Informe PROMOBANK_CHROME_EXECUTABLE.");
    }

    this.#logger.info("Abrindo Chrome dedicado para login manual.", { profile: this.#config.profileDirectory });
    const child = spawn(executable, [
      `--user-data-dir=${this.#config.profileDirectory}`,
      `--remote-debugging-port=${this.#config.debugPort}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--window-size=1920,1080",
      this.#config.baseUrl,
    ], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await this.#isDebugEndpointReady(endpoint)) return;
    }

    throw new OperatorInterventionError("CHROME_START_FAILED", "O Chrome dedicado nao ficou disponivel para o robo.");
  }

  #findChromeExecutable() {
    const candidates = [];
    if (process.platform === "win32") {
      candidates.push(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
      );
    } else {
      candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
    }
    return candidates.find((candidate) => existsSync(candidate));
  }

  async #isDebugEndpointReady(endpoint) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) });
      return response.ok;
    } catch {
      return false;
    }
  }

  #selectPromobankPage(context) {
    const baseOrigin = new URL(this.#config.baseUrl).origin;
    return context.pages().find((page) => {
      try { return new URL(page.url()).origin === baseOrigin; } catch { return false; }
    });
  }

  async stop() {
    this.#browser = undefined;
    this.#context = undefined;
    this.#page = undefined;
  }

  async prepareForManualLogin() {
    await this.start();
    if (await this.#isAppReady()) {
      this.#logger.info("Sessao do Promobank ja esta autenticada.");
      return;
    }
    this.#logger.info("Promobank esta aberto no Chrome dedicado. A TI deve resolver qualquer captcha e fazer o login manual.");
  }

  async fetchInssPdf(cpf, protocol, downloadDirectory = this.#config.downloadDirectory) {
    if (this.#busy) throw new PromobankAutomationError("WORKER_BUSY", "Worker ocupado.");
    this.#busy = true;

    try {
      await this.start();
      await this.#ensureAuthenticated();
      const frame = await this.#openInss();

      await frame.locator(SELECTORS.cpfInput).fill(cpf);
      await frame.locator(SELECTORS.searchButton).click();
      await this.#page.waitForTimeout(5_000);

      const printButton = frame.locator('button:has-text("Ver Impressão")');
      await printButton.waitFor({ state: "visible", timeout: this.#config.queryTimeoutMs });

      let popup;
      try {
        [popup] = await Promise.all([
          this.#context.waitForEvent("page", { timeout: this.#config.pdfTimeoutMs }),
          printButton.click(),
        ]);
        await popup.waitForURL(url => url.toString() !== "about:blank", { timeout: this.#config.pdfTimeoutMs, waitUntil: "commit" });
        assertAllowedPdfUrl(popup.url(), this.#config.baseUrl);
        await popup.waitForLoadState("domcontentloaded", { timeout: this.#config.pdfTimeoutMs });
        await popup.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        return await this.#downloadPdfFromPrintPage(popup, protocol, downloadDirectory);
      } catch (error) {
        if (!(error instanceof PromobankAutomationError)) throw new PromobankAutomationError("PDF_POPUP_FAILED", "PDF Popup falhou.", { cause: error });
        throw error;
      } finally { if (popup) await popup.close().catch(() => {}); }
    } finally { this.#busy = false; }
  }

  async #ensureAuthenticated() {
    if (await this.#isAppReady()) return;
    throw new OperatorInterventionError("LOGIN_REQUIRED", "A sessao do Promobank esta ausente ou expirou. A TI deve fazer o login manual no Chrome dedicado.");
  }

  async #isAppReady() { return !!(await this.#page?.locator(SELECTORS.appFrame).count().catch(() => 0)); }

  async #openInss() {
    const frame = this.#page.frameLocator(SELECTORS.appFrame);
    const inssTab = frame.locator('button:has-text("INSS")');
    await inssTab.waitFor({ state: "visible", timeout: 15_000 });
    await inssTab.click();
    const confirmChange = frame.locator('button:has-text("Sim")');
    const confirmationVisible = await confirmChange
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmationVisible) {
      await confirmChange.click();
      this.#logger.info("Confirmacao de troca para o convenio INSS aceita.");
    }
    await frame.locator(SELECTORS.cpfInput).waitFor({ state: "visible", timeout: 15000 });
    return frame;
  }

  async #downloadPdfFromPrintPage(printPage, protocol, downloadDirectory) {
    const result = await printPage.evaluate(async ({ url, maxBytes }) => {
      const response = await fetch(url, { credentials: "include" });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) return { status: response.status, tooLarge: true };

      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 32_768;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }

      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") || "",
        base64: btoa(binary),
      };
    }, { url: printPage.url(), maxBytes: this.#config.maxPdfBytes });

    if (result.tooLarge) throw new PromobankAutomationError("PDF_TOO_LARGE", "PDF excede o limite configurado.");
    if (!result.ok) throw new PromobankAutomationError("PDF_HTTP_ERROR", `Promobank respondeu ${result.status}.`);
    const bytes = Buffer.from(result.base64, "base64");

    if (bytes.byteLength > this.#config.maxPdfBytes || !isPdfBuffer(bytes)) throw new PromobankAutomationError("INVALID_PDF", "PDF inválido.");
    await fs.mkdir(downloadDirectory, { recursive: true });
    const filename = `extrato-inss-${protocol}.pdf`;
    const filePath = path.join(downloadDirectory, filename);
    await fs.writeFile(filePath, bytes);
    this.#logger.info("PDF original baixado da pagina de impressao.", { protocol, bytes: bytes.byteLength, filePath });
    return { filePath, bytes: Buffer.from(bytes) };
  }
}
