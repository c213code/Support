// Шаблон UI-теста мини-аппа. Копируется в $CLAUDE_JOB_DIR/tmp и запускается
// оттуда: node miniapp-ui-test.mjs. Проверки дописываются в checks().
import { createHmac } from "node:crypto";
import puppeteer from "puppeteer-core";

const TOKEN = process.env.TEST_BOT_TOKEN ?? "123456:FAKE-TEST-TOKEN";
const BASE = process.env.TEST_BASE ?? "http://localhost:3000";
const PATH = process.env.TEST_PATH ?? "/miniapp";
const USER_ID = Number(process.env.TEST_USER_ID ?? 900000001);
const OUT = process.env.CLAUDE_JOB_DIR ? `${process.env.CLAUDE_JOB_DIR}/tmp` : ".";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// initData, подписанная как у Telegram: secret = HMAC("WebAppData", token),
// hash = HMAC(secret, отсортированные key=value через \n).
function signedInitData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAE-test",
    user: JSON.stringify({ id: userId, first_name: "ТЕСТ" }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

// 1×1 PNG — ответ вместо фото из Telegram.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64"
);

let failures = 0;
function expect(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " → " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

async function checks(page) {
  // Пример — заменить проверками под задачу.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  expect("нет горизонтальной прокрутки на 390px", overflow <= 390, overflow);
  const mb = await page.evaluate(() => window.__mb);
  console.log("MainButton:", JSON.stringify(mb));
  await page.screenshot({ path: `${OUT}/miniapp.png`, fullPage: true });
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.startsWith("https://telegram.org/")) {
      req.respond({ status: 200, contentType: "application/javascript", body: "" });
    } else if (url.endsWith("/api/miniapp/photo")) {
      req.respond({ status: 200, contentType: "image/png", body: PNG });
    } else {
      req.continue();
    }
  });
  page.on("pageerror", (err) => console.log("pageerror:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log("console.error:", msg.text());
  });

  await page.evaluateOnNewDocument((initData) => {
    const noop = () => {};
    window.__mb = null;
    window.Telegram = {
      WebApp: {
        initData,
        ready: noop,
        expand: noop,
        close: noop,
        isVersionAtLeast: () => true,
        setHeaderColor: noop,
        setBackgroundColor: noop,
        enableClosingConfirmation: noop,
        disableClosingConfirmation: noop,
        disableVerticalSwipes: noop,
        HapticFeedback: { selectionChanged: noop, impactOccurred: noop, notificationOccurred: noop },
        MainButton: {
          setParams: (p) => (window.__mb = { ...p }),
          showProgress: noop,
          hideProgress: noop,
          hide: () => (window.__mb = { is_visible: false }),
          onClick: noop,
          offClick: noop,
        },
      },
    };
  }, signedInitData(USER_ID));

  await page.goto(`${BASE}${PATH}`, { waitUntil: "networkidle0", timeout: 120000 });
  await checks(page);
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
