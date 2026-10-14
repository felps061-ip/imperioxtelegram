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
  enrollmentSelect: 'div.p-select:has(> span.p-select-label[role="combobox"][aria-label^="NB "])',
});

function normalizedLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function activeEnrollmentLabels(entries) {
  const active = [];
  let activeGroup = false;

  for (const entry of entries || []) {
    if (entry?.kind === "group") {
      activeGroup = normalizedLabel(entry.text).startsWith("ativo");
    } else if (entry?.kind === "option" && activeGroup) {
      const label = String(entry.text || "").trim();
      if (label && !active.includes(label)) active.push(label);
    }
  }

  return active;
}

export function followingActiveEnrollmentLabels(entries, currentEnrollment) {
  const active = activeEnrollmentLabels(entries);
  const currentIndex = active.indexOf(String(currentEnrollment || "").trim());
  return currentIndex === -1 ? [] : active.slice(currentIndex + 1);
}

export function remainingActiveEnrollmentLabels(entries, currentEnrollment) {
  const current = String(currentEnrollment || "").trim();
  return activeEnrollmentLabels(entries).filter((label) => label !== current);
}

export function enrollmentLabels(entries) {
  const enrollments = [];
  for (const entry of entries || []) {
    if (entry?.kind !== "option") continue;
    const label = String(entry.text || "").trim();
    if (label && !enrollments.includes(label)) enrollments.push(label);
  }
  return enrollments;
}

