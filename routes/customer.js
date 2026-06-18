const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { logger } = require('../config/logger');
const { triggerConnectionRequest } = require('../services/acsServer');
const { resolveVirtualParams, getDevicePathForVirtualParam } = require('../services/paramResolver');
const genieacs = require('../services/genieacs');

// Middleware to protect customer routes
function requireCustomer(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'customer') {
    res.locals.user = req.session.user;
    return next();
  }
  res.redirect('/login');
}

router.use(requireCustomer);

// Helper to extract active client list from raw parameters JSON
function getActiveClients(rawParams) {
  const clientsMap = {};
  const params = rawParams || {};

  for (const [key, val] of Object.entries(params)) {
    // Parse TR-098 and TR-181 Hosts
    const hostMatch = key.match(/(?:InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.|Device\.Hosts\.Host\.)(\d+)\.(HostName|IPAddress|MACAddress|PhysAddress|Active)/i);
    if (hostMatch) {
      const idx = hostMatch[1];
      let prop = hostMatch[2];
      if (prop === 'PhysAddress') prop = 'MACAddress'; // Normalise TR-181

      if (!clientsMap[idx]) {
        clientsMap[idx] = { hostname: 'Unknown', ip: '-', mac: '-', active: 'true' };
      }

      if (prop === 'HostName') clientsMap[idx].hostname = val || 'Unknown';
      if (prop === 'IPAddress') clientsMap[idx].ip = val;
      if (prop === 'MACAddress') clientsMap[idx].mac = val;
      if (prop === 'Active') clientsMap[idx].active = String(val);
    }
  }

  // Filter for active/connected clients and return as array
  return Object.values(clientsMap).filter(c => {
    const activeLower = String(c.active).toLowerCase();
    return activeLower === 'true' || activeLower === '1';
  });
}

// Helper to fetch customer device data
async function getCustomerData(req) {
  const deviceId = req.session.user.assigned_device_id;
  if (!deviceId) return { error: 'ONU perangkat Anda belum diaktifkan oleh admin. Silakan hubungi admin.' };

  let device;
  if (genieacs.isGenieAcsEnabled()) {
    device = await genieacs.getDevice(deviceId);
  } else {
    device = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
    if (device) {
      device.online = (Date.now() - new Date(device.last_inform).getTime()) < 600000;
    }
  }

  if (!device) return { error: 'Perangkat Anda tidak ditemukan di server ACS. Silakan hubungi admin.' };

  let params = {};
  try { params = JSON.parse(device.params || '{}'); } catch (_) {}

  const vParams = resolveVirtualParams(params);
  const clients = getActiveClients(params);

  return { device, vParams, clients, error: null };
}

