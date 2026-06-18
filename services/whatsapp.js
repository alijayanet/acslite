'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const db = require('../config/database');
const { logger } = require('../config/logger');
const { triggerConnectionRequest, provisionWanConnection } = require('./acsServer');
const { resolveVirtualParams, getDevicePathForVirtualParam } = require('./paramResolver');

// Global status variables
global.whatsappStatus = 'closed'; // closed, connecting, qr, open
global.whatsappQR = null;

let sock = null;

function cleanPhoneNumber(jid) {
  if (!jid) return null;
  const num = jid.split('@')[0];
  return num.replace(/\D/g, ''); // Extract only digits
}

// Helper to wrap bot messages in a clean structure
function formatResponse(title, body) {
  const company = db.getSetting('company_header', 'ACS LITE PORTAL');
  const separator = '═'.repeat(24);
  return `🏢 *${company}*\n${separator}\n${title ? '📌 *' + title + '*\n\n' : ''}${body}\n${separator}\nACS Lite Standalone Bot`;
}

// ---------------------------------------------------------
// ACS Command Core Executors
// ---------------------------------------------------------
async function executeOnuInfo(deviceId, title = 'STATUS ONU') {
  const device = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
  if (!device) return '❌ Data perangkat ONU tidak ditemukan di database ACS.';

  let params = {};
  try { params = JSON.parse(device.params || '{}'); } catch (_) {}
  const vParams = resolveVirtualParams(params);

  // Check if online
  const isOnline = device.last_inform && (Date.now() - new Date(device.last_inform).getTime() < 600000);

  const lines = [
    `🏷️ *SN:* ${device.serial_number}`,
    `🟢 *Status:* ${isOnline ? 'Online' : 'Offline'}`,
    `📡 *RX Power:* ${vParams.RxPower ? vParams.RxPower + ' dBm' : 'N/A'}`,
    `📶 *SSID (2.4G):* ${vParams.WifiSSID24 || 'N/A'}`,
    `🌐 *External IP:* ${vParams.ExternalIP || device.ip_address || 'N/A'}`,
    `⏱️ *Last Inform:* ${device.last_inform}`,
    `🔧 *Brand:* ${device.manufacturer} (${device.product_class})`
  ];

  return formatResponse(title, lines.join('\n'));
}

async function executeOnuCekterhubung(deviceId) {
  const device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!device) return '❌ Data perangkat ONU tidak ditemukan.';

  let params = {};
  try { params = JSON.parse(device.params || '{}'); } catch (_) {}

  const clientsMap = {};
  for (const [key, val] of Object.entries(params)) {
    const hostMatch = key.match(/(?:InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.|Device\.Hosts\.Host\.)(\d+)\.(HostName|IPAddress|PhysAddress|MACAddress|Active)/i);
    if (hostMatch) {
      const idx = hostMatch[1];
      let prop = hostMatch[2];
      if (prop === 'PhysAddress') prop = 'MACAddress';

      if (!clientsMap[idx]) clientsMap[idx] = { hostname: 'Unknown', ip: '-', mac: '-', active: 'true' };
      if (prop === 'HostName') clientsMap[idx].hostname = val || 'Unknown';
      if (prop === 'IPAddress') clientsMap[idx].ip = val;
      if (prop === 'MACAddress') clientsMap[idx].mac = val;
      if (prop === 'Active') clientsMap[idx].active = String(val);
    }
  }

  const activeClients = Object.values(clientsMap).filter(c => {
    const act = String(c.active).toLowerCase();
    return act === 'true' || act === '1';
  });

  if (activeClients.length === 0) {
    return formatResponse('PERANGKAT TERHUBUNG', '⚠️ Tidak ada perangkat yang terhubung saat ini.');
  }

  const listLines = activeClients.map((c, i) => `${i+1}. 📱 ${c.hostname}\n   🌐 ${c.ip} | ${c.mac}`).join('\n\n');
  return formatResponse('PERANGKAT TERHUBUNG', `📊 *${activeClients.length} Perangkat aktif:*\n\n${listLines}`);
}

