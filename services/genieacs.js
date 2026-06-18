'use strict';

const { getSetting } = require('../config/database');
const { logger } = require('../config/logger');

// Helper to check if GenieACS is enabled
function isGenieAcsEnabled() {
  return parseInt(getSetting('genieacs_enabled', '0'), 10) === 1;
}

// Get GenieACS Base URL
function getGenieAcsUrl() {
  let url = getSetting('genieacs_url', 'http://localhost:7557');
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
}

// Check if GenieACS last inform timestamp is online
const ONLINE_THRESHOLD_MS = 600000; // 10 minutes
function isOnline(lastInform) {
  if (!lastInform) return false;
  return (Date.now() - new Date(lastInform).getTime()) < ONLINE_THRESHOLD_MS;
}

// Recursively flattens GenieACS nested parameters structure to match ACS Lite format
function flattenGenieACSDocument(obj, prefix = '') {
  let params = {};
  if (!obj || typeof obj !== 'object') return params;

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) continue; // Skip metadata keys at this level
    
    const currentPath = prefix ? `${prefix}.${key}` : key;
    
    if (val && typeof val === 'object') {
      if (val.hasOwnProperty('_value')) {
        params[currentPath] = val._value;
      } else {
        // Recurse deeper
        Object.assign(params, flattenGenieACSDocument(val, currentPath));
      }
    }
  }
  return params;
}

// Test connection to GenieACS URL
async function testConnection(url) {
  try {
    let cleanUrl = url || getGenieAcsUrl();
    if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);
    
    const response = await fetch(`${cleanUrl}/devices?limit=1`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000)
    });
    
    if (response.ok) {
      return { success: true, message: 'Koneksi ke GenieACS API berhasil!' };
    }
    return { success: false, message: `GenieACS merespon dengan status: ${response.status}` };
  } catch (err) {
    return { success: false, message: `Koneksi gagal: ${err.message}` };
  }
}

// Fetch all devices from GenieACS
async function getDevices() {
  try {
    const url = getGenieAcsUrl();
    // Projection to keep payload small
    const response = await fetch(`${url}/devices?projection=_deviceId._OUI,_deviceId._ProductClass,_deviceId._SerialNumber,_lastInform,_ip,InternetGatewayDevice.DeviceInfo.Manufacturer,InternetGatewayDevice.DeviceInfo.SoftwareVersion,Device.DeviceInfo.Manufacturer,Device.DeviceInfo.SoftwareVersion`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const genieDevices = await response.json();
    
    return genieDevices.map(dev => {
      const serial = dev._deviceId?._SerialNumber || 'Unknown';
      
      // Attempt to extract manufacturer
      let manufacturer = dev._deviceId?._OUI || 'Unknown';
      if (dev.InternetGatewayDevice?.DeviceInfo?.Manufacturer?._value) {
        manufacturer = dev.InternetGatewayDevice.DeviceInfo.Manufacturer._value;
      } else if (dev.Device?.DeviceInfo?.Manufacturer?._value) {
        manufacturer = dev.Device.DeviceInfo.Manufacturer._value;
      }

      const pClass = dev._deviceId?._ProductClass || 'Unknown';
      const lastInform = dev._lastInform || null;
      const ip = dev._ip || '0.0.0.0';

      // Flatten parameters to resolve virtual params in list if needed
      const flatParams = flattenGenieACSDocument(dev);

      return {
        id: dev._id,
        serial_number: serial,
        oui: dev._deviceId?._OUI || '',
        manufacturer,
        product_class: pClass,
        ip_address: ip,
        last_inform: lastInform,
        online: isOnline(lastInform),
        params: JSON.stringify(flatParams)
      };
    });
  } catch (err) {
    logger.error('[GenieACS] Failed to get devices: ' + err.message);
    return [];
  }
}

// Fetch single device details from GenieACS
async function getDevice(id) {
  try {
    const url = getGenieAcsUrl();
    const query = encodeURIComponent(JSON.stringify({ _id: id }));
    const response = await fetch(`${url}/devices?query=${query}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const list = await response.json();
    if (!list || list.length === 0) {
      return null;
    }

    const dev = list[0];
    const flatParams = flattenGenieACSDocument(dev);
    
    let manufacturer = dev._deviceId?._OUI || 'Unknown';
    if (dev.InternetGatewayDevice?.DeviceInfo?.Manufacturer?._value) {
      manufacturer = dev.InternetGatewayDevice.DeviceInfo.Manufacturer._value;
    } else if (dev.Device?.DeviceInfo?.Manufacturer?._value) {
      manufacturer = dev.Device.DeviceInfo.Manufacturer._value;
    }

    return {
      id: dev._id,
      serial_number: dev._deviceId?._SerialNumber || 'Unknown',
      oui: dev._deviceId?._OUI || '',
      manufacturer,
      product_class: dev._deviceId?._ProductClass || 'Unknown',
      ip_address: dev._ip || '0.0.0.0',
      last_inform: dev._lastInform || null,
      online: isOnline(dev._lastInform),
      params: JSON.stringify(flatParams)
    };
  } catch (err) {
    logger.error(`[GenieACS] Failed to get device ${id}: ${err.message}`);
    return null;
  }
}

// Queue task to GenieACS (Generic REST API task dispatcher)
async function queueTask(deviceId, task) {
  try {
    const url = getGenieAcsUrl();
    // In GenieACS, adding "?connection_request" to NBI task queue triggers immediate connection request
    const response = await fetch(`${url}/devices/${deviceId}/tasks?connection_request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(task)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    logger.info(`[GenieACS] Successfully queued task "${task.name}" for ${deviceId}`);
    return { success: true };
  } catch (err) {
    logger.error(`[GenieACS] Failed to queue task on ${deviceId}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Specific task helpers
async function reboot(deviceId) {
  return await queueTask(deviceId, { name: 'reboot' });
}

async function setParameterValues(deviceId, updates) {
  // updates is array of [path, value, type]
  // In GenieACS, tasks body: { name: 'setParameterValues', parameterValues: [[path, value, type]] }
  // Clean up SOAP types (e.g. 'xsd:string') to GenieACS native types ('string')
  const mappedUpdates = (updates || []).map(([path, val, type]) => {
    let cleanType = type || 'string';
    if (cleanType.startsWith('xsd:')) {
      cleanType = cleanType.substring(4);
    }
    return [path, val, cleanType];
  });

  return await queueTask(deviceId, {
    name: 'setParameterValues',
    parameterValues: mappedUpdates
  });
}

async function refreshObject(deviceId, objectName) {
  return await queueTask(deviceId, {
    name: 'refreshObject',
    objectName: objectName
  });
}

module.exports = {
  isGenieAcsEnabled,
  getGenieAcsUrl,
  testConnection,
  getDevices,
  getDevice,
  queueTask,
  reboot,
  setParameterValues,
  refreshObject
};
