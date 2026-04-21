
const dotenv = require("dotenv");
const https = require("https");
const fetch = require("node-fetch");

dotenv.config();

const API_URL = process.env.API_URL || "https://kweelamin.com/api/admin/sync/advice";
const SYNC_SECRET = process.env.SYNC_SECRET || "gWkE7OYh78Kaid/YdLXno23CKFrkY4QDKuWRAwIBLQQ=";

console.log("Testing fetch to", API_URL);
console.log("SYNC_SECRET:", SYNC_SECRET);

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function testFetch() {
  try {
    console.log("Starting test fetch...");
    
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sync-secret": SYNC_SECRET,
      },
      agent: httpsAgent,
      body: JSON.stringify({
        products: [
          {
            name: "Test Laptop",
            price: 29999,
            salePrice: null,
            specs: [],
            features: [],
            stock: 99,
            images: "[]"
          }
        ],
        categoryName: "Notebook",
      }),
    });
    
    console.log("Response status:", response.status, response.statusText);
    const text = await response.text();
    console.log("Response text:", text);
    
    try {
      const json = JSON.parse(text);
      console.log("Response JSON:", json);
    } catch (e) {
      console.log("Response is not JSON");
    }
  } catch (error) {
    console.error("ERROR:", error);
    if (error instanceof Error) {
      console.error("Stack:", error.stack);
    }
  }
}

testFetch();
