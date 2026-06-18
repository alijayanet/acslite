const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { getSetting, saveSetting } = db;
const { logger } = require('../config/logger');
const { triggerConnectionRequest, provisionWanConnection } = require('../services/acsServer');
const { resolveVirtualParams, getDevicePathForVirtualParam } = require('../services/paramResolver');
const { checkConnection, getPPPoEActiveSession, createPPPoESecret } = require('../services/mikrotik');
const { startWhatsAppBot, stopWhatsAppBot } = require('../services/whatsapp');
const genieacs = require('../services/genieacs');

// Middleware to protect admin routes
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    res.locals.user = req.session.user;
    return next();
  }
  res.redirect('/login');
}

router.use(requireAdmin);

// Helpers
const ONLINE_THRESHOLD_MS = 600000; // 10 minutes
function isOnline(lastInform) {
  if (!lastInform) return false;
  return (Date.now() - new Date(lastInform).getTime()) < ONLINE_THRESHOLD_MS;
}

// Redirect root to dashboard
router.get('/', (req, res) => {
  res.redirect('/admin/dashboard');
});

// Admin Dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const devices = genieacs.isGenieAcsEnabled()
      ? await genieacs.getDevices()
      : db.prepare('SELECT id, manufacturer, product_class, last_inform, params FROM acs_devices').all();
    
    let onlineCount = 0;
    let offlineCount = 0;
    const vendorMap = {};
    const modelMap = {};
    
    let active10m = 0;
    let active1h = 0;
    let active24h = 0;
    let offlineLong = 0;

    let rxSum = 0;
    let rxCount = 0;
    
    const nowMs = Date.now();
    for (const dev of devices) {
      const active = isOnline(dev.last_inform);
      if (active) onlineCount++;
      else offlineCount++;

      // Vendor stats
      const vendor = (dev.manufacturer || 'Unknown').split(' ')[0].toUpperCase();
      vendorMap[vendor] = (vendorMap[vendor] || 0) + 1;

      // Model stats
      const model = dev.product_class || 'Unknown';
      modelMap[model] = (modelMap[model] || 0) + 1;

      // Inform activity buckets
      if (!dev.last_inform) {
        offlineLong++;
      } else {
        const diffMs = nowMs - new Date(dev.last_inform).getTime();
        if (diffMs < 600000) active10m++;
        else if (diffMs < 3600000) active1h++;
        else if (diffMs < 86400000) active24h++;
        else offlineLong++;
      }

      // RxPower stats (dynamic resolve)
      let params = {};
      try { params = JSON.parse(dev.params || '{}'); } catch (_) {}
      const vParams = resolveVirtualParams(params);
      const rxVal = parseFloat(vParams.RxPower);
      if (!isNaN(rxVal) && rxVal < 0) {
        rxSum += rxVal;
        rxCount++;
      }
    }

    const avgRxPower = rxCount > 0 ? (rxSum / rxCount).toFixed(2) : 'N/A';
    
    // Active sessions
    const activeSessions = db.prepare(`
      SELECT COUNT(*) as count FROM acs_sessions 
      WHERE datetime(last_activity) > datetime('now', '-2 minutes')
    `).get().count;

    // Recent device faults
    const recentFaults = db.prepare(`
      SELECT f.*, d.serial_number 
      FROM acs_device_faults f
      JOIN acs_devices d ON f.device_id = d.id
      ORDER BY f.last_seen DESC LIMIT 5
    `).all();

    // Compile chart data
    const chartData = {
      onlineOffline: [onlineCount, offlineCount],
      vendors: {
        labels: Object.keys(vendorMap),
        values: Object.values(vendorMap)
      },
      models: {
        labels: Object.keys(modelMap),
        values: Object.values(modelMap)
      },
      activity: [active10m, active1h, active24h, offlineLong],
      avgRxPower
    };

    const waEnabled = parseInt(getSetting('whatsapp_enabled', '0'), 10);
    const waStatus = global.whatsappStatus || 'closed';
    const waQR = global.whatsappQR || null;

    res.render('admin/dashboard', {
      stats: {
        total: devices.length,
        online: onlineCount,
        offline: offlineCount,
        sessions: activeSessions,
        avgRxPower
      },
      recentFaults,
      chartData,
      waEnabled,
      waStatus,
      waQR
    });
  } catch (err) {
    logger.error('Dashboard route error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Device List
router.get('/devices', async (req, res) => {
  try {
    const search = req.query.search || '';
    let devices = [];

    if (genieacs.isGenieAcsEnabled()) {
      devices = await genieacs.getDevices();
      if (search) {
        const term = search.toLowerCase();
        devices = devices.filter(dev =>
          (dev.id || '').toLowerCase().includes(term) ||
          (dev.serial_number || '').toLowerCase().includes(term) ||
          (dev.manufacturer || '').toLowerCase().includes(term) ||
          (dev.product_class || '').toLowerCase().includes(term)
        );
      }
    } else {
      let rows;
      if (search) {
        const term = `%${search}%`;
        rows = db.prepare(`
          SELECT * FROM acs_devices 
          WHERE id LIKE ? OR serial_number LIKE ? OR manufacturer LIKE ? OR oui LIKE ?
          ORDER BY last_inform DESC
        `).all(term, term, term, term);
      } else {
        rows = db.prepare('SELECT * FROM acs_devices ORDER BY last_inform DESC').all();
      }

      devices = rows.map(dev => ({
        ...dev,
        online: isOnline(dev.last_inform)
      }));
    }

    // Map virtual parameters for column display
    devices = devices.map(dev => {
      let params = {};
      try { params = JSON.parse(dev.params || '{}'); } catch (_) {}
      const vParams = resolveVirtualParams(params);
      return {
        ...dev,
        rxPower: vParams.RxPower || 'N/A',
        pppoeUser: vParams.PPPoEUser || 'N/A',
        ipAddress: dev.ip_address || 'N/A'
      };
    });

    res.render('admin/devices', { devices, search });
  } catch (err) {
    logger.error('Device list route error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Device Details
router.get('/devices/:id', async (req, res) => {
  try {
    const deviceId = req.params.id;
    let device;
    if (genieacs.isGenieAcsEnabled()) {
      device = await genieacs.getDevice(deviceId);
    } else {
      device = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
      if (device) {
        device.online = isOnline(device.last_inform);
      }
    }

    if (!device) {
      return res.status(404).send('Device not found');
    }

    let params = {};
    try { params = JSON.parse(device.params || '{}'); } catch (_) {}

    const vParams = resolveVirtualParams(params);
    const resolvedPathMap = {};
    for (const key of Object.keys(vParams)) {
      resolvedPathMap[key] = getDevicePathForVirtualParam(params, key);
    }

    // Load tasks
    const tasks = genieacs.isGenieAcsEnabled() ? [] : db.prepare('SELECT * FROM acs_tasks WHERE device_id = ? ORDER BY id DESC').all(deviceId);

    // Load faults
    const faults = genieacs.isGenieAcsEnabled() ? [] : db.prepare('SELECT * FROM acs_device_faults WHERE device_id = ? ORDER BY last_seen DESC').all(deviceId);

    // Load live PPPoE active status from MikroTik
    let pppoeSession = null;
    if (vParams.PPPoEUser) {
      try {
        pppoeSession = await getPPPoEActiveSession(vParams.PPPoEUser);
      } catch (err) {
        logger.warn(`Failed to query PPPoE active session for ${vParams.PPPoEUser}: ${err.message}`);
      }
    }

    res.render('admin/device', {
      device: {
        ...device,
        online: isOnline(device.last_inform)
      },
      vParams,
      resolvedPathMap,
      tasks,
      faults,
      pppoeSession,
      rawParams: params
    });
  } catch (err) {
    logger.error('Device details route error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Queue Simple Task
router.post('/devices/:id/task', async (req, res) => {
  try {
    const deviceId = req.params.id;
    const { taskName, customPath } = req.body;
    
    if (genieacs.isGenieAcsEnabled()) {
      if (taskName === 'reboot') {
        await genieacs.reboot(deviceId);
      } else if (taskName === 'getParameterValues' && customPath) {
        await genieacs.queueTask(deviceId, { name: 'getParameterValues', parameterNames: [customPath] });
      } else if (taskName === 'refreshObject' && customPath) {
        await genieacs.refreshObject(deviceId, customPath);
      } else {
        await genieacs.queueTask(deviceId, { name: taskName });
      }
      logger.info(`[GenieACS] Admin queued ${taskName} task for ${deviceId}`);
    } else {
      let payload = {};
      if (taskName === 'getParameterValues' && customPath) {
        payload = { parameterNames: [customPath] };
      }

      db.prepare(`
        INSERT INTO acs_tasks (device_id, name, payload, status)
        VALUES (?, ?, ?, 'pending')
      `).run(deviceId, taskName, JSON.stringify(payload));

      triggerConnectionRequest(deviceId);
      logger.info(`[ACS] Admin queued ${taskName} task for ${deviceId}`);
    }
    res.redirect(`/admin/devices/${deviceId}`);
  } catch (err) {
    logger.error('Queue task error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Update Writable Parameter
router.post('/devices/:id/update-param', async (req, res) => {
  try {
    const deviceId = req.params.id;
    const { paramName, paramValue } = req.body;

    let device;
    if (genieacs.isGenieAcsEnabled()) {
      device = await genieacs.getDevice(deviceId);
    } else {
      device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
    }
    
    if (!device) return res.status(404).send('Device not found');

    let params = {};
    try { params = JSON.parse(device.params || '{}'); } catch (_) {}

    const rawPath = getDevicePathForVirtualParam(params, paramName);
    if (!rawPath) {
      return res.status(400).send('Could not map virtual parameter to device TR-069 path');
    }

    // Resolve type from virtual param schema
    const vpSchema = db.prepare('SELECT type FROM acs_virtual_params WHERE name = ?').get(paramName);
    let type = 'xsd:string';
    if (vpSchema) {
      if (vpSchema.type === 'number') type = 'xsd:unsignedInt';
      else if (vpSchema.type === 'boolean') type = 'xsd:boolean';
    }

    if (genieacs.isGenieAcsEnabled()) {
      const updates = [[rawPath, paramValue, type]];
      await genieacs.setParameterValues(deviceId, updates);
      logger.info(`[GenieACS] Admin queued parameter update for ${deviceId}: ${rawPath} = ${paramValue}`);
    } else {
      const payload = {
        parameterValues: [[rawPath, paramValue, type]]
      };

      db.prepare(`
        INSERT INTO acs_tasks (device_id, name, payload, status)
        VALUES (?, 'setParameterValues', ?, 'pending')
      `).run(deviceId, JSON.stringify(payload));

      triggerConnectionRequest(deviceId);
      logger.info(`[ACS] Admin queued parameter update for ${deviceId}: ${rawPath} = ${paramValue}`);
    }
    
    // Check if AJAX request
    if (req.xhr || req.headers.accept.includes('json')) {
      return res.json({ success: true, message: 'Parameter update queued' });
    }
    res.redirect(`/admin/devices/${deviceId}`);
  } catch (err) {
    logger.error('Update param error: ' + err.message);
    if (req.xhr) return res.status(500).json({ success: false, error: err.message });
    res.status(500).send('Internal Server Error');
  }
});

// Provision WAN connection (Add WAN)
router.post('/devices/:id/provision', (req, res) => {
  try {
    const deviceId = req.params.id;
    const { mode, vlan, username, password, bindPorts } = req.body;

    const portsList = Array.isArray(bindPorts) ? bindPorts : (bindPorts ? [bindPorts] : []);

    const config = {
      mode,
      vlan,
      username,
      password,
      bindPorts: portsList
    };

    const result = provisionWanConnection(deviceId, config);
    if (!result.success) {
      return res.status(400).send(result.message);
    }

    // Auto-create PPPoE Secret in MikroTik if enabled
    if (mode === 'pppoe' && username && password && getSetting('mikrotik_enabled', 0)) {
      createPPPoESecret(username, password).catch(err => {
        logger.error(`[MikroTik] Auto-create PPPoE Secret failed: ${err.message}`);
      });
    }

    logger.info(`[ACS] Admin triggered WAN provisioning on ${deviceId}: Mode=${mode}, VLAN=${vlan}`);
    res.redirect(`/admin/devices/${deviceId}`);
  } catch (err) {
    logger.error('WAN provisioning error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Virtual Parameters manager
router.get('/virtual-params', (req, res) => {
  try {
    const params = db.prepare('SELECT * FROM acs_virtual_params ORDER BY name ASC').all();
    res.render('admin/virtual_params', { params });
  } catch (err) {
    logger.error('Virtual params view error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/virtual-params', (req, res) => {
  try {
    const { name, paths, type, is_writable, description, id } = req.body;
    const writableInt = is_writable === 'on' || is_writable === '1' ? 1 : 0;
    
    // Validate paths as JSON array
    try {
      const parsed = JSON.parse(paths);
      if (!Array.isArray(parsed)) throw new Error('Must be an array');
    } catch (_) {
      return res.status(400).send('Paths must be a valid JSON array of strings, e.g. ["InternetGatewayDevice.Path.1.SSID"]');
    }

    if (id) {
      // Edit
      db.prepare(`
        UPDATE acs_virtual_params 
        SET name = ?, paths = ?, type = ?, is_writable = ?, description = ?
        WHERE id = ?
      `).run(name, paths, type, writableInt, description, id);
    } else {
      // Add
      db.prepare(`
        INSERT INTO acs_virtual_params (name, paths, type, is_writable, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(name, paths, type, writableInt, description);
    }

    res.redirect('/admin/virtual-params');
  } catch (err) {
    logger.error('Save virtual param error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/virtual-params/delete', (req, res) => {
  try {
    const { id } = req.body;
    db.prepare('DELETE FROM acs_virtual_params WHERE id = ?').run(id);
    res.redirect('/admin/virtual-params');
  } catch (err) {
    logger.error('Delete virtual param error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// User accounts manager
router.get('/users', async (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.*, d.serial_number as device_sn 
      FROM users u
      LEFT JOIN acs_devices d ON u.assigned_device_id = d.id
      ORDER BY u.role ASC, u.username ASC
    `).all();

    let devices = [];
    if (genieacs.isGenieAcsEnabled()) {
      devices = await genieacs.getDevices();
    } else {
      const rows = db.prepare('SELECT id, serial_number, manufacturer, params FROM acs_devices').all();
      devices = rows.map(dev => ({
        id: dev.id,
        serial_number: dev.serial_number,
        manufacturer: dev.manufacturer,
        params: dev.params
      }));
    }

    devices = devices.map(dev => {
      let params = {};
      try { params = JSON.parse(dev.params || '{}'); } catch (_) {}
      const vParams = resolveVirtualParams(params);
      return {
        id: dev.id,
        serial_number: dev.serial_number,
        manufacturer: dev.manufacturer,
        pppoeUser: vParams.PPPoEUser || null
      };
    });

    res.render('admin/users', { users, devices });
  } catch (err) {
    logger.error('Users list view error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/users', (req, res) => {
  try {
    const { username, password, role, name, phone, assigned_device_id, id } = req.body;
    const { sha256 } = require('../config/database');

    const devId = assigned_device_id === '' ? null : assigned_device_id;
    let cleanPhone = phone ? phone.replace(/\D/g, '') : null;
    if (cleanPhone) {
      if (cleanPhone.startsWith('0')) {
        cleanPhone = '62' + cleanPhone.substring(1);
      } else if (!cleanPhone.startsWith('62') && cleanPhone.length > 5) {
        cleanPhone = '62' + cleanPhone;
      }
    }

    if (id) {
      // Edit user
      if (password) {
        const hash = sha256(password);
        db.prepare(`
          UPDATE users 
          SET username = ?, password_hash = ?, role = ?, name = ?, phone = ?, assigned_device_id = ?, updated_at = NOW_LOCAL()
          WHERE id = ?
        `).run(username, hash, role, name, cleanPhone, devId, id);
      } else {
        db.prepare(`
          UPDATE users 
          SET username = ?, role = ?, name = ?, phone = ?, assigned_device_id = ?, updated_at = NOW_LOCAL()
          WHERE id = ?
        `).run(username, role, name, cleanPhone, devId, id);
      }
    } else {
      // Add user
      const hash = sha256(password || 'customer123');
      db.prepare(`
        INSERT INTO users (username, password_hash, role, name, phone, assigned_device_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(username, hash, role, name, cleanPhone, devId);
    }

    res.redirect('/admin/users');
  } catch (err) {
    logger.error('Save user error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/users/delete', (req, res) => {
  try {
    const { id } = req.body;
    // Don't let users delete their own logged in account
    if (parseInt(id, 10) === req.session.user.id) {
      return res.status(400).send('You cannot delete your own account');
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.redirect('/admin/users');
  } catch (err) {
    logger.error('Delete user error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// GET settings page
router.get('/settings', (req, res) => {
  try {
    const mtSettings = {
      host: getSetting('mikrotik_host', ''),
      port: getSetting('mikrotik_port', '8728'),
      user: getSetting('mikrotik_user', ''),
      password: getSetting('mikrotik_password', ''),
      enabled: parseInt(getSetting('mikrotik_enabled', '0'), 10)
    };

    const waEnabled = parseInt(getSetting('whatsapp_enabled', '0'), 10);
    const waStatus = global.whatsappStatus || 'closed';
    const waQR = global.whatsappQR || null;

    const generalSettings = {
      companyHeader: getSetting('company_header', 'ACS LITE PORTAL'),
      timezone: getSetting('timezone', 'Asia/Jakarta'),
      sessionSecret: getSetting('session_secret', 'acs-lite-secret-session-key-12345')
    };

    const genieacsSettings = {
      enabled: parseInt(getSetting('genieacs_enabled', '0'), 10),
      url: getSetting('genieacs_url', 'http://localhost:7557')
    };

    const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    const acsUrl = `${protocol}://${req.headers.host}/acs`;

    res.render('admin/settings', {
      mtSettings,
      waEnabled,
      waStatus,
      waQR,
      generalSettings,
      acsUrl,
      genieacsSettings
    });
  } catch (err) {
    logger.error('Settings view route error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// POST save general settings
router.post('/settings/general', (req, res) => {
  try {
    const { companyHeader, timezone, sessionSecret } = req.body;

    saveSetting('company_header', companyHeader || 'ACS LITE PORTAL');
    saveSetting('timezone', timezone || 'Asia/Jakarta');
    
    if (sessionSecret) {
      saveSetting('session_secret', sessionSecret);
    }

    logger.info(`[Settings] General configurations updated.`);
    res.redirect('/admin/settings');
  } catch (err) {
    logger.error('Save general settings error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// GET WhatsApp connection status (AJAX)
router.get('/settings/whatsapp/status', (req, res) => {
  res.json({
    enabled: parseInt(getSetting('whatsapp_enabled', '0'), 10),
    status: global.whatsappStatus || 'closed',
    qr: global.whatsappQR || null
  });
});

// POST save MikroTik settings
router.post('/settings/mikrotik', (req, res) => {
  try {
    const { host, port, user, password, enabled } = req.body;
    const enabledInt = enabled === '1' ? 1 : 0;

    saveSetting('mikrotik_host', host);
    saveSetting('mikrotik_port', port || '8728');
    saveSetting('mikrotik_user', user);
    saveSetting('mikrotik_enabled', enabledInt);

    // Only update password if a new value is submitted
    if (password && password !== '••••••••') {
      saveSetting('mikrotik_password', password);
    }

    logger.info(`[MikroTik] Settings updated. Enabled=${enabledInt}`);
    res.redirect('/admin/settings');
  } catch (err) {
    logger.error('Save MikroTik settings error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// POST test MikroTik connection (AJAX)
router.post('/settings/mikrotik/test', async (req, res) => {
  try {
    const { host, port, user, password } = req.body;
    
    // Resolve password
    let pwd = password;
    if (password === '••••••••' || !password) {
      pwd = getSetting('mikrotik_password', '');
    }

    const testRes = await checkConnection({
      host,
      port: port || 8728,
      user,
      password: pwd
    });

    res.json(testRes);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// POST WhatsApp bot settings toggle
router.post('/settings/whatsapp', (req, res) => {
  try {
    const { enabled } = req.body;
    const enabledInt = enabled === '1' ? 1 : 0;

    saveSetting('whatsapp_enabled', enabledInt);

    if (enabledInt === 1) {
      startWhatsAppBot();
      logger.info('[WhatsApp] Enabled and starting chatbot...');
    } else {
      stopWhatsAppBot();
      logger.info('[WhatsApp] Disabled and stopping chatbot.');
    }

    res.redirect('/admin/settings');
  } catch (err) {
    logger.error('Toggle WhatsApp bot error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// POST WhatsApp bot restart
router.post('/settings/whatsapp/restart', (req, res) => {
  try {
    stopWhatsAppBot();
    setTimeout(() => {
      startWhatsAppBot();
    }, 2000);
    logger.info('[WhatsApp] Triggered bot connection restart.');
    res.redirect('/admin/settings');
  } catch (err) {
    logger.error('Restart WhatsApp bot error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// POST WhatsApp logout / session delete
router.post('/settings/whatsapp/logout', (req, res) => {
  try {
    stopWhatsAppBot();

    const authDir = path.join(__dirname, '../database/auth_info_baileys');
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      logger.info('[WhatsApp] Cleared authentication session credentials folder.');
    }

    res.redirect('/admin/settings');
  } catch (err) {
    logger.error('WhatsApp logout error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// POST save GenieACS settings
router.post('/settings/genieacs', (req, res) => {
  try {
    const { url, enabled } = req.body;
    const enabledInt = enabled === '1' ? 1 : 0;

    saveSetting('genieacs_enabled', enabledInt);
    saveSetting('genieacs_url', url || 'http://localhost:7557');

    logger.info(`[GenieACS] Settings updated. Enabled=${enabledInt}`);
    res.redirect('/admin/settings');
  } catch (err) {
    logger.error('Save GenieACS settings error: ' + err.message);
    res.status(500).send('Internal Server Error');
  }
});

// POST test GenieACS connection (AJAX)
router.post('/settings/genieacs/test', async (req, res) => {
  try {
    const { url } = req.body;
    const testRes = await genieacs.testConnection(url);
    res.json(testRes);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

module.exports = router;
