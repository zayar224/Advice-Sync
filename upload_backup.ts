import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const API_URL =
  process.env.API_URL || "https://kweelamin.com/api/admin/sync/advice";
const SYNC_SECRET = process.env.SYNC_SECRET;

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function uploadBackup() {
  const dataDir = path.join(process.cwd(), "data");

  if (!fs.existsSync(dataDir)) {
    log("❌ Data directory not found. Nothing to upload.");
    return;
  }

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("scraped_data_") && f.endsWith(".json"))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(dataDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time); // Latest first

  if (files.length === 0) {
    log("❌ No backup files found in 'data/' folder.");
    return;
  }

  const latestFile = path.join(dataDir, files[0].name);
  log(`📂 Found latest backup: ${files[0].name}`);

  let scrapedData;
  try {
    const content = fs.readFileSync(latestFile, "utf8");
    scrapedData = JSON.parse(content);
    log(`📊 Loaded ${scrapedData.length} products from backup.`);
  } catch (err) {
    log(`❌ Failed to read or parse backup file: ${err}`);
    return;
  }

  if (!SYNC_SECRET) {
    log("❌ SYNC_SECRET is not defined in .env file.");
    return;
  }

  const uploadChunkWithRetry = async (chunk: any[], retries = 5) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log(`   Attempt ${attempt} for batch...`);
        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sync-secret": SYNC_SECRET,
            "User-Agent": "AdviceSync-BackupUploader/1.0",
          },
          body: JSON.stringify({
            products: chunk,
            categoryName: "Notebook",
          }),
          timeout: 300000, // 5 minutes
        });

        const result = await response.json();

        if (response.ok) {
          log(`   ✅ Success: ${result.message}`);
          return true;
        } else {
          log(
            `   ❌ Failed (${response.status}): ${result.error || "Unknown error"}`,
          );
          if (response.status < 500) return false; // Client error, don't retry
        }
      } catch (err) {
        log(`   ⚠️ Network error: ${err}`);
        if (attempt === retries) throw err;
        const delay = attempt * 5000;
        log(`   Waiting ${delay / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    return false;
  };

  const batchSize = 1; // Sync one by one for maximum reliability
  let successCount = 0;

  log(`📤 Starting upload to ${API_URL}...`);
  for (let i = 0; i < scrapedData.length; i += batchSize) {
    const chunk = scrapedData.slice(i, i + batchSize);
    log(`📦 Uploading item ${i + 1}/${scrapedData.length}...`);

    const success = await uploadChunkWithRetry(chunk);
    if (success) successCount += chunk.length;

    // Small delay between successful items to be nice to the server
    if (success && i + batchSize < scrapedData.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  log(
    `🏁 Finished! Successfully uploaded ${successCount} out of ${scrapedData.length} products.`,
  );
}

uploadBackup().catch((err) => log(`💥 Fatal error: ${err}`));
