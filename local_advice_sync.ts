import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

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
    fs.appendFileSync(
      logFile,
      `[${new Date().toISOString()}] ${m}\n`,
      "utf8",
    );
  } catch {}
  console.log(m);
};

// Configuration - Update these if needed
const API_URL =
  process.env.API_URL || "https://kweelamin.com/api/admin/sync/advice";
const SYNC_SECRET =
  process.env.SYNC_SECRET ||
  "gWkE7OYh78Kaid/YdLXno23CKFrkY4QDKuWRAwIBLQQ="; // Should match live server's NEXTAUTH_SECRET
const HEADLESS =
  (process.env.HEADLESS ?? "true").toLowerCase() !== "false";

puppeteer.use(StealthPlugin());

async function syncProducts() {
  log("🚀 Starting Local Advice Scraper...");

  const browser = await puppeteer.launch({
    headless: HEADLESS, // Run in background without opening a browser window
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--window-size=1920,1080",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    log("Navigating to Advice home page...");
    await page.goto("https://www.advice.co.th/", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    // Wait for manual verification if needed
    await new Promise((r) => setTimeout(r, 5000));

    log("Navigating to Advice search page...");
    // The user's requested link which has 376 items
    await page.goto("https://www.advice.co.th/product/search?keyword=laptop", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

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
      log("❌ Blocked by Cloudflare even locally. Try headful mode.");
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
            const text = (a.innerText || "").toLowerCase();

            // Check if it's a product link
            const isProduct =
              lowerHref.includes("/product/") &&
              !lowerHref.includes("search?keyword=");
            if (!isProduct) return;

            // Simple notebook check
            const isNotebook = true; // Assume all search results for 'laptop' are notebooks

            if (isNotebook) {
              if (
                !excludeKeywords.some(
                  (k) => lowerHref.includes(k) || text.includes(k),
                )
              ) {
                foundLinks.push(href);
              }
            }
          } catch (e) {}
        });
        return Array.from(new Set(foundLinks));
      });
      const before = allLinks.size;
      links.forEach((l) => allLinks.add(l));
      const after = allLinks.size;
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
        // Auto-scroll to the bottom multiple times to trigger lazy-loaded buttons or items
        await page.evaluate(async () => {
          window.scrollBy(0, window.innerHeight);
          await new Promise((r) => setTimeout(r, 1000));
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise((r) => setTimeout(r, 1000));
        });

        log(`Checking for 'Show More Products' button (${clickCount + 1})...`);
        const clicked = await page.evaluate(async () => {
          // Multiple possible selectors for Advice "Show More" or "Load More"
          const selectors = [
            ".showproduct-more",
            ".btn-show-more",
            ".btn-load-more",
            "button:contains('แสดงเพิ่มเติม')",
            "button:contains('Show more')",
            ".load-more-btn",
          ];

          for (const selector of selectors) {
            let btn: HTMLElement | null = null;
            if (selector.includes(":contains")) {
              const text = selector.match(/'(.+)'/)?.[1] || "";
              btn = Array.from(
                document.querySelectorAll("button, a, span"),
              ).find((el) =>
                el.textContent?.trim().includes(text),
              ) as HTMLElement;
            } else {
              btn = document.querySelector(selector) as HTMLElement;
            }

            if (btn) {
              const isVisible = (el: HTMLElement) => {
                const style = window.getComputedStyle(el);
                return (
                  style &&
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  el.offsetWidth > 0 &&
                  el.offsetHeight > 0
                );
              };

              if (isVisible(btn)) {
                btn.scrollIntoView();
                btn.click();
                return true;
              }
            }
          }
          return false;
        });

        if (clicked) {
          log(`Click ${clickCount + 1} successful! Waiting for items to load...`);
          await new Promise((r) => setTimeout(r, 10000)); // Wait longer for items to load
          const newLinksFound = await extractLinks();
          log(
            `After click ${clickCount + 1}, total unique links: ${allLinks.size} (New in this step: ${newLinksFound})`,
          );
          clickCount++;
        } else {
          // One final scroll to see if it triggers something
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
          );
          await new Promise((r) => setTimeout(r, 2000));
          const finalLinksCheck = await extractLinks();
          if (finalLinksCheck === 0) {
            log(
              "No visible 'Show More' button found and no new links found after scroll.",
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
        try {
          await detailPage.goto(link, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });
          await new Promise((r) => setTimeout(r, 2000));

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

            const priceText =
              document
                .querySelector(".product-price-special, .product-price")
                ?.textContent?.trim() || "0";
            const price = parseFloat(priceText.replace(/[^0-9.]/g, ""));

            const specRows = Array.from(document.querySelectorAll("tr")).filter(
              (tr) => tr.querySelector("th") && tr.querySelector("td"),
            );
            const specs = specRows.map((row) => ({
              label: row.querySelector("th")?.textContent?.trim() || "",
              value: row.querySelector("td")?.textContent?.trim() || "",
            }));

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

            return {
              name,
              price,
              specs,
              stock: 99,
              images: Array.from(imageSet).slice(0, 10),
            };
          });

          if (data && data.name && data.price > 0) {
            scrapedData.push(data);
            log(`✅ Scraped: ${data.name}`);
          }
        } catch (err) {
          log(`❌ Error scraping ${link}: ${String(err)}`);
        } finally {
          await detailPage.close();
        }
      });

      await Promise.all(batchPromises);
    }

    log(`🎉 Scraping complete! Scraped ${scrapedData.length} products.`);

    if (scrapedData.length === 0) {
      log(
        "❌ No products were scraped. Skipping upload to prevent data loss on the live server.",
      );
      return;
    }

    log(`📤 Uploading data to live server (${API_URL})...`);

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sync-secret": SYNC_SECRET,
      },
      body: JSON.stringify({
        products: scrapedData,
        categoryName: "Notebook",
      }),
    });

    const result = await response.json();
    if (response.ok) {
      log(`✨ SUCCESS: ${result.message}`);
    } else {
      log(`❌ UPLOAD FAILED: ${result.error}`);
    }
  } catch (error) {
    log(`💥 Sync failed: ${String(error)}`);
  } finally {
    await browser.close();
    log("👋 Done!");
  }
}

syncProducts();