// Customer Dashboard Overview
router.get('/dashboard', async (req, res) => {
  try {
    const data = await getCustomerData(req);
    if (data.error) {
      return res.render('customer/dashboard', {
        device: null,
        vParams: {},
        clients: [],
        activePage: 'dashboard',
        error: data.error
      });
    }

    res.render('customer/dashboard', {
      ...data,
      activePage: 'dashboard'
    });
  } catch (err) {
    logger.error('Customer dashboard error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Customer Wi-Fi Settings
router.get('/wifi', async (req, res) => {
  try {
    const data = await getCustomerData(req);
    if (data.error) {
      return res.render('customer/wifi', {
        device: null,
        vParams: {},
        clients: [],
        activePage: 'wifi',
        error: data.error
      });
    }

    res.render('customer/wifi', {
      ...data,
      activePage: 'wifi'
    });
  } catch (err) {
    logger.error('Customer wifi settings error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Customer Connection Info
router.get('/connection', async (req, res) => {
  try {
    const data = await getCustomerData(req);
    if (data.error) {
      return res.render('customer/connection', {
        device: null,
        vParams: {},
        clients: [],
        activePage: 'connection',
        error: data.error
      });
    }

    res.render('customer/connection', {
      ...data,
      activePage: 'connection'
    });
  } catch (err) {
    logger.error('Customer connection view error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Customer Connected Devices
router.get('/devices', async (req, res) => {
  try {
    const data = await getCustomerData(req);
    if (data.error) {
      return res.render('customer/devices', {
        device: null,
        vParams: {},
        clients: [],
        activePage: 'devices',
        error: data.error
      });
    }

    res.render('customer/devices', {
      ...data,
      activePage: 'devices'
    });
  } catch (err) {
    logger.error('Customer devices view error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Update Wi-Fi Settings
router.post('/dashboard/wifi', async (req, res) => {
  try {
    const deviceId = req.session.user.assigned_device_id;
    if (!deviceId) return res.status(400).send('No device assigned');

    const { wifiSSID24, wifiPass24, wifiSSID5, wifiPass5 } = req.body;

    let device;
    if (genieacs.isGenieAcsEnabled()) {
      device = await genieacs.getDevice(deviceId);
    } else {
      device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
    }
    
    if (!device) return res.status(404).send('Device not found');

    let params = {};
    try { params = JSON.parse(device.params || '{}'); } catch (_) {}

    const updates = [];

    // 2.4 GHz update
    if (wifiSSID24) {
      const path = getDevicePathForVirtualParam(params, 'WifiSSID24');
      if (path) updates.push([path, wifiSSID24, 'xsd:string']);
    }
    if (wifiPass24) {
      const path = getDevicePathForVirtualParam(params, 'WifiPass24');
      if (path) updates.push([path, wifiPass24, 'xsd:string']);
    }

    // 5 GHz update (if device is dual-band and has 5G paths)
    if (wifiSSID5) {
      const path = getDevicePathForVirtualParam(params, 'WifiSSID5');
      if (path) updates.push([path, wifiSSID5, 'xsd:string']);
    }
    if (wifiPass5) {
      const path = getDevicePathForVirtualParam(params, 'WifiPass5');
      if (path) updates.push([path, wifiPass5, 'xsd:string']);
    }

    if (updates.length > 0) {
      if (genieacs.isGenieAcsEnabled()) {
        await genieacs.setParameterValues(deviceId, updates);
      } else {
        db.prepare(`
          INSERT INTO acs_tasks (device_id, name, payload, status)
          VALUES (?, 'setParameterValues', ?, 'pending')
        `).run(deviceId, JSON.stringify({ parameterValues: updates }));

        triggerConnectionRequest(deviceId);
      }
      logger.info(`[ACS] Customer updated Wi-Fi settings for ${deviceId}. Tasks queued.`);
    }

    res.redirect('/customer/wifi?success=1');
  } catch (err) {
    logger.error('Customer update Wi-Fi settings error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// GET Live Traffic Bytes from MikroTik (AJAX)
router.get('/traffic-stats', async (req, res) => {
  try {
    const deviceId = req.session.user.assigned_device_id;
    if (!deviceId) return res.json({ success: false, error: 'No device assigned' });

    let device;
    if (genieacs.isGenieAcsEnabled()) {
      device = await genieacs.getDevice(deviceId);
    } else {
      device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
    }

    if (!device) return res.json({ success: false, error: 'Device not found' });

    let params = {};
    try { params = JSON.parse(device.params || '{}'); } catch (_) {}
    const vParams = resolveVirtualParams(params);

    if (vParams.PPPoEUser && db.getSetting('mikrotik_enabled', 0)) {
      const { getPPPoEActiveSession } = require('../services/mikrotik');
      const sess = await getPPPoEActiveSession(vParams.PPPoEUser);
      if (sess && sess.active) {
        return res.json({
          success: true,
          source: 'mikrotik',
          bytesIn: parseInt(sess.bytesIn, 10),  // Upload bytes
          bytesOut: parseInt(sess.bytesOut, 10), // Download bytes
          timestamp: Date.now()
        });
      }
    }

    // Fallback: If MikroTik is disabled/inactive, return a simulated signal to let the graph move
    return res.json({
      success: true,
      source: 'simulation',
      timestamp: Date.now()
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