export function uniquePhoneNumbers(values) {
  const phones = [];
  for (const value of values || []) {
    const digits = String(value || "").replace(/\D/g, "");
    if ((digits.length === 10 || digits.length === 11) && !phones.includes(digits)) {
      phones.push(digits);
    }
  }
  return phones;
}

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
    const pdfs = await this.fetchInssPdfs(cpf, protocol, downloadDirectory);
    return pdfs[0];
  }

  async fetchInssPdfs(cpf, protocol, downloadDirectory = this.#config.downloadDirectory) {
    return this.#fetchBenefitPdfs(cpf, protocol, downloadDirectory, { benefit: "inss" });
  }

  async fetchSiapePdfs(cpf, protocol, downloadDirectory = this.#config.downloadDirectory) {
    return this.#fetchBenefitPdfs(cpf, protocol, downloadDirectory, { benefit: "siape" });
  }

  async #fetchBenefitPdfs(cpf, protocol, downloadDirectory, { benefit }) {
    if (this.#busy) throw new PromobankAutomationError("WORKER_BUSY", "Worker ocupado.");
    this.#busy = true;

    try {
      await this.start();
      await this.#ensureAuthenticated();
      const frame = benefit === "siape" ? await this.#openSiape() : await this.#openInss();

      await frame.locator(SELECTORS.cpfInput).fill(cpf);
      await frame.locator(SELECTORS.searchButton).click();
      await this.#page.waitForTimeout(5_000);

      const printButton = frame.locator('button:has-text("Ver Impressão")');
      await printButton.waitFor({ state: "visible", timeout: this.#config.queryTimeoutMs });
      const hasOtherEnrollments = await this.#hasOtherEnrollments(frame);
      const currentEnrollment = hasOtherEnrollments ? await this.#currentEnrollment(frame) : undefined;
      const activeEnrollments = benefit === "inss" && hasOtherEnrollments
        ? await this.#activeEnrollments(frame)
        : undefined;
      if (benefit === "inss" && hasOtherEnrollments && activeEnrollments.length === 0) {
        throw new PromobankAutomationError("NO_ACTIVE_ENROLLMENTS", "Nenhuma matricula ativa foi localizada.");
      }

      const currentIsEligible = benefit === "siape" || !hasOtherEnrollments || activeEnrollments.includes(currentEnrollment);
      const remainingEnrollments = !hasOtherEnrollments
        ? []
        : benefit === "siape"
          ? await this.#followingSiapeEnrollments(frame, currentEnrollment)
          : activeEnrollments.filter((enrollment) => enrollment !== currentEnrollment);
      const totalPdfs = (currentIsEligible ? 1 : 0) + remainingEnrollments.length;
      const pdfs = [];

      if (currentIsEligible) {
        pdfs.push(await this.#downloadCurrentEnrollmentPdf(
          frame,
          protocol,
          downloadDirectory,
          currentEnrollment,
          pdfs.length,
          totalPdfs > 1,
          benefit,
        ));
      }

      for (const enrollment of remainingEnrollments) {
          await this.#selectEnrollment(frame, enrollment);
          pdfs.push(await this.#downloadCurrentEnrollmentPdf(
            frame,
            protocol,
            downloadDirectory,
            enrollment,
            pdfs.length,
            totalPdfs > 1,
            benefit,
          ));
      }

      this.#logger.info("PDFs das matriculas preparados.", {
        protocol,
        benefit,
        enrollments: pdfs.length,
        otherEnrollmentsField: hasOtherEnrollments,
      });
      return pdfs;
    } finally { this.#busy = false; }
  }

  async fetchContactPhones(cpf, protocol) {
    if (this.#busy) throw new PromobankAutomationError("WORKER_BUSY", "Worker ocupado.");
    this.#busy = true;

    try {
      await this.start();
      await this.#ensureAuthenticated();
      const { frame, foneHotCard } = await this.#openContacts();
      const cpfInput = foneHotCard.locator('input[placeholder="CPF"].p-inputmask').first();
      const queryButton = foneHotCard.getByRole("button", { name: "Consultar", exact: true }).first();

      await queryButton.waitFor({ state: "visible", timeout: 15_000 });
      await cpfInput.fill(cpf);
      const response = this.#page.waitForResponse(
        (candidate) => ["fetch", "xhr"].includes(candidate.request().resourceType()),
        { timeout: 5_000 },
      ).catch(() => undefined);
      await queryButton.click();
      await response;
      await this.#page.waitForTimeout(500);

      const phoneHeader = frame.locator("th").filter({ hasText: /^\s*Telefone\s*$/ }).first();
      await phoneHeader.waitFor({ state: "visible", timeout: this.#config.queryTimeoutMs });
      const phoneTable = phoneHeader.locator("xpath=ancestor::table");
      const firstColumnValues = await phoneTable
        .locator('tbody tr td[data-pc-section="bodycell"]:first-child')
        .allInnerTexts();
      const phones = uniquePhoneNumbers(firstColumnValues);

      this.#logger.info("Consulta de contatos concluida.", {
        protocol,
        phonesFound: phones.length,
      });
      return phones;
    } finally {
      this.#busy = false;
    }
  }

  async #hasOtherEnrollments(frame) {
    const label = frame.locator("label").filter({ hasText: /outras\s+matr/i });
    return (await label.count().catch(() => 0)) > 0;
  }

  async #currentEnrollment(frame) {
    const select = await this.#enrollmentSelect(frame);
    await select.waitFor({ state: "visible", timeout: 5_000 });
    const label = select.locator('span.p-select-label[role="combobox"]').first();
    return (await label.getAttribute("aria-label"))?.trim() || (await label.innerText()).trim();
  }

  async #followingActiveEnrollments(frame, currentEnrollment) {
    const { entries } = await this.#enrollmentEntries(frame);
    const active = activeEnrollmentLabels(entries);
    const following = followingActiveEnrollmentLabels(entries, currentEnrollment);

    if (!active.includes(currentEnrollment)) {
      throw new PromobankAutomationError(
        "CURRENT_ENROLLMENT_NOT_ACTIVE",
        "A matricula atual nao foi localizada no grupo Ativo.",
      );
    }

    this.#logger.info("Proximas matriculas ativas identificadas.", { count: following.length });
    return following;
  }

  async #activeEnrollments(frame) {
    const { entries } = await this.#enrollmentEntries(frame);
    const active = activeEnrollmentLabels(entries);
    this.#logger.info("Matriculas ativas identificadas.", { count: active.length });
    return active;
  }

  async #followingSiapeEnrollments(frame, currentEnrollment) {
    const { entries } = await this.#enrollmentEntries(frame);
    const enrollments = enrollmentLabels(entries).filter((label) => label !== currentEnrollment);
    this.#logger.info("Matriculas SIAPE adicionais identificadas.", { count: enrollments.length });
    return enrollments;
  }

  async #enrollmentSelect(frame) {
    const inssSelect = frame.locator(SELECTORS.enrollmentSelect).first();
    if (await inssSelect.count().catch(() => 0)) return inssSelect;

    const label = frame.locator("label").filter({ hasText: /outras\s+matr/i }).first();
    const adjacentSelect = label.locator('xpath=following::div[contains(@class, "p-select")][1]');
    if (await adjacentSelect.count().catch(() => 0)) return adjacentSelect;

    const genericSelect = frame.locator('div.p-select:has(> span.p-select-label[role="combobox"])');
    if (await genericSelect.count().catch(() => 0) === 1) return genericSelect.first();

    throw new PromobankAutomationError("ENROLLMENT_SELECT_NOT_FOUND", "O seletor de outras matriculas nao foi localizado.");
  }

  async #enrollmentEntries(frame) {
    const select = await this.#enrollmentSelect(frame);
    await select.click();
    const listbox = frame.locator('[role="listbox"]').filter({ visible: true }).first();
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
    const entries = await listbox.evaluate((element) => Array.from(
      element.querySelectorAll('.p-select-option-group, [data-pc-section="optiongroup"], [role="option"]'),
    ).map((item) => ({
      kind: item.matches('.p-select-option-group, [data-pc-section="optiongroup"]') ? "group" : "option",
      text: item.textContent || "",
    })));
    await select.locator('span.p-select-label[role="combobox"]').first().press("Escape").catch(() => {});
    return { select, entries };
  }

  async #selectEnrollment(frame, enrollment) {
    if (!enrollment) return;
    const select = await this.#enrollmentSelect(frame);
    const label = select.locator('span.p-select-label[role="combobox"]').first();
    const current = (await label.getAttribute("aria-label"))?.trim() || (await label.innerText()).trim();
    if (current === enrollment) return;

    await select.click();
    const listbox = frame.locator('[role="listbox"]').filter({ visible: true }).first();
    await listbox.getByRole("option", { name: enrollment, exact: true }).click();
    await this.#page.waitForTimeout(1_000);
    await frame.locator('button:has-text("Ver Impressão")').waitFor({
      state: "visible",
      timeout: this.#config.queryTimeoutMs,
    });
  }

  async #downloadCurrentEnrollmentPdf(frame, protocol, downloadDirectory, enrollment, index, multiple, benefit = "inss") {
    const printButton = frame.locator('button:has-text("Ver Impressão")');
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
      return await this.#downloadPdfFromPrintPage(
        popup,
        protocol,
        downloadDirectory,
        { enrollment, index, multiple, benefit },
      );
    } catch (error) {
      if (!(error instanceof PromobankAutomationError)) {
        throw new PromobankAutomationError("PDF_POPUP_FAILED", "PDF Popup falhou.", { cause: error });
      }
      throw error;
    } finally {
      if (popup) await popup.close().catch(() => {});
    }
  }

  async #ensureAuthenticated() {
    if (await this.#isAppReady()) return;
    throw new OperatorInterventionError("LOGIN_REQUIRED", "A sessao do Promobank esta ausente ou expirou. A TI deve fazer o login manual no Chrome dedicado.");
  }

  async #isAppReady() { return !!(await this.#page?.locator(SELECTORS.appFrame).count().catch(() => 0)); }

  async #openInss() {
    return this.#openBenefit("INSS");
  }

  async #openSiape() {
    return this.#openBenefit("SIAPE");
  }

  async #openBenefit(benefit) {
    const frame = this.#page.frameLocator(SELECTORS.appFrame);
    const benefitTab = frame.getByRole("button", { name: new RegExp(`^\\s*${benefit}\\s*$`, "i") }).first();
    await benefitTab.waitFor({ state: "visible", timeout: 15_000 });
    await benefitTab.click();
    const confirmChange = frame.locator('button:has-text("Sim")');
    const confirmationVisible = await confirmChange
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmationVisible) {
      await confirmChange.click();
      this.#logger.info("Confirmacao de troca de convenio aceita.", { benefit: benefit.toLowerCase() });
    }
    await frame.locator(SELECTORS.cpfInput).waitFor({ state: "visible", timeout: 15000 });
    return frame;
  }

  async #openContacts() {
    const frame = this.#page.frameLocator(SELECTORS.appFrame);
    const contactsButton = frame.getByRole("button", { name: /^\s*\+?\s*Contatos\s*$/i }).first();
    await contactsButton.waitFor({ state: "visible", timeout: 15_000 });
    await contactsButton.click();
    const foneHotTitle = frame.getByText("Consultar FoneHOT", { exact: true }).first();
    await foneHotTitle.waitFor({ state: "visible", timeout: 15_000 });
    const foneHotCard = foneHotTitle.locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " p-card-body ")][1]',
    );
    await foneHotCard.locator('input[placeholder="CPF"].p-inputmask').first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
    return { frame, foneHotCard };
  }

  async #downloadPdfFromPrintPage(printPage, protocol, downloadDirectory, { enrollment, index = 0, multiple = false, benefit = "inss" } = {}) {
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
    const filename = multiple
      ? `extrato-${benefit}-${protocol}-${index + 1}.pdf`
      : `extrato-${benefit}-${protocol}.pdf`;
    const filePath = path.join(downloadDirectory, filename);
    await fs.writeFile(filePath, bytes);
    this.#logger.info("PDF original baixado da pagina de impressao.", { protocol, bytes: bytes.byteLength, filePath });
    return { filePath, bytes: Buffer.from(bytes), enrollment };
  }
}
