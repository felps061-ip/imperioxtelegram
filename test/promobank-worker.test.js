import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowedPdfUrl, isPdfBuffer } from "../src/promobank-worker.js";

test("aceita somente PDF HTTPS na mesma origem do Promobank", () => {
  const accepted = assertAllowedPdfUrl(
    "https://promobank.online/sistema/corpo.php?modo=pdf&objContrato=dado",
    "https://promobank.online/",
  );
  assert.equal(accepted.origin, "https://promobank.online");

  assert.throws(
    () => assertAllowedPdfUrl("https://example.com/arquivo.pdf", "https://promobank.online/"),
    /origem HTTPS autorizada/,
  );
  assert.throws(
    () => assertAllowedPdfUrl("http://promobank.online/arquivo.pdf", "https://promobank.online/"),
    /origem HTTPS autorizada/,
  );
});

test("valida a assinatura binaria de um PDF", () => {
  assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7\nconteudo")), true);
  assert.equal(isPdfBuffer(Buffer.from("<html>erro</html>")), false);
});
