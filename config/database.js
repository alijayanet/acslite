const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { logger } = require('./logger');

const dbDir = path.join(__dirname, '../database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'acs_lite.db');
let db;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Local time helper function
  db.function('NOW_LOCAL', () => {
    let tz = 'Asia/Jakarta';
    try {
      const row = db.prepare("SELECT value FROM app_settings WHERE key = 'timezone'").get();
      if (row) {
        tz = JSON.parse(row.value);
      }
    } catch (_) {
      tz = process.env.TIMEZONE || 'Asia/Jakarta';
    }
    const now = new Date();
    
    const options = {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(now);
    const p = {};
    parts.forEach(part => p[part.type] = part.value);
    
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  });

  logger.info('[DB] SQLite database initialized successfully.');
} catch (err) {
  logger.error('[DB] Database initialization failed: ' + err.message);
  process.exit(1);
}

// Create schema tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL, -- 'admin' or 'customer'
    name TEXT NOT NULL,
    phone TEXT, -- Format: 628123456789
    assigned_device_id TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (NOW_LOCAL()),
    updated_at DATETIME DEFAULT (NOW_LOCAL())
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS acs_devices (
    id TEXT PRIMARY KEY,
    serial_number TEXT,
    manufacturer TEXT,
    product_class TEXT,
    oui TEXT,
    software_version TEXT,
    hardware_version TEXT,
    ip_address TEXT,
    connection_request_url TEXT,
    connection_request_user TEXT,
    connection_request_pass TEXT,
    tags TEXT DEFAULT '[]',
    params TEXT DEFAULT '{}',
    last_inform DATETIME,
    created_at DATETIME DEFAULT (NOW_LOCAL()),
    updated_at DATETIME DEFAULT (NOW_LOCAL())
  );

  CREATE TABLE IF NOT EXISTS acs_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    name TEXT NOT NULL, -- reboot, setParameterValues, getParameterValues, refreshObject, addObject
    payload TEXT DEFAULT '{}',
    status TEXT DEFAULT 'pending', -- pending, in_progress, completed, failed
    result TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (NOW_LOCAL()),
    updated_at DATETIME DEFAULT (NOW_LOCAL()),
    FOREIGN KEY (device_id) REFERENCES acs_devices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS acs_sessions (
    session_id TEXT PRIMARY KEY,
    device_id TEXT,
    current_task_id INTEGER,
    step TEXT DEFAULT 'init',
    last_activity DATETIME DEFAULT (NOW_LOCAL()),
    created_at DATETIME DEFAULT (NOW_LOCAL()),
    FOREIGN KEY (device_id) REFERENCES acs_devices(id) ON DELETE CASCADE,
    FOREIGN KEY (current_task_id) REFERENCES acs_tasks(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS acs_device_faults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    fault_code TEXT NOT NULL,
    fault_string TEXT NOT NULL,
    task_id INTEGER,
    seen_count INTEGER DEFAULT 1,
    first_seen DATETIME DEFAULT (NOW_LOCAL()),
    last_seen DATETIME DEFAULT (NOW_LOCAL()),
    resolved INTEGER DEFAULT 0,
    resolved_at DATETIME,
    FOREIGN KEY (device_id) REFERENCES acs_devices(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES acs_tasks(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS acs_virtual_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    paths TEXT NOT NULL, -- JSON array of strings
    type TEXT DEFAULT 'string',
    is_writable INTEGER DEFAULT 0,
    description TEXT,
    created_at DATETIME DEFAULT (NOW_LOCAL())
  );

  CREATE INDEX IF NOT EXISTS idx_acs_devices_sn ON acs_devices(serial_number);
  CREATE INDEX IF NOT EXISTS idx_acs_devices_inform ON acs_devices(last_inform);
  CREATE INDEX IF NOT EXISTS idx_acs_tasks_device ON acs_tasks(device_id);
  CREATE INDEX IF NOT EXISTS idx_acs_tasks_status ON acs_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_acs_sessions_device ON acs_sessions(device_id);
  CREATE INDEX IF NOT EXISTS idx_acs_faults_device ON acs_device_faults(device_id);
`);

// Insert default Admin user
const defaultAdminPass = 'admin123';
const defaultAdminHash = sha256(defaultAdminPass);
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  db.prepare(`
    INSERT INTO users (username, password_hash, role, name) 
    VALUES ('admin', ?, 'admin', 'Administrator')
  `).run(defaultAdminHash);
  logger.info('[DB] Created default admin account (username: admin, password: ' + defaultAdminPass + ')');
}

// Insert default virtual parameters
const defaultVirtualParams = [
  {
    name: 'ModelName',
    type: 'string',
    is_writable: 0,
    description: 'Device Model Name',
    paths: [
      'InternetGatewayDevice.DeviceInfo.ModelName',
      'Device.DeviceInfo.ModelName'
    ]
  },
  {
    name: 'SoftwareVersion',
    type: 'string',
    is_writable: 0,
    description: 'Firmware Software Version',
    paths: [
      'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      'Device.DeviceInfo.SoftwareVersion'
    ]
  },
  {
    name: 'HardwareVersion',
    type: 'string',
    is_writable: 0,
    description: 'Hardware Board Version',
    paths: [
      'InternetGatewayDevice.DeviceInfo.HardwareVersion',
      'Device.DeviceInfo.HardwareVersion'
    ]
  },
  {
    name: 'Uptime',
    type: 'number',
    is_writable: 0,
    description: 'System Uptime in seconds',
    paths: [
      'InternetGatewayDevice.DeviceInfo.UpTime',
      'Device.DeviceInfo.UpTime'
    ]
  },
  {
    name: 'RxPower',
    type: 'number',
    is_writable: 0,
    description: 'Optical Receiver Optical Power (dBm)',
    paths: [
      'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_OpticalSignal.RXPower',
      'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
      'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RxPower',
      'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RXPower',
      'InternetGatewayDevice.WANDevice.1.X_ZTE_GponInterfaceConfig.RxPower',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RXPower',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_ZTE_OpticalSignal.RxPower',
      'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
      'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RxPower',
      'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
      'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
      'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
      'Device.Optical.Interface.1.OpticalSignalLevel',
      'Device.XPON.Interface.1.Stats.RXPower'
    ]
  },
  {
    name: 'ExternalIP',
    type: 'string',
    is_writable: 0,
    description: 'External WAN IP Address',
    paths: [
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
      'Device.PPP.Interface.1.ExternalIPAddress'
    ]
  },
  {
    name: 'PPPoEUser',
    type: 'string',
    is_writable: 1,
    description: 'PPPoE Username',
    paths: [
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
      'Device.PPP.Interface.1.Username'
    ]
  },
  {
    name: 'PPPoEPass',
    type: 'string',
    is_writable: 1,
    description: 'PPPoE Password',
    paths: [
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Password',
      'Device.PPP.Interface.1.Password'
    ]
  },
  {
    name: 'WifiSSID24',
    type: 'string',
    is_writable: 1,
    description: 'SSID name for 2.4 GHz Wi-Fi',
    paths: [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
      'Device.WiFi.SSID.1.SSID'
    ]
  },
  {
    name: 'WifiPass24',
    type: 'string',
    is_writable: 1,
    description: 'Password key for 2.4 GHz Wi-Fi',
    paths: [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
      'Device.WiFi.AccessPoint.1.Security.KeyPassphrase'
    ]
  },
  {
    name: 'WifiSSID5',
    type: 'string',
    is_writable: 1,
    description: 'SSID name for 5 GHz Wi-Fi',
    paths: [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID',
      'Device.WiFi.SSID.2.SSID'
    ]
  },
  {
    name: 'WifiPass5',
    type: 'string',
    is_writable: 1,
    description: 'Password key for 5 GHz Wi-Fi',
    paths: [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.PreSharedKey',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.PreSharedKey.1.PreSharedKey',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.KeyPassphrase',
      'Device.WiFi.AccessPoint.2.Security.KeyPassphrase'
    ]
  }
];

const insertVParam = db.prepare(`
  INSERT OR IGNORE INTO acs_virtual_params (name, paths, type, is_writable, description)
  VALUES (?, ?, ?, ?, ?)
`);

db.transaction(() => {
  for (const vp of defaultVirtualParams) {
    insertVParam.run(vp.name, JSON.stringify(vp.paths), vp.type, vp.is_writable, vp.description);
  }
})();
logger.info('[DB] Inserted default dynamic virtual parameters.');

// Insert default app settings
const defaultSettings = [
  { key: 'company_header', value: '"ACS LITE PORTAL"' },
  { key: 'timezone', value: '"Asia/Jakarta"' },
  { key: 'session_secret', value: '"acs-lite-secret-session-key-12345"' },
  { key: 'mikrotik_enabled', value: '0' },
  { key: 'whatsapp_enabled', value: '0' },
  { key: 'genieacs_enabled', value: '0' },
  { key: 'genieacs_url', value: '"http://localhost:7557"' }
];

const insertSetting = db.prepare(`
  INSERT OR IGNORE INTO app_settings (key, value)
  VALUES (?, ?)
`);

db.transaction(() => {
  for (const s of defaultSettings) {
    insertSetting.run(s.key, s.value);
  }
})();
logger.info('[DB] Inserted default app settings.');

// Run migration for phone column
try {
  db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  logger.info("[DB] Added phone column to users table successfully.");
} catch (e) {
  // Ignore if column already exists
}

function getSetting(key, defaultValue = null) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

function saveSetting(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
    return true;
  } catch (err) {
    logger.error(`Failed to save setting ${key}: ${err.message}`);
    return false;
  }
}

module.exports = db;
module.exports.sha256 = sha256;
module.exports.getSetting = getSetting;
module.exports.saveSetting = saveSetting;