async function executeOnuReboot(deviceId) {
  const device = db.prepare('SELECT id FROM acs_devices WHERE id = ?').get(deviceId);
  if (!device) return '❌ Perangkat tidak ditemukan.';

  db.prepare(`
    INSERT INTO acs_tasks (device_id, name, payload, status)
    VALUES (?, 'reboot', '{}', 'pending')
  `).run(deviceId);

  triggerConnectionRequest(deviceId);
  return formatResponse('REBOOT ONU', '✅ Perintah reboot berhasil dikirim ke perangkat ONU Anda.');
}

async function executeOnuGantissid(deviceId, newSSID) {
  const device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!device) return '❌ Perangkat tidak ditemukan.';

  let params = {};
  try { params = JSON.parse(device.params || '{}'); } catch (_) {}

  const path = getDevicePathForVirtualParam(params, 'WifiSSID24');
  if (!path) return '❌ Gagal memetakan path SSID Wi-Fi pada perangkat ini.';

  db.prepare(`
    INSERT INTO acs_tasks (device_id, name, payload, status)
    VALUES (?, 'setParameterValues', ?, 'pending')
  `).run(deviceId, JSON.stringify({
    parameterValues: [[path, newSSID, 'xsd:string']]
  }));

  triggerConnectionRequest(deviceId);
  return formatResponse('GANTI SSID WI-FI', `✅ Nama Wi-Fi baru *${newSSID}* sedang dikirim ke perangkat.`);
}

async function executeOnuGantisandi(deviceId, newPassword) {
  if (newPassword.length < 8) return '❌ Password Wi-Fi minimal harus 8 karakter.';

  const device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!device) return '❌ Perangkat tidak ditemukan.';

  let params = {};
  try { params = JSON.parse(device.params || '{}'); } catch (_) {}

  const path = getDevicePathForVirtualParam(params, 'WifiPass24');
  if (!path) return '❌ Gagal memetakan path password Wi-Fi pada perangkat ini.';

  db.prepare(`
    INSERT INTO acs_tasks (device_id, name, payload, status)
    VALUES (?, 'setParameterValues', ?, 'pending')
  `).run(deviceId, JSON.stringify({
    parameterValues: [[path, newPassword, 'xsd:string']]
  }));

  triggerConnectionRequest(deviceId);
  return formatResponse('GANTI SANDI WI-FI', `✅ Sandi Wi-Fi baru berhasil diantrikan ke perangkat.`);
}

