import puppeteer from "puppeteer-extra";
import type { ConsoleMessage } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

puppeteer.use(StealthPlugin());

const prisma = new PrismaClient();

const progressPath = path.join(
  process.cwd(),
  "public",
  "config",
  "sync_advice.json",
);

function ensureProgressDir() {
  const dir = path.join(process.cwd(), "public", "config");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeProgress(payload: Record<string, unknown>) {
  try {
    ensureProgressDir();
    const enriched = {
      ...payload,
      lastUpdate: new Date().toISOString(),
    };
    fs.writeFileSync(progressPath, JSON.stringify(enriched, null, 2), "utf-8");
    const percent = ((payload.percent as number) || 0) * 100;
    const status = (payload.status as string) || "unknown";
    console.log("Progress written:", status, `${Math.round(percent)}%`);
  } catch (error) {
    console.error("Failed to write progress:", error);
  }
}

async function syncProducts() {
  // Try different browser paths
  const possiblePaths = [
    undefined, // Let Puppeteer use its bundled Chrome
    "/usr/bin/google-chrome-stable", // System Chrome
    "/usr/bin/chromium-browser", // System Chromium
    "/usr/bin/chromium", // Alternative Chromium path
    "/usr/bin/chromium", // Another Chromium path
    "/snap/bin/chromium", // Snap Chromium
    "/usr/bin/google-chrome", // Alternative Chrome path
  ];

  let browser;
  let lastError;

  for (const executablePath of possiblePaths) {
    try {
      console.log(
        `Trying browser path: ${executablePath || "Puppeteer bundled Chrome"}`,
      );
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-default-apps",
          "--disable-popup-blocking",
          "--disable-translate",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
        ],
        protocolTimeout: 300000,
        executablePath,
      });
      console.log(
        `Successfully launched with: ${executablePath || "Puppeteer bundled Chrome"}`,
      );
      break; // Success, exit the loop
    } catch (error) {
      console.log(
        `Failed with ${executablePath || "Puppeteer bundled Chrome"}: ${error}`,
      );
      lastError = error;
      continue; // Try next path
    }
  }

  if (!browser) {
    throw lastError || new Error("Failed to launch any browser");
  }
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );

  try {
    writeProgress({
      status: "starting",
      percent: 0,
      total: 0,
      processed: 0,
      message: "Initializing Advice sync",
      startedAt: new Date().toISOString(),
    });
    // Get or create Notebook category
    let category = await prisma.category.findFirst({
      where: { name: "Notebook" },
    });

    if (!category) {
      category = await prisma.category.create({
        data: { name: "Notebook" },
      });
    }

    // Cleanup products with old format specifications to ensure consistency
    console.log("Checking for products with old specification format...");
    const products = await prisma.product.findMany({
      where: { categoryId: category.id },
    });

    const oldOnes = products.filter((p) => {
      if (!p.specifications) return true;
      try {
        const parsed = JSON.parse(p.specifications);
        return !Array.isArray(parsed);
      } catch {
        return true;
      }
    });

    if (oldOnes.length > 0) {
      console.log(
        `Deleting ${oldOnes.length} products with old specification format...`,
      );
      await prisma.product.deleteMany({
        where: { id: { in: oldOnes.map((o) => o.id) } },
      });
    }

    console.log("Navigating to Advice search page...");
    let searchNavSuccess = false;
    let searchRetryCount = 0;
    const maxSearchRetries = 3;

    // Go to homepage first to establish cookies/session like local_advice_sync.ts does
    try {
      console.log("Establishing session via Advice home page...");
      await page.goto("https://www.advice.co.th/", {
        waitUntil: ["domcontentloaded", "networkidle2"],
        timeout: 60000,
      });
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      console.log("Home page navigation failed, but continuing to search...");
    }

    while (searchRetryCount < maxSearchRetries && !searchNavSuccess) {
      try {
        await page.goto(
          "https://www.advice.co.th/product/search?keyword=laptop",
          {
            waitUntil: ["domcontentloaded", "networkidle2"],
            timeout: 90000, // Increased to 90 seconds
          },
        );
        searchNavSuccess = true;
      } catch (e) {
        searchRetryCount++;
        console.log(
          `Search page navigation retry ${searchRetryCount}/${maxSearchRetries}... Error: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (searchRetryCount < maxSearchRetries) {
          await new Promise((r) => setTimeout(r, 5000));
        } else {
          throw e; // Final attempt failed
        }
      }
    }

    // Wait more for content to be sure
    console.log("Waiting for search results to load...");
    await new Promise((r) => setTimeout(r, 10000));

    // Debug: Take screenshot and save HTML
    await page.screenshot({ path: "sync_debug.png" });
    const currentHtml = await page.content();
    fs.writeFileSync("sync_debug.html", currentHtml);
    console.log("Saved debug screenshot and HTML.");

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
        console.log(`Extracted ${after - before} new links. Total: ${after}`);
      }
      return after - before;
    };

    // Extract initial links
    await extractLinks();
    writeProgress({
      status: "running",
      percent: 0,
      total: allLinks.size,
      processed: 0,
      message: "Scanning Advice links",
    });

    console.log("Starting 'Show More' loop...");
    try {
      while (clickCount < maxClicks && hasMore) {
        // More aggressive auto-scroll to trigger lazy-loaded buttons or items
        // We do this OUTSIDE evaluate for some parts to avoid Protocol errors
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await new Promise((r) => setTimeout(r, 800));
        }
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await new Promise((r) => setTimeout(r, 1500));

        console.log(
          `Checking for 'Show More Products' button (${clickCount + 1})...`,
        );

        // Find the button using page.$$ or page.$ instead of evaluate to avoid context issues
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
              await new Promise((r) => setTimeout(r, 500));
              await btn.click();
              clicked = true;
              console.log(`Clicked button with selector: ${selector}`);
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
              await new Promise((r) => setTimeout(r, 500));
              await element.click();
              clicked = true;
              console.log("Clicked button by text content fallback");
            }
          }
        }

        if (clicked) {
          console.log(
            `Click ${clickCount + 1} successful! Waiting for items to load...`,
          );
          await new Promise((r) => setTimeout(r, 8000));
          const newLinksFound = await extractLinks();
          console.log(
            `After click ${clickCount + 1}, total unique links: ${allLinks.size} (New in this step: ${newLinksFound})`,
          );
          clickCount++;
        } else {
          // One final aggressive scroll to see if it triggers something
          console.log(
            "Button not found, trying one final aggressive scroll...",
          );
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
            console.log(
              "No visible 'Show More' button found and no new links found after aggressive scroll.",
            );
            hasMore = false;
          } else {
            console.log(
              `Found ${finalLinksCheck} new links after final scroll, continuing...`,
            );
          }
        }
      }
    } catch (e) {
      console.log("Stopping 'Show More' loop due to error:", e);
    }

    const productLinks = Array.from(allLinks);
    console.log(`Found ${productLinks.length} unique notebook links.`);

    // Scrape all found links (remove the 50 limit to get all 355+)
    const linksToScrape = productLinks;
    console.log(`Starting to scrape ${linksToScrape.length} products...`);
    let processed = 0;
    const total = linksToScrape.length;
    const scrapedNames = new Set<string>();
    writeProgress({
      status: "running",
      percent: total ? processed / total : 0,
      total,
      processed,
      message: "Scraping products",
    });

    const batchSize = 5;
    for (let i = 0; i < linksToScrape.length; i += batchSize) {
      const batch = linksToScrape.slice(i, i + batchSize);
      console.log(
        `Scraping batch ${Math.floor(i / batchSize) + 1} / ${Math.ceil(linksToScrape.length / batchSize)}...`,
      );

      const batchPromises = batch.map(async (link) => {
        const detailPage = await browser.newPage();
        await detailPage.setViewport({ width: 1920, height: 1080 });
        await detailPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        );

        try {
          console.log(`Scraping detail: ${link}`);

          // Forward browser console to terminal for debugging
          detailPage.on("console", (msg: ConsoleMessage) => {
            const text = msg.text();
            if (text.includes("[DEBUG]")) {
              console.log(text);
            }
          });

          let retryCount = 0;
          let success = false;
          while (retryCount < 3 && !success) {
            try {
              await detailPage.goto(link, {
                waitUntil: ["domcontentloaded", "networkidle2"],
                timeout: 90000, // Increased to 90 seconds
              });
              success = true;
            } catch (e) {
              retryCount++;
              console.log(
                `Retry ${retryCount} for ${link}... Error: ${e instanceof Error ? e.message : String(e)}`,
              );
              await new Promise((r) =>
                setTimeout(r, 5000 + Math.random() * 5000),
              );
            }
          }

          if (!success) {
            console.error(`Skipping ${link} after 3 failed attempts.`);
            return;
          }

          // Random wait between 2-5 seconds
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
            // Advice usually has "Product Code : AXXXXXXX" or similar
            const bodyText = document.body.innerText;
            const skuMatch =
              bodyText.match(
                /(?:Product Code|รหัสสินค้า)\s*:\s*([A-Z0-9]+)/i,
              ) || bodyText.match(/SKU\s*:\s*([A-Z0-9]+)/i);
            let sku = skuMatch ? skuMatch[1] : "";

            // If not found in text, try to get it from the main image URL
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

            // Dismiss any floating popups or cookie banners that might block elements
            const dismissButtons = document.querySelectorAll(
              'button[id*="secondaryButton"], button[class*="close"], .btn-close, .modal-close',
            );
            dismissButtons.forEach((btn) => (btn as HTMLElement).click());

            // Identify both original price and sale price using more robust selectors
            // IMPORTANT: Scope to main product area to avoid picking up related products
            // Target the main price area (usually in the buy box)
            const buyBox = document.querySelector(
              ".d-add-cart-2, .product-price-info, .product-detail-buy",
            );
            const mainInfo =
              document.querySelector(
                ".product-detail-info, .product-info-top",
              ) || document.body;

            // 1. Look for prices in the buy box first (highest priority)
            let salePriceEl = buyBox?.querySelector(
              ".d-add-cart-item-price, .item-price-sale, .product-price .price-special, .new-price, .price-sale, .special-price, .price-online, .sale-price, [class*='price-special'], [class*='price-sale']",
            );
            let originalPriceEl = buyBox?.querySelector(
              ".list-installment-price-1, .item-price-srp del, .price-before, strike, del, .old-price, .price-normal, [class*='price-before'], [class*='old-price']",
            );

            // 2. Fallback to main info but EXPLICITLY EXCLUDE swiper slides
            if (!salePriceEl || !originalPriceEl) {
              const allPossiblePrices = Array.from(
                mainInfo.querySelectorAll(
                  ".item-price-sale, .item-price-srp del, .d-add-cart-item-price, .list-installment-price-1, .price-before, strike, del, .price-online, .price-special, .special-price, .price-normal",
                ),
              );

              const filtered = allPossiblePrices.filter((el) => {
                // Ignore elements that are part of related product sections
                return (
                  !el.closest(".swiper-slide") &&
                  !el.closest(".swiperContainerProductRec") &&
                  !el.closest(".product-relate") &&
                  !el.closest(".product-recommend")
                );
              });

              if (!salePriceEl) {
                salePriceEl = filtered.find(
                  (el) =>
                    el.classList.contains("item-price-sale") ||
                    el.classList.contains("d-add-cart-item-price"),
                );
              }
              if (!originalPriceEl) {
                originalPriceEl = filtered.find(
                  (el) =>
                    el.tagName === "DEL" ||
                    el.tagName === "STRIKE" ||
                    el.classList.contains("list-installment-price-1") ||
                    el.classList.contains("item-price-srp") ||
                    el.classList.contains("price-before"),
                );
              }
            }

            let originalPriceText = originalPriceEl?.textContent?.trim() || "";
            let salePriceText = salePriceEl?.textContent?.trim() || "0";

            // If selectors fail, try searching by text content (Thai keywords)
            // ONLY within the main container and excluding related items
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
                // Ignore elements that are part of related product sections
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
                const match = node.textContent?.match(/[0-9,]+/);
                return match ? match[0] : "";
              }
              return "";
            };

            if (!originalPriceText || originalPriceText === "0") {
              originalPriceText = getPriceFromText(mainInfo, [
                "ราคาปกติ",
                "Normal Price",
                "MSRP",
              ]);
            }

            if (!salePriceText || salePriceText === "0") {
              salePriceText = getPriceFromText(mainInfo, [
                "ราคาพิเศษ",
                "Special Price",
                "ราคาออนไลน์",
                "Member Price",
              ]);
            }

            const rawOriginal = parseFloat(
              originalPriceText.replace(/[^0-9.]/g, ""),
            );
            const rawSale = parseFloat(salePriceText.replace(/[^0-9.]/g, ""));

            // Calculate original price from discount badge if needed
            let calculatedOriginal = rawOriginal;
            if ((!rawOriginal || rawOriginal === 0) && rawSale > 0) {
              const discountBadge = document.querySelector(
                ".product-detail-discount-badge, [class*='discount-badge'], .item-badge-discount, .badge-save-price",
              );
              const discountText = discountBadge?.textContent?.trim() || "";
              const discountMatch = discountText.match(
                /-(?:฿|THB)?\s*([0-9,]+)/i,
              );
              if (discountMatch) {
                const discountAmt = parseFloat(
                  discountMatch[1].replace(/[^0-9.]/g, ""),
                );
                calculatedOriginal = rawSale + discountAmt;
                console.log(
                  `[DEBUG]   Calculated original from badge: ${rawSale} + ${discountAmt} = ${calculatedOriginal}`,
                );
              }
            }

            // DEBUG LOGS (will be captured in terminal/child process)
            console.log(`[DEBUG] ${name}`);
            console.log(
              `[DEBUG]   Original Element Found: ${!!originalPriceEl} ("${originalPriceText}") -> ${rawOriginal}`,
            );
            console.log(
              `[DEBUG]   Sale Element Found: ${!!salePriceEl} ("${salePriceText}") -> ${rawSale}`,
            );

            let price = rawSale;
            let salePrice: number | null = null;

            // Advice logic: if we have a higher 'original' price, then 'sale' is the current price.
            // But we store the higher one in 'price' and the lower one in 'salePrice' for our UI logic.
            const finalOriginal = Math.max(rawOriginal, calculatedOriginal);
            if (finalOriginal > 0 && rawSale > 0 && finalOriginal > rawSale) {
              price = finalOriginal;
              salePrice = rawSale;
            } else if (finalOriginal > 0 && (rawSale === 0 || isNaN(rawSale))) {
              price = finalOriginal;
              salePrice = null;
            } else {
              price = rawSale;
              salePrice = null;
            }

            // Capture all relevant product images
            const imageSet = new Set<string>();

            // Priority 1: Swiper/Gallery images which are usually the correct product images
            const galleryElements = document.querySelectorAll(
              ".swiper-slide img, .product-image-thumbnail img, .product-gallery img, .product-main-image img, .img-product, .gallery-item img",
            );

            galleryElements.forEach((img) => {
              const src =
                (img as HTMLImageElement).src ||
                (img as HTMLImageElement).getAttribute("data-src") ||
                (img as HTMLImageElement).dataset.src ||
                "";
              if (
                src &&
                src.includes("pic_product") &&
                !src.includes("undefined")
              ) {
                // If we have an SKU, only add images that belong to this SKU
                if (sku) {
                  if (src.includes(`/${sku}/`)) {
                    imageSet.add(src);
                  }
                } else {
                  const isRelated =
                    img.closest(".product-relate") ||
                    img.closest(".product-recommend") ||
                    img.closest(".product-compare") ||
                    img.closest(".sidebar") ||
                    img.closest(".footer");
                  if (!isRelated) {
                    imageSet.add(src);
                  }
                }
              }
            });

            // Convert to array and prioritize "OK_BIG" or "BIG" images
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

            // Most robust way to find specifications: any table row with th and td
            const specRows = Array.from(document.querySelectorAll("tr")).filter(
              (tr) =>
                (tr.querySelector("th") ||
                  tr.querySelector("td:first-child")) &&
                (tr.querySelector("td:last-child") ||
                  tr.querySelectorAll("td").length > 1),
            );

            const specs = specRows
              .map((row) => {
                const label =
                  row
                    .querySelector("th, td:first-child")
                    ?.textContent?.trim() || "";
                const value =
                  row.querySelector("td:last-child")?.textContent?.trim() || "";
                return { label, value };
              })
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
            await prisma.product.upsert({
              where: { name: data.name },
              update: {
                price: data.price,
                salePrice: data.salePrice,
                specifications: JSON.stringify(data.specs),
                features: JSON.stringify(data.features),
                stock: data.stock,
                images: data.images,
                description: data.name, // Ensure description is updated
                updatedAt: new Date(),
              },
              create: {
                name: data.name,
                description: data.name,
                price: data.price,
                salePrice: data.salePrice,
                specifications: JSON.stringify(data.specs),
                features: JSON.stringify(data.features),
                stock: data.stock,
                images: data.images,
                categoryId: category!.id,
              },
            });
            console.log(
              `Synced: ${data.name} - ฿${data.price} (Sale: ${data.salePrice || "None"})`,
            );
            scrapedNames.add(data.name);
          }
        } catch (err) {
          console.error(`Error scraping ${link}:`, err);
        } finally {
          await detailPage.close();
          processed++;
          writeProgress({
            status: "running",
            percent: total ? processed / total : 0,
            total,
            processed,
            message: `Progress: ${processed}/${total}`,
          });
        }
      });

      await Promise.all(batchPromises);
      writeProgress({
        status: "running",
        percent: total ? processed / total : 0,
        total,
        processed,
        message: `Completed batch ${Math.floor(i / batchSize) + 1}`,
      });
    }

    // Cleanup stale Advice products not present in current sync
    try {
      const existing = await prisma.product.findMany({
        where: {
          categoryId: category!.id,
          images: { contains: "advice.co.th" },
        },
        select: { id: true, name: true, features: true },
      });
      const stale = existing.filter((p) => !scrapedNames.has(p.name));
      if (stale.length > 0) {
        let deletedCount = 0;
        let markedCount = 0;
        for (const p of stale) {
          const orderCount = await prisma.orderItem.count({
            where: { productId: p.id },
          });
          if (orderCount > 0) {
            const marker = (p.features || "").includes("REMOVED_FROM_ADVICE")
              ? p.features || ""
              : (p.features || "").trim()
                ? `${p.features}\nREMOVED_FROM_ADVICE`
                : "REMOVED_FROM_ADVICE";
            await prisma.product.update({
              where: { id: p.id },
              data: { stock: 0, features: marker },
            });
            markedCount++;
          } else {
            await prisma.product.delete({ where: { id: p.id } });
            deletedCount++;
          }
        }
        console.log(
          `Cleanup: marked ${markedCount} as removed with stock=0, deleted ${deletedCount} stale products.`,
        );
        writeProgress({
          status: "running",
          percent: 1,
          total,
          processed,
          message: `Marked ${markedCount}, deleted ${deletedCount}`,
        });
      } else {
        console.log("No stale Advice products to process.");
      }
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr);
    }

    console.log("Sync completed successfully.");
    writeProgress({
      status: "completed",
      percent: 1,
      total,
      processed,
      message: "Sync completed",
      endedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Sync failed:", error);
    writeProgress({
      status: "error",
      percent: 0,
      total: 0,
      processed: 0,
      message: "Sync failed",
      error: error instanceof Error ? error.message : String(error),
      endedAt: new Date().toISOString(),
    });
  } finally {
    await browser.close();
    await prisma.$disconnect();
    try {
      const png = path.join(process.cwd(), "sync_debug.png");
      const html = path.join(process.cwd(), "sync_debug.html");
      if (fs.existsSync(png)) fs.unlinkSync(png);
      if (fs.existsSync(html)) fs.unlinkSync(html);
    } catch {
      // ignore cleanup errors
    }
  }
}

syncProducts();
