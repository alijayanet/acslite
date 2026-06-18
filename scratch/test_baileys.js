const baileys = require('@whiskeysockets/baileys');
console.log('Baileys exports:', Object.keys(baileys).filter(k => k.toLowerCase().includes('version') || k.toLowerCase().includes('fetch')));

const { fetchLatestBaileysVersion, fetchLatestWaWebVersion } = baileys;
console.log('fetchLatestBaileysVersion:', typeof fetchLatestBaileysVersion);
console.log('fetchLatestWaWebVersion:', typeof fetchLatestWaWebVersion);

async function run() {
  const fetchFn = fetchLatestWaWebVersion || fetchLatestBaileysVersion;
  if (fetchFn) {
    try {
      const result = await fetchFn();
      console.log('Fetch result:', result);
    } catch (e) {
      console.error('Fetch failed:', e);
    }
  } else {
    console.log('No version fetch function found!');
  }
}

run();