// ---------------------------------------------------------
// Bot Message Parser & Logic Handler
// ---------------------------------------------------------
async function handleMessage(msg) {
  const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
  if (!text) return;

  const senderJid = msg.key.remoteJid;
  if (senderJid.endsWith('@g.us')) return; // Ignore groups

  const phone = cleanPhoneNumber(senderJid);
  if (!phone) return;

  // Lookup user in DB
  const user = db.prepare('SELECT * FROM users WHERE phone = ? AND is_active = 1').get(phone);
  if (!user) {
    // Check if any default admins exist without phone, we block unknown numbers
    logger.debug(`[WhatsApp] Unknown message from phone: ${phone}`);
    return; // Don't reply to spam/unknown
  }

  const isAdmin = user.role === 'admin';
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  let response = '';

  // 1. HELP / MENU COMMAND
  if (['menu', 'help', 'bantuan'].includes(command)) {
    if (isAdmin) {
      response = formatResponse('MENU ADMINISTRATOR',
        `Halo Admin *${user.name}*, berikut daftar perintah:\n\n` +
        `1. *listonu* : Cek semua ONU (Online/Offline)\n` +
        `2. *info <SN>* : Cek detail ONU\n` +
        `3. *cekterhubung <SN>* : Cek perangkat terhubung\n` +
        `4. *reboot <SN>* : Restart ONU\n` +
        `5. *gantissid <SN> <SSID_Baru>* : Ganti nama Wi-Fi\n` +
        `6. *gantisandi <SN> <Sandi_Baru>* : Ganti password Wi-Fi\n` +
        `7. *provision <SN> <mode> <vlan> [user] [pass]* : Provisioning WAN`
      );
    } else {
      response = formatResponse('MENU PELANGGAN',
        `Halo *${user.name}*, berikut menu pengelolaan Wi-Fi Anda:\n\n` +
        `1. *info* : Cek status perangkat ONU Anda\n` +
        `2. *cekterhubung* : Lihat HP/Laptop yang terhubung\n` +
        `3. *reboot* : Restart perangkat Wi-Fi Anda\n` +
        `4. *gantissid <Nama_Baru>* : Ganti nama Wi-Fi Anda\n` +
        `5. *gantisandi <Sandi_Baru>* : Ganti sandi Wi-Fi Anda`
      );
    }
    return sendText(senderJid, response);
  }

  // ------------------------------------
  // ADMIN COMMANDS
  // ------------------------------------
  if (isAdmin) {
    if (command === 'listonu') {
      const all = db.prepare('SELECT serial_number, manufacturer, last_inform FROM acs_devices').all();
      const online = [];
      const offline = [];
      const threshold = 600000;
      for (const d of all) {
        const active = d.last_inform && (Date.now() - new Date(d.last_inform).getTime() < threshold);
        if (active) online.push(`• 🟢 ${d.serial_number} (${d.manufacturer})`);
        else offline.push(`• 🔴 ${d.serial_number}`);
      }
      const body = `📈 *Total ONU:* ${all.length}\n🟢 *Online:* ${online.length}\n🔴 *Offline:* ${offline.length}\n\n*ONU Online:*\n${online.slice(0, 15).join('\n') || '-'}\n\n*ONU Offline:*\n${offline.slice(0, 15).join('\n') || '-'}`;
      return sendText(senderJid, formatResponse('DAFTAR PERANGKAT ONU', body));
    }

    // Commands requiring SN Target
    if (['info', 'cekterhubung', 'reboot', 'gantissid', 'gantisandi', 'provision'].includes(command)) {
      if (args.length === 0) {
        return sendText(senderJid, `❌ Perintah ${command} membutuhkan Serial Number perangkat target. Contoh: \`${command} HW0987654321 [arg]\``);
      }

      const targetSn = args[0].trim();
      
      // Find deviceId from SN
      const devRow = db.prepare('SELECT id FROM acs_devices WHERE serial_number = ? OR id = ?').get(targetSn, targetSn);
      if (!devRow) {
        return sendText(senderJid, `❌ Perangkat dengan Serial Number *${targetSn}* tidak terdaftar di server.`);
      }
      const deviceId = devRow.id;

      if (command === 'info') {
        response = await executeOnuInfo(deviceId, `DETAIL ONU ${targetSn}`);
      } else if (command === 'cekterhubung') {
        response = await executeOnuCekterhubung(deviceId);
      } else if (command === 'reboot') {
        response = await executeOnuReboot(deviceId);
      } else if (command === 'gantissid') {
        if (args.length < 2) return sendText(senderJid, '❌ Gunakan format: `gantissid <SN> <SSID_Baru>`');
        const newSSID = args.slice(1).join(' ');
        response = await executeOnuGantissid(deviceId, newSSID);
      } else if (command === 'gantisandi') {
        if (args.length < 2) return sendText(senderJid, '❌ Gunakan format: `gantisandi <SN> <Sandi_Baru>`');
        const newPass = args[1];
        response = await executeOnuGantisandi(deviceId, newPass);
      } else if (command === 'provision') {
        // provision <SN> <mode> <vlan> [user] [pass]
        if (args.length < 3) return sendText(senderJid, '❌ Gunakan format: `provision <SN> <pppoe|dhcp|bridge> <vlan_id> [pppoe_user] [pppoe_pass]`');
        const mode = args[1].toLowerCase();
        const vlan = args[2];
        const user = args[3] || '';
        const pass = args[4] || '';

        const res = provisionWanConnection(deviceId, { mode, vlan, username: user, password: pass, bindPorts: ['LAN1', 'LAN2', 'SSID1'] });
        response = formatResponse('PROVISIONING WAN', res.success ? `✅ Task provisioning Add WAN berhasil diantrikan dengan Task ID: ${res.taskId}` : `❌ Gagal: ${res.message}`);
      }

      return sendText(senderJid, response);
    }
  }

  // ------------------------------------
  // CUSTOMER COMMANDS
  // ------------------------------------
  const deviceId = user.assigned_device_id;
  if (!deviceId) {
    return sendText(senderJid, formatResponse('PORTAL PELANGGAN', '❌ Akun Anda belum ditautkan ke perangkat ONU. Silakan hubungi admin.'));
  }

  if (command === 'info' || command === 'status') {
    response = await executeOnuInfo(deviceId, 'STATUS PERANGKAT ANDA');
  } else if (command === 'cekterhubung') {
    response = await executeOnuCekterhubung(deviceId);
  } else if (command === 'reboot') {
    response = await executeOnuReboot(deviceId);
  } else if (command === 'gantissid') {
    if (args.length === 0) return sendText(senderJid, '❌ Gunakan format: `gantissid <Nama_Wi-Fi_Baru>`');
    const newSSID = args.join(' ');
    response = await executeOnuGantissid(deviceId, newSSID);
  } else if (command === 'gantisandi') {
    if (args.length === 0) return sendText(senderJid, '❌ Gunakan format: `gantisandi <Sandi_Wi-Fi_Baru>`');
    const newPass = args[0];
    response = await executeOnuGantisandi(deviceId, newPass);
  } else {
    response = formatResponse('BANTUAN BOT', '⚠️ Perintah tidak dikenali. Ketik *menu* untuk melihat daftar perintah yang tersedia.');
  }

  return sendText(senderJid, response);
}

