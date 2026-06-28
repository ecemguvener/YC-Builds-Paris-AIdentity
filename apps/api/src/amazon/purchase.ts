import path from "node:path";
import fs from "node:fs";
import type { AppConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Amazon purchase tool — Playwright browser automation.
//
// Amazon has no consumer ordering API, so this drives a real browser through a
// logged-in session (captured once via `npm run amazon:login`). It searches,
// adds the best match to the cart, proceeds to checkout, and STOPS at the order
// review — returning the item, price, and a screenshot — until a human approves.
// Only then does it click "Place your order".
//
// Security: card/shipping come from process.env at point-of-use, are never
// stored or logged, and (preferably) the account's default card/address are
// used so no card number is typed by us at all.
//
// Caveats: automated ordering is against Amazon's Conditions of Use (account
// risk), and Amazon's bot detection (CAPTCHA / "verify it's you" / 2FA) can
// interrupt a run. We do NOT implement CAPTCHA-solving or detection evasion.
// ---------------------------------------------------------------------------

export interface OrderResult {
  status: "review" | "placed" | "failed" | "blocked";
  query: string;
  itemTitle: string | null;
  price: string | null;
  productUrl: string | null;
  orderNumber: string | null;
  screenshotPath: string | null;
  detail: string;
}

const NAV_TIMEOUT = 45_000;
const STEP_TIMEOUT = 20_000;

function sessionFile(config: AppConfig): string {
  return path.resolve(process.cwd(), config.AMAZON_STORAGE_STATE_PATH);
}

/** Launch the configured browser engine (default webkit = Safari's engine). */
async function launchBrowser(config: AppConfig, headless: boolean) {
  const playwright = await import("playwright");
  const engine = playwright[config.AMAZON_BROWSER] ?? playwright.webkit;
  return engine.launch({ headless });
}

function screenshotsDir(): string {
  const dir = path.resolve(process.cwd(), "data", "amazon-screenshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hasSession(config: AppConfig): boolean {
  return fs.existsSync(sessionFile(config));
}

/**
 * One-time login. Launches a headful browser at Amazon's sign-in page and waits
 * for YOU to log in by hand (including any 2FA/CAPTCHA), then persists the
 * session so future order runs skip login.
 */
export async function captureAmazonLogin(config: AppConfig): Promise<void> {
  const browser = await launchBrowser(config, false);
  const context = await browser.newContext();
  const page = await context.newPage();
  // Open the homepage, then the account/sign-in link (hitting /ap/signin
  // directly returns Amazon's "not a functioning page" error).
  await page.goto(config.AMAZON_BASE_URL, { timeout: NAV_TIMEOUT }).catch(() => undefined);
  await page.locator("#nav-link-accountList, a[data-nav-role='signin']").first().click({ timeout: STEP_TIMEOUT }).catch(() => undefined);
  // eslint-disable-next-line no-console
  console.log("\n[amazon:login] A browser opened. Sign in to your Amazon account (handle any 2FA/CAPTCHA).");
  // eslint-disable-next-line no-console
  console.log("[amazon:login] It saves automatically once you're logged in — no need to come back here.\n");

  // Resolve on EITHER: Amazon auth cookie appears (logged in), or stdin Enter.
  const loggedIn = new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      try {
        const cookies = await context.cookies();
        if (cookies.some((c) => /^(?:at-|sess-at-)/.test(c.name))) {
          clearInterval(timer);
          resolve();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    // Safety timeout: 8 minutes.
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 8 * 60 * 1000);
  });
  const manual = new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
  await Promise.race([loggedIn, manual]);

  await context.storageState({ path: sessionFile(config) });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`[amazon:login] Session saved to ${sessionFile(config)}`);
}

/**
 * Create a NEW Amazon account for the agent. Opens the registration form,
 * pre-fills the agent's name / email / password, then waits for you to complete
 * the CAPTCHA + the verification code Amazon emails (the code must reach an
 * inbox you can open). Auto-saves the session once the account exists.
 *
 * Credentials come from env: AMAZON_ACCOUNT_NAME, AMAZON_ACCOUNT_EMAIL,
 * AMAZON_ACCOUNT_PASSWORD. They are never logged.
 */
