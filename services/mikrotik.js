'use strict';

const { RouterOSClient } = require('routeros-client');
const { getSetting } = require('../config/database');
const { logger } = require('../config/logger');

// Dynamic connection manager based on DB configurations
async function getMikrotikConnection(customConfig = null) {
  const host = customConfig ? customConfig.host : getSetting('mikrotik_host', '');
  const port = customConfig ? parseInt(customConfig.port, 10) : parseInt(getSetting('mikrotik_port', '8728'), 10);
  const user = customConfig ? customConfig.user : getSetting('mikrotik_user', '');
  const password = customConfig ? customConfig.password : getSetting('mikrotik_password', '');

  if (!host || !user) {
    throw new Error('MikroTik configurations are not fully set up in the database settings.');
  }

  const client = new RouterOSClient({
    host,
    port: port || 8728,
    user,
    password,
    timeout: 5000,
    tls: port === 8729 // Default TLS if port is 8729
  });

  await client.connect();
  
  // Expose simplified send API
  client.send = async (words) => {
    if (!client.rosApi || typeof client.rosApi.write !== 'function') {
      throw new Error('MikroTik API connection is not active.');
    }
    return await client.rosApi.write(words);
  };

  return client;
}

// Check if credentials are valid
async function checkConnection(config = null) {
  let client = null;
  try {
    client = await getMikrotikConnection(config);
    const identity = await client.send(['/system/identity/print']);
    return { 
      success: true, 
      identity: identity && identity[0] ? identity[0].name : 'RouterOS' 
    };
  } catch (err) {
    logger.warn(`[MikroTik] Connection check failed: ${err.message}`);
    return { success: false, message: err.message };
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
  }
}

// Retrieve live active PPPoE details for an ONU client username
async function getPPPoEActiveSession(username) {
  if (!getSetting('mikrotik_enabled', 0)) {
    return { status: 'disabled', message: 'MikroTik monitoring is disabled.' };
  }

  let client = null;
  try {
    client = await getMikrotikConnection();
    const sessions = await client.send([
      '/ppp/active/print',
      `?name=${username}`
    ]);

    if (sessions && sessions.length > 0) {
      const sess = sessions[0];
      return {
        status: 'active',
        active: true,
        ip: sess.address,
        callerId: sess['caller-id'] || 'N/A',
        uptime: sess.uptime,
        bytesIn: sess['bytes-in'] || '0',
        bytesOut: sess['bytes-out'] || '0'
      };
    }
    return { status: 'inactive', active: false };
  } catch (err) {
    logger.warn(`[MikroTik] Failed to fetch active PPPoE session for ${username}: ${err.message}`);
    return { status: 'error', active: false, message: err.message };
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
  }
}

// Create PPPoE Secret inside RouterOS during ONU provisioning
async function createPPPoESecret(username, password, profile = 'default') {
  if (!getSetting('mikrotik_enabled', 0)) return { success: false, reason: 'disabled' };
  
  let client = null;
  try {
    client = await getMikrotikConnection();
    
    // Check if secret already exists
    const existing = await client.send([
      '/ppp/secret/print',
      `?name=${username}`
    ]);

    if (existing && existing.length > 0) {
      // Update
      await client.send([
        '/ppp/secret/set',
        `=.id=${existing[0]['.id']}`,
        `=password=${password}`,
        `=profile=${profile}`
      ]);
      logger.info(`[MikroTik] Updated PPPoE Secret: ${username}`);
    } else {
      // Add
      await client.send([
        '/ppp/secret/add',
        `=name=${username}`,
        `=password=${password}`,
        `=service=pppoe`,
        `=profile=${profile}`
      ]);
      logger.info(`[MikroTik] Created new PPPoE Secret: ${username}`);
    }
    return { success: true };
  } catch (err) {
    logger.error(`[MikroTik] Failed to create/update PPPoE Secret ${username}: ${err.message}`);
    return { success: false, message: err.message };
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
  }
}

// Remove PPPoE Secret
async function deletePPPoESecret(username) {
  if (!getSetting('mikrotik_enabled', 0)) return { success: false };

  let client = null;
  try {
    client = await getMikrotikConnection();
    const existing = await client.send([
      '/ppp/secret/print',
      `?name=${username}`
    ]);

    if (existing && existing.length > 0) {
      await client.send([
        '/ppp/secret/remove',
        `=.id=${existing[0]['.id']}`
      ]);
      logger.info(`[MikroTik] Removed PPPoE Secret: ${username}`);
    }
    return { success: true };
  } catch (err) {
    logger.error(`[MikroTik] Failed to remove PPPoE Secret ${username}: ${err.message}`);
    return { success: false, message: err.message };
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
  }
}

module.exports = {
  checkConnection,
  getPPPoEActiveSession,
  createPPPoESecret,
  deletePPPoESecret
};