// Helper to send text messages
async function sendText(jid, text) {
  if (sock) {
    try {
      await sock.sendMessage(jid, { text });
    } catch (err) {
      logger.error(`[WhatsApp] Failed to send message to ${jid}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------
// WhatsApp Baileys Listener and Connection Manager
// ---------------------------------------------------------
async function startWhatsAppBot() {
  if (sock) return; // Already running

  const authDir = path.join(__dirname, '../database/auth_info_baileys');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  global.whatsappStatus = 'connecting';
  logger.info('[WhatsApp] Initiating Baileys connection...');

  // Fetch latest WhatsApp Web version to avoid connection failures
  let version = [2, 3000, 1017531287];
  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest && latest.version) {
      version = latest.version;
      logger.info(`[WhatsApp] Fetched latest version: ${version.join('.')}`);
    }
  } catch (err) {
    logger.warn(`[WhatsApp] Failed to fetch latest version, using fallback: ${err.message}`);
  }

  try {
    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false, // Handle custom terminal printing
      logger: pino({ level: 'silent' }), // Suppress pino debug logs
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        global.whatsappStatus = 'qr';
        global.whatsappQR = qr;
        // Print to terminal
        qrcodeTerminal.generate(qr, { small: true });
        logger.info('[WhatsApp] QR Code generated. Scan to log in.');
      }

      if (connection === 'close') {
        global.whatsappQR = null;
        const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
        logger.warn(`[WhatsApp] Connection closed. Error: ${lastDisconnect.error ? lastDisconnect.error.stack || lastDisconnect.error.message || JSON.stringify(lastDisconnect.error) : 'unknown'}. Reconnecting: ${shouldReconnect}`);
        
        sock = null;
        global.whatsappStatus = 'closed';

        if (shouldReconnect) {
          setTimeout(startWhatsAppBot, 5000);
        }
      }

      if (connection === 'open') {
        global.whatsappQR = null;
        global.whatsappStatus = 'open';
        logger.info('[WhatsApp] Bot successfully logged in & active!');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          if (!msg.key.fromMe) {
            try {
              await handleMessage(msg);
            } catch (err) {
              logger.error('[WhatsApp] Message handler failed: ' + err.stack);
            }
          }
        }
      }
    });

  } catch (err) {
    logger.error('[WhatsApp] Bot start failed: ' + err.message);
    global.whatsappStatus = 'closed';
    sock = null;
  }
}

function stopWhatsAppBot() {
  if (sock) {
    try {
      sock.end();
      sock = null;
      global.whatsappStatus = 'closed';
      global.whatsappQR = null;
      logger.info('[WhatsApp] Bot stopped successfully.');
    } catch (_) {}
  }
}

module.exports = {
  startWhatsAppBot,
  stopWhatsAppBot
};
