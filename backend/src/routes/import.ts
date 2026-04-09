import { Router } from "express";
import { getDb } from "../db/index.js";
import { vendorCookies } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireScope } from "../middleware/auth.js";
import { validateBody, urlImportSchema } from "../middleware/validate.js";
import { urlImportLimiter } from "../middleware/rate-limit.js";
import {
  parseCookiesTxt,
  decryptCookies,
  resolveVendorCookies,
} from "../services/cookies.js";
import {
  validateUrlSyntax,
  fetchOrderPage,
} from "../services/url-fetcher.js";
import { redactForLlm, parseHtmlChain } from "../services/html-parser.js";
import { extractItemsViaLlm, learnSelectorsFromLlm } from "../services/llm-extraction.js";

const router = Router();

router.post(
  "/url",
  requireScope("parts:write"),
  urlImportLimiter,
  validateBody(urlImportSchema),
  async (req, res) => {
    const { url: rawUrl } = req.body as { url: string };

    // 1. Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = validateUrlSyntax(rawUrl);
    } catch {
      res.status(400).json({ error: "Invalid or disallowed URL", errorType: "validation" });
      return;
    }

    // 2. Resolve vendor cookies
    const db = getDb();
    const allCookieRows = await db.select().from(vendorCookies);
    const cookieRow = resolveVendorCookies(parsedUrl.hostname, allCookieRows);

    if (!cookieRow || cookieRow.status === "unconfigured") {
      res.status(400).json({
        error: `No cookies for ${parsedUrl.hostname}. Add in Settings.`,
        errorType: "no_cookies",
        domain: parsedUrl.hostname,
      });
      return;
    }

    // 3. Decrypt and parse cookies
    let cookies;
    try {
      const cookiesTxt = decryptCookies(cookieRow.cookieData);
      cookies = parseCookiesTxt(cookiesTxt);
    } catch {
      res.status(500).json({ error: "Failed to decrypt cookies", errorType: "internal" });
      return;
    }

    // 4. Fetch page
    let fetchResult;
    try {
      fetchResult = await fetchOrderPage(rawUrl, cookies);
    } catch (err) {
      const fetchErr = err as Error & { type?: string };
      const errType = fetchErr.type || "network";
      const status = errType === "timeout" ? 504 : 502;

      await db
        .update(vendorCookies)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(vendorCookies.id, cookieRow.id));

      res.status(status).json({
        error: fetchErr.message || "Fetch failed",
        errorType: errType,
        domain: cookieRow.domain,
      });
      return;
    }

    // 5. Check for login/CAPTCHA
    if (fetchResult.loginDetected) {
      await db
        .update(vendorCookies)
        .set({ status: "needs_reauth", updatedAt: new Date() })
        .where(eq(vendorCookies.id, cookieRow.id));

      res.status(422).json({
        error: "Page redirected to login. Re-upload cookies in Settings.",
        errorType: "login_redirect",
        domain: cookieRow.domain,
      });
      return;
    }

    if (fetchResult.captchaDetected) {
      res.status(422).json({
        error: "Site showing CAPTCHA. Try again in a few minutes.",
        errorType: "captcha",
        domain: cookieRow.domain,
      });
      return;
    }

    // 6. Successful fetch -- update cookie status
    await db
      .update(vendorCookies)
      .set({ status: "active", lastTestedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendorCookies.id, cookieRow.id));

    // 7. Run unified parse chain (hardcoded -> preset -> LLM)
    const vendorKey = cookieRow.domain;
    const { result } = await parseHtmlChain(
      fetchResult.html,
      parsedUrl.hostname,
      vendorKey,
      cookieRow.vendorName,
      (html) => extractItemsViaLlm(html, cookieRow.vendorName),
      (llmResult, html, vk, fp) => learnSelectorsFromLlm(llmResult, html, vk, fp)
    );

    // 8. Ensure rawText is redacted
    result.rawText = redactForLlm(fetchResult.html);

    res.json(result);
  }
);

export default router;
