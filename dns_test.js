
const dns = require('dns').promises;
const https = require('https');

async function diagnostic() {
  const host = 'www.advice.co.th';
  console.log(`--- Diagnostic for ${host} ---`);
  
  // 1. Test DNS Lookup
  try {
    console.log('1. Attempting dns.lookup...');
    const result = await dns.lookup(host);
    console.log('✅ dns.lookup successful:', result);
  } catch (err) {
    console.error('❌ dns.lookup failed:', err.message);
  }

  // 2. Test DNS Resolve
  try {
    console.log('2. Attempting dns.resolve4...');
    const addresses = await dns.resolve4(host);
    console.log('✅ dns.resolve4 successful:', addresses);
  } catch (err) {
    console.error('❌ dns.resolve4 failed:', err.message);
  }

  // 3. Test HTTPS Request (simple)
  try {
    console.log('3. Attempting simple HTTPS GET...');
    return new Promise((resolve) => {
      https.get(`https://${host}/`, (res) => {
        console.log('✅ HTTPS GET successful, status code:', res.statusCode);
        resolve();
      }).on('error', (e) => {
        console.error('❌ HTTPS GET failed:', e.message);
        resolve();
      });
    });
  } catch (err) {
    console.error('❌ HTTPS request logic error:', err.message);
  }
}

diagnostic();