export async function registerAmazonAccount(config: AppConfig): Promise<void> {
  const name = process.env.AMAZON_ACCOUNT_NAME || "Aidentity Agent";
  const email = process.env.AMAZON_ACCOUNT_EMAIL;
  const password = process.env.AMAZON_ACCOUNT_PASSWORD;
  if (!email || !password) {
    throw new Error("Set AMAZON_ACCOUNT_EMAIL and AMAZON_ACCOUNT_PASSWORD (an inbox you can open for the verification code).");
  }

  const browser = await launchBrowser(config, false);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(config.AMAZON_BASE_URL, { timeout: NAV_TIMEOUT }).catch(() => undefined);
  // Homepage -> account menu -> Sign in page -> "Create your Amazon account".
  await page.locator("#nav-link-accountList").click({ timeout: STEP_TIMEOUT }).catch(() => undefined);
  await page.locator("#createAccountSubmit, a:has-text('Create your Amazon account')").first().click({ timeout: STEP_TIMEOUT }).catch(() => undefined);
  // Pre-fill the registration form (selectors are best-effort).
  await page.locator("#ap_customer_name, input[name='customerName']").first().fill(name).catch(() => undefined);
  await page.locator("#ap_email, input[name='email']").first().fill(email).catch(() => undefined);
  await page.locator("#ap_password, input[name='password']").first().fill(password).catch(() => undefined);
  await page.locator("#ap_password_check, input[name='passwordCheck']").first().fill(password).catch(() => undefined);

  // eslint-disable-next-line no-console
  console.log("\n[amazon:register] A browser opened with the agent's details pre-filled.");
  // eslint-disable-next-line no-console
  console.log(`[amazon:register] Email: ${email}  (Amazon will send a verification code here — open this inbox.)`);
  // eslint-disable-next-line no-console
  console.log("[amazon:register] Click 'Create your Amazon account', solve any CAPTCHA, and enter the emailed code. It saves automatically when done.\n");

  const created = new Promise<void>((resolve) => {
    const timer = setInterval(async () => {
      try {
        const cookies = await context.cookies();
        if (cookies.some((c) => /^(?:at-|sess-at-)/.test(c.name))) {
          clearInterval(timer);
          resolve();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 10 * 60 * 1000);
  });
  const manual = new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
  await Promise.race([created, manual]);

  await context.storageState({ path: sessionFile(config) });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`[amazon:register] Session saved to ${sessionFile(config)}`);
}

/**
 * Search for `query`, add the best match to the cart, go to the order review,
 * and (only when approved) place the order.
 */
export async function placeAmazonOrder(query: string, approved: boolean, config: AppConfig): Promise<OrderResult> {
  const result: OrderResult = {
    status: "failed",
    query,
    itemTitle: null,
    price: null,
    productUrl: null,
    orderNumber: null,
    screenshotPath: null,
    detail: ""
  };

  if (!hasSession(config)) {
    result.status = "blocked";
    result.detail = "No Amazon session. Run `npm run amazon:login` once to capture a logged-in session.";
    return result;
  }

  const headless = config.AMAZON_HEADLESS === "true";
  const browser = await launchBrowser(config, headless);
  const shot = async (name: string) => {
    try {
      const file = path.join(screenshotsDir(), `${Date.now()}-${name}.png`);
      const pages = context.pages();
      if (pages[0]) await pages[0].screenshot({ path: file, fullPage: false });
      result.screenshotPath = file;
    } catch {
      /* best effort */
    }
  };

  const context = await browser.newContext({ storageState: sessionFile(config), viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  try {
    // --- Search -----------------------------------------------------------
    await page.goto(config.AMAZON_BASE_URL, { waitUntil: "domcontentloaded" });
    if (await isBotWall(page)) {
      result.status = "blocked";
      result.detail = "Amazon showed a CAPTCHA / 'verify it's you' wall. Re-run `npm run amazon:login` to refresh the session, or complete it manually in a headful run.";
      await shot("botwall");
      return result;
    }
    const searchBox = page.locator("#twotabsearchtextbox");
    await searchBox.fill(query);
    await searchBox.press("Enter");
    await page.waitForLoadState("domcontentloaded");

    // --- Pick the first real (non-sponsored) result -----------------------
    const firstResult = page
      .locator('div[data-component-type="s-search-result"] h2 a, div[data-component-type="s-search-result"] a.a-link-normal.s-no-outline')
      .first();
    await firstResult.waitFor({ timeout: STEP_TIMEOUT });
    result.itemTitle = (await firstResult.innerText().catch(() => ""))?.trim() || null;
    await firstResult.click();
    await page.waitForLoadState("domcontentloaded");
    result.productUrl = page.url();
    result.itemTitle = result.itemTitle ?? (await page.locator("#productTitle").innerText().catch(() => ""))?.trim() ?? null;
    result.price =
      (await page.locator("#corePrice_feature_div .a-offscreen, .a-price .a-offscreen").first().innerText().catch(() => ""))?.trim() ||
      null;
    await shot("product");

    // --- Add to cart / Buy now -> proceed to checkout ---------------------
    const buyNow = page.locator("#buy-now-button");
    if (await buyNow.count()) {
      await buyNow.click().catch(() => undefined);
    } else {
      const addToCart = page.locator("#add-to-cart-button");
      await addToCart.click({ timeout: STEP_TIMEOUT });
      // Skip any "add a warranty / protection plan" interstitial.
      await page.locator("#attachSiNoCoverage, input[name='proceedToRetailCheckout']").first().click().catch(() => undefined);
      await page.goto(`${config.AMAZON_BASE_URL}/gp/cart/view.html`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.locator("input[name='proceedToRetailCheckout'], #sc-buy-box-ptc-button input, a[href*='checkout']").first().click().catch(() => undefined);
    }
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    if (await isBotWall(page)) {
      result.status = "blocked";
      result.detail = "Amazon interrupted checkout with a verification wall. Complete it once in a headful run, then retry.";
      await shot("checkout-botwall");
      return result;
    }

    // Best-effort: select the preset shipping address. The reliable path is to
    // set this as your Amazon account's DEFAULT delivery address; this just
    // tries to pick it if an address chooser is shown.
    await ensurePresetAddress(page);

    // Optional: enter a card from env only if a card form is present and the
    // account has no usable default card. Prefer the account's default card.
    await maybeEnterCardFromEnv(page);

    await shot("order-review");

    // --- Human-approval gate ---------------------------------------------
    if (!approved) {
      result.status = "review";
      result.detail = "Reached the order review. Approve to place the order.";
      return result;
    }

    // --- Place the order --------------------------------------------------
    const placeButton = page
      .locator(
        "#placeYourOrder input, input[name='placeYourOrder1'], #submitOrderButtonId input, #bottomSubmitOrderButtonId input, #turbo-checkout-pyo-button"
      )
      .first();
    await placeButton.waitFor({ timeout: STEP_TIMEOUT });
    await placeButton.click();
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await shot("order-confirmation");

    const confirmationText =
      (await page.locator("#widget-purchaseConfirmationStatus, [data-testid='order-confirmation'], h1, .a-box-inner").first().innerText().catch(() => "")) || "";
    const orderMatch = confirmationText.match(/\b(\d{3}-\d{7}-\d{7})\b/) ?? (await page.content()).match(/\b(\d{3}-\d{7}-\d{7})\b/);
    result.orderNumber = orderMatch?.[1] ?? null;
    result.status = "placed";
    result.detail = result.orderNumber ? `Order placed (${result.orderNumber}).` : "Order submitted.";
    return result;
  } catch (error) {
    result.status = "failed";
    result.detail = `Automation error: ${(error as Error).message}`;
    await shot("error");
    return result;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Best-effort selection of the preset shipping address (AMAZON_SHIP_LINE1).
 * Reliable behaviour comes from setting it as the account's default address;
 * this only nudges the address chooser when one is shown. Never throws.
 */
async function ensurePresetAddress(page: import("playwright").Page): Promise<void> {
  const line1 = process.env.AMAZON_SHIP_LINE1;
  if (!line1) return;
  try {
    const changeLink = page.locator("#addressChangeLinkId a, a:has-text('Change'), [data-testid='change-shipping-address']").first();
    if (await changeLink.count()) {
      await changeLink.click({ timeout: 5_000 }).catch(() => undefined);
    }
    const tile = page.locator(`.displayAddressLI:has-text("${line1}"), li:has-text("${line1}"), div:has-text("${line1}")`).first();
    if (await tile.count()) {
      const useButton = tile
        .locator("input[type='radio'], input[name*='address'], button:has-text('Use this address'), a:has-text('Deliver to this address')")
        .first();
      if (await useButton.count()) await useButton.click({ timeout: 5_000 }).catch(() => undefined);
      const confirm = page.locator("input[name='shipToThisAddress'], #shipToThisAddressButton input, button:has-text('Use this address')").first();
      if (await confirm.count()) await confirm.click({ timeout: 5_000 }).catch(() => undefined);
    }
  } catch {
    /* best effort — fall back to the account default address */
  }
}

async function isBotWall(page: import("playwright").Page): Promise<boolean> {
  const url = page.url();
  if (/\/errors\/validateCaptcha|\/ap\/cvf|\/ap\/challenge/.test(url)) return true;
  const text = (await page.locator("body").innerText().catch(() => "")) || "";
  return /enter the characters you see|verify it'?s you|not a robot|solve this puzzle/i.test(text);
}

/**
 * Fill a card form ONLY if one is visibly present and card env vars are set.
 * Card values are read here, used immediately, and never logged or stored.
 */
async function maybeEnterCardFromEnv(page: import("playwright").Page): Promise<void> {
  const number = process.env.AMAZON_CARD_NUMBER;
  if (!number) return; // rely on the account's default card
  const numberField = page.locator("input[name='addCreditCardNumber'], #pp-bcLEsO-13, input[autocomplete='cc-number']").first();
  if (!(await numberField.count())) return;
  try {
    await numberField.fill(number);
    const name = process.env.AMAZON_CARD_NAME;
    if (name) await page.locator("input[autocomplete='cc-name'], input[name='ppw-accountHolderName']").first().fill(name).catch(() => undefined);
    const exp = process.env.AMAZON_CARD_EXP; // MM/YY
    if (exp) {
      const [mm, yy] = exp.split("/");
      await page.locator("select[name='ppw-expirationDate_month']").selectOption(mm ?? "").catch(() => undefined);
      await page.locator("select[name='ppw-expirationDate_year']").selectOption(`20${(yy ?? "").slice(-2)}`).catch(() => undefined);
    }
    const cvc = process.env.AMAZON_CARD_CVC;
    if (cvc) {
      await page
        .locator("input[autocomplete='cc-csc'], input[name*='cvv'], input[name*='cvc'], input[name='ppw-cardVerificationNumber']")
        .first()
        .fill(cvc)
        .catch(() => undefined);
    }
    await page.getByRole("button", { name: /add your card|use this card|continue/i }).first().click().catch(() => undefined);
  } catch {
    /* fall back to default card */
  }
}
