import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import https from "https";
import fetch from "node-fetch";

// Create a custom HTTPS agent that ignores SSL errors (for testing)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

dotenv.config();

const logDir = path.join(process.cwd(), "logs");
const logFile =
  process.env.LOG_FILE ||
  path.join(
    logDir,
    `advice_sync_${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
} catch {}
const log = (m: string) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`, "utf8");
  } catch {}
  console.log(m);
};

// Configuration - Update these if needed
const API_URL =
  process.env.API_URL || "https://kweelamin.com/api/admin/sync/advice";
const SYNC_SECRET = process.env.SYNC_SECRET;
// "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXBlIjoib25saW5lIiwiaXNfbWVtYmVyIjpmYWxzZSwiaWF0IjoxNzc1MTAzNDIyLCJleHAiOjE3NzUxMTA2MjJ9.e3V-L4UZQkyIJfOt2Wa4dHz7eRCAgddG6P9rY2E36N8"; // Should match live server's NEXTAUTH_SECRET
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

puppeteer.use(StealthPlugin());

async function syncProducts() {
  log("🚀 Starting Local Advice Scraper...");
  if (!SYNC_SECRET) {
    log("⚠️ WARNING: SYNC_SECRET is not defined in environment variables!");
  } else {
    log(`ℹ️ SYNC_SECRET is defined (length: ${SYNC_SECRET.length})`);
  }

  const userDataDir = path.join(process.cwd(), "chrome_user_data");
  log(`Using user data dir: ${userDataDir}`);

  const launchOptions: any = {
    headless: HEADLESS ? "new" : false,
    userDataDir: userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--window-size=1920,1080",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-blink-features=AutomationControlled", // Mask automation
    ],
    protocolTimeout: 600000, // Increased to 10 minutes
  };

  // Add proxy if configured in env
  if (process.env.FLARESOLVERR_URL) {
    launchOptions.browserWSEndpoint = `${process.env.FLARESOLVERR_URL}`;
  } else if (process.env.PROXY_SERVER) {
    launchOptions.args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
  }

  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(USER_AGENT);

  // Set extra headers to look more like a real browser
  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    "sec-ch-ua":
      '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  });

  try {
    log("Navigating to Advice home page...");
    let homePageSuccess = false;
    let homePageRetries = 0;
    const maxHomePageRetries = 3;
    while (!homePageSuccess && homePageRetries < maxHomePageRetries) {
      try {
        await page.goto("https://www.advice.co.th/", {
          waitUntil: "domcontentloaded",
          timeout: 180000, // 3 minutes timeout
        });
        homePageSuccess = true;
      } catch (err) {
        homePageRetries++;
        log(
          `⚠️ Home page navigation failed (retry ${homePageRetries}/${maxHomePageRetries}): ${err}`,
        );
        if (homePageRetries < maxHomePageRetries) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    if (!homePageSuccess) {
      throw new Error("Failed to load home page after retries");
    }

    // Check if we are still blocked
    let homeTitle = await page.title();
    if (
      homeTitle.includes("Just a moment") ||
      homeTitle.includes("Checking your browser")
    ) {
      log(
        "⏳ Cloudflare challenge detected on home page. Waiting and attempting to look human...",
      );

      // Look human: move mouse and scroll a bit
      for (let i = 0; i < 5; i++) {
        await page.mouse.move(Math.random() * 500, Math.random() * 500);
        await page.evaluate(() => window.scrollBy(0, Math.random() * 200));
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
        homeTitle = await page.title();
        if (!homeTitle.includes("Just a moment")) break;
      }
    }

    log("Navigating to Advice search page...");
    let searchPageSuccess = false;
    let searchPageRetries = 0;
    const maxSearchPageRetries = 3;
    while (!searchPageSuccess && searchPageRetries < maxSearchPageRetries) {
      try {
        await page.goto(
          "https://www.advice.co.th/product/search?keyword=laptop",
          {
            waitUntil: "domcontentloaded",
            timeout: 180000, // 3 minutes timeout
          },
        );
        searchPageSuccess = true;
      } catch (err) {
        searchPageRetries++;
        log(
          `⚠️ Search page navigation failed (retry ${searchPageRetries}/${maxSearchPageRetries}): ${err}`,
        );
        if (searchPageRetries < maxSearchPageRetries) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    if (!searchPageSuccess) {
      throw new Error("Failed to load search page after retries");
    }

    // Wait more for content to be sure
    log("Waiting for search results to load...");
    await new Promise((r) => setTimeout(r, 10000));

    // Debug: Check if page is empty or blocked
    const pageTitle = await page.title();
    log(`Search Page Title: ${pageTitle}`);
    if (
      pageTitle.includes("Just a moment") ||
      pageTitle.includes("Access Denied")
    ) {
      log(
        "❌ Blocked by Cloudflare even locally. Try headful mode (HEADLESS=false).",
      );
      // If we are still blocked, try one more wait
      await new Promise((r) => setTimeout(r, 15000));
      if ((await page.title()).includes("Just a moment")) {
        await page.screenshot({ path: "cloudflare_blocked.png" });
        log("📸 Screenshot saved to cloudflare_blocked.png");
        throw new Error(
          "Cloudflare bypass failed. Try running in headful mode (HEADLESS=false) and solving the challenge manually.",
        );
      }
    }

    // Handle "Show More Products" button if it exists
    let hasMore = true;
    let clickCount = 0;
    const maxClicks = 50;
    const allLinks = new Set<string>();

    const extractLinks = async () => {
      const links = await page.evaluate(() => {
        const foundLinks: string[] = [];
        const notebookKeywords = ["notebook", "laptop", "surface"];
        const excludeKeywords = [
          "accessories",
          "adapter",
          "cooler-pad",
          "battery",
          "case-notebook",
          "bag-notebook",
          "film",
          "backpack",
          "sleeve",
          "cleaning",
          "smartphone",
          "compare",
          "optical-disk-drive",
          "tray-dvd",
        ];

        // Focus on product card links specifically
        const selectors = [
          '.product-card a[href*="/product/"]',
          '.product-item a[href*="/product/"]',
          'a[href*="/product/notebook/"]',
          'a[href*="/product/"]',
          ".thumbnail a",
          ".img-product a",
          ".product-name a",
          ".product-image a",
        ];

        const elements = new Set<HTMLAnchorElement>();
        selectors.forEach((sel) => {
          document
            .querySelectorAll(sel)
            .forEach((el) => elements.add(el as HTMLAnchorElement));
        });

        // Fallback to all links if selectors find nothing
        if (elements.size === 0) {
          document
            .querySelectorAll("a")
            .forEach((el) => elements.add(el as HTMLAnchorElement));
        }

        elements.forEach((a) => {
          try {
            const href = a.href;
            if (!href) return;

            const lowerHref = href.toLowerCase();
            const text = (a.innerText || a.textContent || "").toLowerCase();

            // Check if it's a product link
            const isProduct =
              lowerHref.includes("/product/") &&
              !lowerHref.includes("search?keyword=");
            if (!isProduct) return;

            // STRONGER notebook check: must have notebook/laptop/surface in URL OR text
            const isNotebook =
              notebookKeywords.some((k) => lowerHref.includes(k)) ||
              notebookKeywords.some((k) => text.includes(k));

            if (isNotebook) {
              if (
                !excludeKeywords.some(
                  (k) => lowerHref.includes(k) || text.includes(k),
                )
              ) {
                const hasThaiExclude =
                  text.includes("กระเป๋า") ||
                  text.includes("ซองใส่") ||
                  text.includes("ฟิล์ม") ||
                  text.includes("สายชาร์จ") ||
                  text.includes("แบตเตอรี่");

                if (!hasThaiExclude) {
                  foundLinks.push(href);
                }
              }
            }
          } catch (e) {}
        });
        return Array.from(new Set(foundLinks));
      });
      const before = allLinks.size;
      links.forEach((l) => allLinks.add(l));
      const after = allLinks.size;
      if (after > before) {
        // We can't use log() here as it's not defined in page.evaluate context, but we are in the main process
      }
      return after - before;
    };

    // Extract initial links
    await extractLinks();
    log(`Initial links found: ${allLinks.size}`);

    if (allLinks.size === 0) {
      log("⚠️ No links found initially. Taking a debug screenshot...");
      await page.screenshot({ path: "local_debug_no_links.png" });
      log("Saved local_debug_no_links.png. Please check it.");
    }

    log("Starting 'Show More' loop...");
    try {
      while (clickCount < maxClicks && hasMore) {
        // More aggressive auto-scroll to trigger lazy-loaded buttons or items
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await new Promise((r) => setTimeout(r, 800));
        }
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await new Promise((r) => setTimeout(r, 1500));

        log(`Checking for 'Show More Products' button (${clickCount + 1})...`);

        // Find the button using more selectors and robust check
        const buttonSelectors = [
          ".showproduct-more",
          ".btn-show-more",
          ".btn-load-more",
          ".load-more-btn",
          ".btn-more-product",
          ".btn-showmore",
          "[class*='show-more']",
          "[class*='load-more']",
        ];

        let clicked = false;
        try {
          for (const selector of buttonSelectors) {
            const btn = await page.$(selector);
            if (btn) {
              const isVisible = await page.evaluate((el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                return (
                  style &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  (el as HTMLElement).offsetWidth > 0 &&
                  (el as HTMLElement).offsetHeight > 0
                );
              }, btn);

              if (isVisible) {
                await btn.scrollIntoView();
                await new Promise((r) => setTimeout(r, 1000));
                await btn.click();
                clicked = true;
                log(`Clicked button with selector: ${selector}`);
                break;
              }
            }
          }

          // Fallback to text search if no selector worked
          if (!clicked) {
            const textBtn = await page.evaluateHandle(() => {
              const buttons = Array.from(
                document.querySelectorAll(
                  "button, a, div.btn, div.button, span.btn",
                ),
              );
              const targetTexts = [
                "แสดงเพิ่ม",
                "ดูเพิ่มเติม",
                "SHOW MORE",
                "LOAD MORE",
                "แสดงสินค้าเพิ่ม",
                "ดูสินค้าเพิ่มเติม",
              ];
              return buttons.find((b) => {
                const text = (b.textContent || "").toUpperCase().trim();
                const style = window.getComputedStyle(b);
                const isVisible =
                  style &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  (b as HTMLElement).offsetWidth > 0 &&
                  (b as HTMLElement).offsetHeight > 0;
                return isVisible && targetTexts.some((t) => text.includes(t));
              });
            });

            if (textBtn) {
              const element = textBtn.asElement() as any;
              if (element) {
                await element.scrollIntoView();
                await new Promise((r) => setTimeout(r, 1000));
                await element.click();
                clicked = true;
                log("Clicked button by text content fallback");
              }
            }
          }
        } catch (loopErr) {
          log(`⚠️ Error in 'Show More' click attempt: ${loopErr}`);
          // Don't throw, just try to continue or break
        }

        if (clicked) {
          log(
            `Click ${clickCount + 1} successful! Waiting for items to load...`,
          );
          await new Promise((r) => setTimeout(r, 8000));
          const newLinksFound = await extractLinks();
          log(
            `After click ${clickCount + 1}, total unique links: ${allLinks.size} (New in this step: ${newLinksFound})`,
          );
          clickCount++;
        } else {
          // One final aggressive scroll to see if it triggers something
          log("Button not found, trying one final aggressive scroll...");
          for (let i = 0; i < 3; i++) {
            await page.evaluate(() => window.scrollBy(0, -500));
            await new Promise((r) => setTimeout(r, 300));
            await page.evaluate(() =>
              window.scrollTo(0, document.body.scrollHeight),
            );
            await new Promise((r) => setTimeout(r, 1000));
          }

          const finalLinksCheck = await extractLinks();
          if (finalLinksCheck === 0) {
            log(
              "No visible 'Show More' button found and no new links found after aggressive scroll.",
            );
            hasMore = false;
          } else {
            log(
              `Found ${finalLinksCheck} new links after final scroll, continuing...`,
            );
          }
        }
      }
    } catch (e) {
      log(`Stopping 'Show More' loop due to error: ${String(e)}`);
    }

    const productLinks = Array.from(allLinks);
    log(`Found ${productLinks.length} total notebook links.`);

    const scrapedData: any[] = [];
    const batchSize = 5;

    for (let i = 0; i < productLinks.length; i += batchSize) {
      const batch = productLinks.slice(i, i + batchSize);
      log(
        `Scraping batch ${Math.floor(i / batchSize) + 1} / ${Math.ceil(productLinks.length / batchSize)}...`,
      );

      const batchPromises = batch.map(async (link) => {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent(USER_AGENT);
        await detailPage.setViewport({ width: 1920, height: 1080 });

        try {
          let success = false;
          let retryCount = 0;
          const maxRetries = 3;

          while (retryCount < maxRetries && !success) {
            try {
              await detailPage.goto(link, {
                waitUntil: "domcontentloaded",
                timeout: 180000, // 3 minutes timeout
              });
              success = true;
            } catch (err) {
              retryCount++;
              log(`⚠️ Retry ${retryCount}/${maxRetries} for ${link}: ${err}`);
              await new Promise((r) => setTimeout(r, 5000));
            }
          }

          if (!success) {
            log(`❌ Failed to load ${link} after ${maxRetries} retries.`);
            return;
          }

          await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));

          const data = await detailPage.evaluate(() => {
            const name =
              document.querySelector(".product-name")?.textContent?.trim() ||
              document.querySelector("h1")?.textContent?.trim() ||
              "";

            // Re-verify name doesn't contain accessory keywords
            const lowerName = name.toLowerCase();
            const excludeKeywords = [
              "กระเป๋า",
              "ซองใส่",
              "ฟิล์ม",
              "backpack",
              "sleeve",
              "cleaning",
              "case",
              "film",
              "bag",
            ];
            if (excludeKeywords.some((k) => lowerName.includes(k))) {
              return null; // Skip this item
            }

            // Extract SKU from the page to filter correct images
            const bodyText = document.body.innerText;
            const skuMatch =
              bodyText.match(
                /(?:Product Code|รหัสสินค้า)\s*:\s*([A-Z0-9]+)/i,
              ) || bodyText.match(/SKU\s*:\s*([A-Z0-9]+)/i);
            let sku = skuMatch ? skuMatch[1] : "";

            if (!sku) {
              const mainImg = document.querySelector<HTMLImageElement>(
                ".product-main-image img, .img-product, [data-zoom-image]",
              );
              const mainSrc =
                (mainImg && typeof mainImg.src === "string" && mainImg.src) ||
                (mainImg && mainImg.getAttribute("data-zoom-image")) ||
                "";
              const urlMatch = mainSrc.match(/pic_product\d+\/([A-Z0-9]+)\//);
              if (urlMatch) sku = urlMatch[1];
            }

            // Identify both original price and sale price using more robust selectors
            const buyBox = document.querySelector(
              ".d-add-cart-2, .product-price-info, .product-detail-buy, .item-price, .product-detail-price, .item-product-info, [class*='price-container']",
            );
            const mainInfo =
              document.querySelector(
                ".product-detail-info, .product-info-top, .product-detail-container",
              ) || document.body;

            // 1. Look for prices in the buy box first (highest priority)
            let salePriceEl = buyBox?.querySelector(
              ".item-price-sale, .d-add-cart-item-price, .product-price .price-special, .new-price, .price-sale, .special-price, .price-online, .sale-price, [class*='price-special'], [class*='price-sale'], [class*='price-online']",
            );
            let originalPriceEl = buyBox?.querySelector(
              ".item-price-srp del, .list-installment-price-1, .price-before, strike, del, .old-price, .price-normal, [class*='price-before'], [class*='old-price']",
            );

            // 2. Fallback to main info but EXPLICITLY EXCLUDE swiper slides
            if (!salePriceEl || !originalPriceEl) {
              const allPossiblePrices = Array.from(
                mainInfo.querySelectorAll(
                  ".item-price-sale, .item-price-srp del, .d-add-cart-item-price, .list-installment-price-1, .price-before, strike, del, .price-online, .price-special, .special-price, .price-normal, [class*='price-special'], [class*='price-sale'], [class*='price-before'], [class*='old-price'], [class*='price-online']",
                ),
              );

              const filtered = allPossiblePrices.filter((el) => {
                // Ignore elements that are part of related product sections
                return (
                  !el.closest(".swiper-slide") &&
                  !el.closest(".swiperContainerProductRec") &&
                  !el.closest(".product-relate") &&
                  !el.closest(".product-recommend") &&
                  !el.closest(".product-compare")
                );
              });

              if (!salePriceEl) {
                salePriceEl = filtered.find(
                  (el) =>
                    el.classList.contains("item-price-sale") ||
                    el.classList.contains("d-add-cart-item-price") ||
                    el.className.includes("price-special") ||
                    el.className.includes("price-sale") ||
                    el.className.includes("sale-price") ||
                    el.className.includes("price-online"),
                );
              }
              if (!originalPriceEl) {
                originalPriceEl = filtered.find(
                  (el) =>
                    el.tagName === "DEL" ||
                    el.tagName === "STRIKE" ||
                    el.classList.contains("list-installment-price-1") ||
                    el.classList.contains("item-price-srp") ||
                    el.className.includes("price-before") ||
                    el.className.includes("old-price") ||
                    el.closest(".item-price-srp"),
                );
              }
            }

            // 3. Last resort: Try to find price via JSON-LD
            let ldPrice = 0;
            let ldOriginalPrice = 0;
            try {
              const ldScripts = document.querySelectorAll(
                'script[type="application/ld+json"]',
              );
              for (const script of Array.from(ldScripts)) {
                const json = JSON.parse(script.textContent || "{}");
                if (json["@type"] === "Product" && json.offers) {
                  const offers = Array.isArray(json.offers)
                    ? json.offers[0]
                    : json.offers;
                  if (offers.price) ldPrice = parseFloat(offers.price);
                  break;
                }
              }
            } catch (e) {}

            // Thai price extraction helpers
            const extractPrice = (text: string) => {
              const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
              return match ? parseFloat(match[0]) : 0;
            };

            let originalPriceText = originalPriceEl?.textContent?.trim() || "";
            let salePriceText = salePriceEl?.textContent?.trim() || "0";

            // If selectors fail, try searching by text content (Thai keywords)
            const getPriceFromText = (
              container: Element,
              keywords: string[],
            ) => {
              const allElements = Array.from(
                container.querySelectorAll(
                  "div, span, p, font, b, strong, strike, del",
                ),
              );
              const node = allElements.find((el) => {
                const isRelated =
                  el.closest(".swiper-slide") &&
                  (el.closest(".swiperContainerProductRec") ||
                    el.closest(".product-relate") ||
                    el.closest(".product-recommend"));
                if (isRelated) return false;

                const text = el.textContent || "";
                return keywords.some((k) => text.includes(k));
              });

              if (node) {
                const text = node.textContent || "";
                const match = text.match(/[0-9,.]+/);
                return match ? match[0] : "";
              }
              return "";
            };

            if (!originalPriceText || originalPriceText === "0") {
              originalPriceText = getPriceFromText(mainInfo, [
                "ราคาปกติ",
                "Normal Price",
                "MSRP",
                "ราคา SRP",
              ]);
            }

            if (!salePriceText || salePriceText === "0") {
              salePriceText = getPriceFromText(mainInfo, [
                "ราคาพิเศษ",
                "Special Price",
                "ราคาออนไลน์",
                "Online Price",
                "Member Price",
                "ราคาปัจจุบัน",
              ]);
            }

            const rawOriginal = extractPrice(originalPriceText);
            const rawSale = extractPrice(salePriceText);

            // Calculate original price from discount badge if needed
            let calculatedOriginal = rawOriginal;
            if ((!rawOriginal || rawOriginal === 0) && rawSale > 0) {
              const discountBadge = document.querySelector(
                ".product-detail-discount-badge, [class*='discount-badge'], .item-badge-discount, .badge-save-price, .discount-badge",
              );
              const discountText = discountBadge?.textContent?.trim() || "";
              const discountMatch = discountText.match(
                /-(?:฿|THB)?\s*([0-9,.]+)/i,
              );
              if (discountMatch) {
                const discountAmt = extractPrice(discountMatch[1]);
                calculatedOriginal = rawSale + discountAmt;
              }
            }

            let price = rawSale > 0 ? rawSale : ldPrice;
            let salePrice: number | null = null;

            const finalOriginal = Math.max(
              rawOriginal,
              calculatedOriginal,
              ldOriginalPrice,
            );

            // If we found a higher original price, set it as 'price' and current as 'salePrice'
            if (finalOriginal > 0 && price > 0 && finalOriginal > price) {
              salePrice = price;
              price = finalOriginal;
            } else if (finalOriginal > 0 && (price === 0 || isNaN(price))) {
              price = finalOriginal;
              salePrice = null;
            } else {
              // price remains rawSale or ldPrice
              salePrice = null;
            }

            const specRows = Array.from(document.querySelectorAll("tr")).filter(
              (tr) =>
                (tr.querySelector("th") ||
                  tr.querySelector("td:first-child")) &&
                (tr.querySelector("td:last-child") ||
                  tr.querySelectorAll("td").length > 1),
            );
            const specs = specRows
              .map((row) => ({
                label:
                  row
                    .querySelector("th, td:first-child")
                    ?.textContent?.trim() || "",
                value:
                  row.querySelector("td:last-child")?.textContent?.trim() || "",
              }))
              .filter((s) => s.label && s.value);

            // Extract Features (Free Gifts etc)
            const features: string[] = [];
            const featureSelectors = [
              ".product-features li",
              ".free-gift-item",
              ".product-gift li",
              ".promotion-detail li",
              ".product-benefit li",
            ];
            featureSelectors.forEach((sel) => {
              document.querySelectorAll(sel).forEach((item) => {
                const text = item.textContent?.trim();
                if (text && !features.includes(text)) features.push(text);
              });
            });

            const imageSet = new Set<string>();

            // Priority 1: Swiper/Gallery images
            const galleryElements = document.querySelectorAll(
              ".swiper-slide img, .product-image-thumbnail img, .product-gallery img, .product-main-image img, .img-product, [data-zoom-image]",
            );

            galleryElements.forEach((img: any) => {
              let src =
                img.src ||
                img.getAttribute("data-src") ||
                img.getAttribute("data-zoom-image") ||
                "";

              if (
                src &&
                src.includes("pic_product") &&
                !src.includes("undefined")
              ) {
                // Ensure URL is absolute
                if (src.startsWith("//")) src = "https:" + src;
                else if (src.startsWith("/"))
                  src = "https://www.advice.co.th" + src;
                else if (!src.startsWith("http"))
                  src = "https://www.advice.co.th/" + src;

                if (sku) {
                  if (src.includes(`/${sku}/`)) {
                    imageSet.add(src);
                  }
                } else {
                  imageSet.add(src);
                }
              }
            });

            // Convert to array and prioritize better quality/main images
            let images = Array.from(imageSet);

            // Sort to put better quality/main images first
            images.sort((a, b) => {
              const aBig = a.includes("BIG") || a.includes("OK") ? 1 : 0;
              const bBig = b.includes("BIG") || b.includes("OK") ? 1 : 0;

              if (aBig !== bBig) return bBig - aBig;

              const aIdx = a.match(/_([0-9])\.jpg/)?.[1] || "9";
              const bIdx = b.match(/_([0-9])\.jpg/)?.[1] || "9";
              return parseInt(aIdx) - parseInt(bIdx);
            });

            // Final filter: ensure we don't have too many and they are unique
            images = Array.from(new Set(images)).slice(0, 10);

            // Stock detection: Check for "Add to Cart" button or "Out of Stock" text
            const hasBuyBtn = !!document.querySelector(
              ".btn-add-cart, .btn-buy, .add-to-cart",
            );
            const bodyInner = document.body.innerText;
            const outOfStock =
              bodyInner.includes("สินค้าหมด") ||
              bodyInner.includes("Out of stock") ||
              !hasBuyBtn;
            const stock = outOfStock ? 0 : 99; // Simple stock representation

            return {
              name,
              price,
              salePrice,
              specs,
              features,
              stock,
              images: JSON.stringify(images),
            };
          });

          if (data && data.name && data.price > 0) {
            scrapedData.push(data);
            log(
              `✅ Scraped: ${data.name} - ฿${data.price} (Sale: ${data.salePrice || "None"})`,
            );
          }
        } catch (err) {
          log(`❌ Error scraping ${link}: ${String(err)}`);
        } finally {
          await detailPage.close();
        }
      });

      await Promise.all(batchPromises);

      // Wait between batches
      if (i + batchSize < productLinks.length) {
        log(`⏳ Waiting between batches...`);
        await new Promise((r) => setTimeout(r, 5000 + Math.random() * 5000));
      }
    }

    log(`🎉 Scraping complete! Scraped ${scrapedData.length} products.`);

    // Local Backup Storage Setup
    const dataDir = path.join(process.cwd(), "data");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(dataDir, `scraped_data_${timestamp}.json`);

    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(
        backupFile,
        JSON.stringify(scrapedData, null, 2),
        "utf8",
      );
      log(`💾 Local backup saved to: ${backupFile}`);
    } catch (backupErr) {
      log(`⚠️ Failed to save local backup: ${backupErr}`);
    }

    if (scrapedData.length === 0) {
      log(
        "❌ No products were scraped. Skipping upload to prevent data loss on the live server.",
      );
      return;
    }

    log(`📤 Uploading data to live server (${API_URL})...`);

    const uploadChunkWithRetry = async (chunk: any[], retries = 3) => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          log(`Attempt ${attempt} to upload data...`);
          if (typeof fetch === "undefined") {
            throw new Error(
              "fetch is not available. Please use Node.js 18+ or install node-fetch.",
            );
          }

          const body = JSON.stringify({
            products: chunk,
            categoryName: "Notebook",
          });
          log(`   Payload size: ${(body.length / 1024).toFixed(2)} KB`);

          // Use timeout option for node-fetch v2 instead of AbortController
          const fetchOptions: any = {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-sync-secret": SYNC_SECRET || "",
              "User-Agent": USER_AGENT,
            },
            body: body,
            timeout: 300000, // 5 minutes timeout
          };

          const response = await fetch(API_URL, fetchOptions);

          let result;
          try {
            result = await response.json();
          } catch (parseErr) {
            const text = await response.text();
            log(`⚠️ Failed to parse JSON response. Response text: ${text}`);
            throw parseErr;
          }

          if (response.ok) {
            log(`✨ Chunk Success: ${result.message}`);
            return true;
          } else {
            log(`❌ Chunk Upload Failed: ${result.error || "Unknown error"}`);
            log(
              `   Response status: ${response.status} ${response.statusText}`,
            );
            if (response.status >= 500) {
              log(`   Server error, might retry...`);
            } else {
              return false;
            }
          }
        } catch (fetchErr) {
          log(`💥 Chunk Attempt ${attempt} failed: ${fetchErr}`);
          if (attempt === retries) throw fetchErr;
          log(`   Waiting before next attempt...`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      return false;
    };

    const uploadBatchSize = 1;
    let totalSynced = 0;

    try {
      for (let i = 0; i < scrapedData.length; i += uploadBatchSize) {
        const chunk = scrapedData.slice(i, i + uploadBatchSize);
        log(
          `Uploading chunk ${Math.floor(i / uploadBatchSize) + 1} of ${Math.ceil(scrapedData.length / uploadBatchSize)} (${chunk.length} products)...`,
        );
        const success = await uploadChunkWithRetry(chunk, 3);
        if (success) {
          totalSynced += chunk.length;
        } else {
          log(`⚠️ Failed to upload chunk starting at index ${i}`);
        }
      }
      log(`✅ Upload complete! Total products synced: ${totalSynced}`);
    } catch (finalErr) {
      log(`💥 Final upload error: ${finalErr}`);
    }
  } catch (error) {
    log(`💥 Sync failed: ${String(error)}`);
    if (error instanceof Error && error.stack) {
      log(`   Stack trace: ${error.stack}`);
    }
  } finally {
    await browser.close();
    log("👋 Done!");
  }
}

syncProducts();
