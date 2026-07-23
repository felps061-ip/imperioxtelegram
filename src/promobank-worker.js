import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { OperatorInterventionError, PromobankAutomationError } from "./errors.js";

const SELECTORS = Object.freeze({
  loginCompany: "#inputEmpresa",
  loginUsername: "#inputUsuario",
  loginPassword: "#passField",
  loginSubmit: "#submitButton",
  appFrame: "iframe.iFrameStyle",
  remoteSessionConflict: "#encerrarSessionRemota",
  meuInssMenuItem: 'li.open-screen[onclick*="destino=meuInss"]',
  servicesMenu: "a.dropdown-toggle",
  cpfInput: 'input[data-tour="input-consulta"]',
  searchButton: "#consultarCliente",
});

export function assertAllowedPdfUrl(value, baseUrl) {
  let candidate;
  let base;
  try {
    candidate = new URL(value);
    base = new URL(baseUrl);
  } catch {
    throw new PromobankAutomationError("PDF_URL_INVALID", "O Promobank abriu uma URL de PDF invalida.");
  }

  if (candidate.protocol !== "https:" || candidate.origin !== base.origin) {
    throw new PromobankAutomationError(
      "PDF_URL_NOT_ALLOWED",
      "O Promobank abriu o PDF fora da origem HTTPS autorizada.",
    );
  }

  return candidate;
}

export function isPdfBuffer(bytes) {
  if (!bytes || bytes.byteLength < 5) {
    return false;
  }

  return Buffer.from(bytes).subarray(0, 5).toString("ascii") === "%PDF-";
}

export class PromobankWorker {
  #config;
  #logger;
  #context;
  #page;
  #busy = false;

  constructor({ config, logger }) {
    this.#config = config;
    this.#logger = logger;
  }

  async start() {
    if (this.#context) {
      return;
    }

    await fs.mkdir(this.#config.profileDirectory, { recursive: true });
    const launchOptions = {
      headless: this.#config.headless,
      acceptDownloads: false,
      locale: "pt-BR",
      viewport: null,
      args: ["--disable-save-password-bubble"],
    };

    if (this.#config.chromeExecutable) {
      launchOptions.executablePath = this.#config.chromeExecutable;
    } else {
      launchOptions.channel = this.#config.chromeChannel;
    }

    this.#logger.info("Iniciando perfil persistente do Chrome para o Promobank.", {
      profile: "dedicado-e-persistente",
      headless: this.#config.headless,
    });

