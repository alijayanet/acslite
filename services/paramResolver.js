const db = require('../config/database');

/**
 * Resolves virtual parameters for a device based on its cached raw parameters.
 * 
 * @param {Object} deviceParams - The cached raw parameters from acs_devices.params
 * @returns {Object} A key-value map of virtual parameters (e.g. { RxPower: -21.5, WifiSSID24: 'My Wifi' })
 */
function resolveVirtualParams(deviceParams) {
  const resolved = {};
  const params = deviceParams || {};
  
  try {
    const vps = db.prepare('SELECT name, paths FROM acs_virtual_params').all();
    
    for (const vp of vps) {
      let paths = [];
      try {
        paths = JSON.parse(vp.paths || '[]');
      } catch (_) {
        paths = [];
      }
      
      let foundValue = null;
      for (const path of paths) {
        if (params.hasOwnProperty(path)) {
          foundValue = params[path];
          break; // Stop at first matching path
        }
      }
      resolved[vp.name] = foundValue;
    }
  } catch (err) {
    console.error('Failed to resolve virtual parameters:', err.message);
  }
  
  return resolved;
}

/**
 * Finds the exact matching device path for a virtual parameter name.
 * Useful when writing a value back to the device.
 * 
 * @param {Object} deviceParams - Cached raw parameters
 * @param {string} vParamName - Virtual parameter name (e.g. 'WifiSSID24')
 * @returns {string|null} The raw TR-069 path (e.g. 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID')
 */
function getDevicePathForVirtualParam(deviceParams, vParamName) {
  const params = deviceParams || {};
  try {
    const vp = db.prepare('SELECT paths FROM acs_virtual_params WHERE name = ?').get(vParamName);
    if (!vp) return null;
    
    let paths = [];
    try {
      paths = JSON.parse(vp.paths || '[]');
    } catch (_) {
      return null;
    }
    
    // 1. Check if the device already has one of the paths
    for (const path of paths) {
      if (params.hasOwnProperty(path)) {
        return path;
      }
    }
    
    // 2. If not, match based on namespace root (TR-181 vs TR-098)
    const isTr181 = Object.keys(params).some(k => k.startsWith('Device.'));
    for (const path of paths) {
      if (isTr181 && path.startsWith('Device.')) {
        return path;
      }
      if (!isTr181 && path.startsWith('InternetGatewayDevice.')) {
        return path;
      }
    }
    
    // Fallback to first path in definition
    return paths[0] || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  resolveVirtualParams,
  getDevicePathForVirtualParam
};