    try {
      this.#context = await chromium.launchPersistentContext(this.#config.profileDirectory, launchOptions);
      this.#context.setDefaultTimeout(30_000);
      this.#page = this.#context.pages()[0] || (await this.#context.newPage());
      this.#page.setDefaultNavigationTimeout(this.#config.loginTimeoutMs);
    } catch (error) {
      throw new OperatorInterventionError(
        "CHROME_START_FAILED",
        "Nao foi possivel iniciar o Chrome dedicado. Verifique se o perfil do robo ja esta aberto.",
        { cause: error },
      );
    }
  }

  async stop() {
    const context = this.#context;
    this.#context = undefined;
    this.#page = undefined;
    if (context) {
      await context.close().catch((error) => {
        this.#logger.warn("Falha ao fechar o Chrome do robo.", { error });
      });
    }
  }

  async fetchInssPdf(cpf, protocol) {
    if (this.#busy) {
      throw new PromobankAutomationError("WORKER_BUSY", "O worker recebeu dois trabalhos simultaneos.");
    }

    this.#busy = true;
    try {
      await this.start();
      await this.#ensureAuthenticated();
      const frame = await this.#openMeuInss();

      const cpfInput = frame.locator(SELECTORS.cpfInput);
      const searchButton = frame.locator(SELECTORS.searchButton);
      await cpfInput.fill(cpf);
      await searchButton.click();

      const printButton = frame.getByRole("button", { name: "Ver Impressão", exact: true });
      try {
        await printButton.waitFor({ state: "visible", timeout: this.#config.queryTimeoutMs });
      } catch (error) {
        throw new PromobankAutomationError(
          "QUERY_TIMEOUT",
          "A consulta terminou sem disponibilizar o botao de impressao no prazo esperado.",
          { cause: error },
        );
      }

      let popup;
      try {
        [popup] = await Promise.all([
          this.#context.waitForEvent("page", { timeout: this.#config.pdfTimeoutMs }),
          printButton.click(),
        ]);
        await popup.waitForURL((url) => url.toString() !== "about:blank", {
          timeout: this.#config.pdfTimeoutMs,
          waitUntil: "commit",
        });
        const pdfUrl = assertAllowedPdfUrl(popup.url(), this.#config.baseUrl);
        return await this.#downloadPdf(pdfUrl, protocol);
      } catch (error) {
        if (error instanceof PromobankAutomationError) {
          throw error;
        }
        throw new PromobankAutomationError(
          "PDF_POPUP_FAILED",
          "O Promobank nao abriu a nova aba do PDF como esperado.",
          { cause: error },
        );
      } finally {
        if (popup) {
          await popup.close().catch(() => {});
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  async #ensureAuthenticated() {
    if (await this.#isAppReady()) {
      await this.#throwIfRemoteSessionConflict();
      return;
    }

    await this.#page.goto(this.#config.baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.#config.loginTimeoutMs,
    });

    if (await this.#isAppReady()) {
      await this.#throwIfRemoteSessionConflict();
      return;
    }

    const companyInput = this.#page.locator(SELECTORS.loginCompany);
    try {
      await companyInput.waitFor({ state: "visible", timeout: this.#config.loginTimeoutMs });
    } catch (error) {
      throw new OperatorInterventionError(
        "LOGIN_PAGE_UNAVAILABLE",
        "A pagina de login do Promobank nao ficou disponivel.",
        { cause: error },
      );
    }

    if (!this.#config.company || !this.#config.username || !this.#config.password) {
      throw new OperatorInterventionError(
        "LOGIN_REQUIRED",
        "A sessao do Promobank exige login e as credenciais automaticas nao foram configuradas.",
      );
    }

    await companyInput.fill(this.#config.company);
    await this.#page.locator(SELECTORS.loginUsername).fill(this.#config.username);
    await this.#page.locator(SELECTORS.loginPassword).fill(this.#config.password);
    await this.#page.locator(SELECTORS.loginSubmit).click();

    const readyPromise = this.#page
      .locator(SELECTORS.meuInssMenuItem)
      .waitFor({ state: "attached", timeout: this.#config.loginTimeoutMs })
      .then(() => "ready")
      .catch(() => "timeout");
    const conflictPromise = this.#page
      .locator(SELECTORS.remoteSessionConflict)
      .waitFor({ state: "visible", timeout: this.#config.loginTimeoutMs })
      .then(() => "conflict")
      .catch(() => "timeout");

    const state = await Promise.race([readyPromise, conflictPromise]);
    if (state === "conflict") {
      throw new OperatorInterventionError(
        "REMOTE_SESSION_CONFLICT",
        "O Promobank informou que este login esta conectado em outro computador.",
      );
    }
    if (state !== "ready" || !(await this.#isAppReady())) {
      throw new OperatorInterventionError(
        "LOGIN_FAILED",
        "O Promobank nao confirmou o login. Verifique empresa, usuario, senha e eventuais avisos na tela.",
      );
    }
  }

  async #isAppReady() {
    if (!this.#page || this.#page.isClosed()) {
      return false;
    }

    return (await this.#page.locator(SELECTORS.meuInssMenuItem).count()) > 0;
  }

  async #throwIfRemoteSessionConflict() {
    const conflict = this.#page.locator(SELECTORS.remoteSessionConflict);
    if ((await conflict.count()) > 0 && (await conflict.isVisible().catch(() => false))) {
      throw new OperatorInterventionError(
        "REMOTE_SESSION_CONFLICT",
        "O Promobank informou que este login esta conectado em outro computador.",
      );
    }
  }

  async #openMeuInss() {
    const menuItem = this.#page.locator(SELECTORS.meuInssMenuItem);
    if ((await menuItem.count()) !== 1) {
      throw new PromobankAutomationError(
        "MEU_INSS_MENU_NOT_FOUND",
        "O menu Meu INSS nao foi encontrado de forma unica.",
      );
    }

    if (!(await menuItem.isVisible())) {
      const servicesMenu = this.#page.locator(SELECTORS.servicesMenu, { hasText: "Serviços" });
      if ((await servicesMenu.count()) === 0) {
        throw new PromobankAutomationError("SERVICES_MENU_NOT_FOUND", "O menu Servicos nao foi encontrado.");
      }
      await servicesMenu.first().click();
    }

    const frameNavigation = this.#page
      .waitForEvent("framenavigated", {
        predicate: (frame) => frame.parentFrame() === this.#page.mainFrame(),
        timeout: 15_000,
      })
      .catch(() => undefined);
    await menuItem.click();
    await frameNavigation;

    const frame = this.#page.frameLocator(SELECTORS.appFrame);
    try {
      await frame.locator(SELECTORS.cpfInput).waitFor({ state: "visible", timeout: this.#config.loginTimeoutMs });
    } catch (error) {
      throw new PromobankAutomationError(
        "MEU_INSS_FRAME_NOT_READY",
        "A tela Meu INSS nao ficou pronta para receber o CPF.",
        { cause: error },
      );
    }
    return frame;
  }

  async #downloadPdf(pdfUrl, protocol) {
    let response;
    try {
      response = await this.#context.request.get(pdfUrl.toString(), {
        failOnStatusCode: false,
        headers: { referer: this.#page.url() },
        timeout: this.#config.pdfTimeoutMs,
      });
    } catch (error) {
      throw new PromobankAutomationError(
        "PDF_DOWNLOAD_FAILED",
        "A conexao autenticada nao conseguiu baixar o PDF do Promobank.",
        { cause: error },
      );
    }

    if (!response.ok()) {
      throw new PromobankAutomationError(
        "PDF_HTTP_ERROR",
        `O Promobank respondeu ${response.status()} ao solicitar o PDF.`,
      );
    }

    const contentLength = Number(response.headers()["content-length"] || 0);
    if (contentLength > this.#config.maxPdfBytes) {
      throw new PromobankAutomationError("PDF_TOO_LARGE", "O PDF excedeu o limite de tamanho configurado.");
    }

    const bytes = await response.body();
    if (bytes.byteLength > this.#config.maxPdfBytes) {
      throw new PromobankAutomationError("PDF_TOO_LARGE", "O PDF excedeu o limite de tamanho configurado.");
    }
    if (!isPdfBuffer(bytes)) {
      throw new PromobankAutomationError("INVALID_PDF", "A resposta do Promobank nao e um arquivo PDF valido.");
    }

    this.#logger.info("PDF capturado em memoria.", {
      protocol,
      bytes: bytes.byteLength,
      contentType: response.headers()["content-type"] || "desconhecido",
    });
    return Buffer.from(bytes);
  }
}
