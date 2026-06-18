'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const db = require('../config/database');
const { logger } = require('../config/logger');

const SESSION_TIMEOUT_MS = 120000; // 2 minutes
const MAX_TASKS_PER_DEVICE = 30;

// Memory caches
const sessionCache = new Map();
const lastDeviceByIp = new Map();
const recentFaultLogs = new Map();
const activeTriggers = new Map();
const lastTriggerTimes = new Map();

// ---------------------------------------------------------
// XML parsing using RegEx (no heavy dependencies)
// ---------------------------------------------------------
function xmlValue(xml, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function hasCwmpMethod(xml, method) {
  const re = new RegExp(`<(?:[\\w-]+:)?${method}[\\s>]`, 'i');
  return re.test(xml);
}

function extractCwmpId(xml) {
  const m = xml.match(/<(?:[\w-]+:)?ID[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?ID>/i);
  return m ? m[1].trim() : '1';
}

function parseDeviceId(xml) {
  const deviceIdBlock = xmlValue(xml, 'DeviceId');
  if (!deviceIdBlock) return null;
  return {
    Manufacturer: xmlValue(deviceIdBlock, 'Manufacturer'),
    OUI: xmlValue(deviceIdBlock, 'OUI'),
    SerialNumber: xmlValue(deviceIdBlock, 'SerialNumber'),
    ProductClass: xmlValue(deviceIdBlock, 'ProductClass'),
  };
}

function parseParameterValues(xml) {
  const params = {};
  const structRe = /<(?:[\w-]+:)?ParameterValueStruct>([\s\S]*?)<\/(?:[\w-]+:)?ParameterValueStruct>/gi;
  let m;
  while ((m = structRe.exec(xml)) !== null) {
    const block = m[1];
    const name = xmlValue(block, 'Name');
    const value = xmlValue(block, 'Value');
    if (name) {
      params[name] = value;
    }
  }
  return params;
}

function parseGetParameterNamesResponse(xml) {
  const names = [];
  const structRe = /<(?:[\w-]+:)?ParameterInfoStruct>([\s\S]*?)<\/(?:[\w-]+:)?ParameterInfoStruct>/gi;
  let m;
  while ((m = structRe.exec(xml)) !== null) {
    const block = m[1];
    const name = xmlValue(block, 'Name');
    if (name) names.push(name);
  }
  return names;
}

function parseAddObjectResponse(xml) {
  return {
    instanceNumber: xmlValue(xml, 'InstanceNumber'),
    status: xmlValue(xml, 'Status'),
  };
}

function parseSetParameterValuesResponseStatus(xml) {
  return xmlValue(xml, 'Status') || '0';
}

function parseFault(xml) {
  if (!/<(?:[\w-]+:)?Fault/i.test(xml)) return null;
  return {
    faultCode: xmlValue(xml, 'FaultCode') || xmlValue(xml, 'faultcode'),
    faultString: xmlValue(xml, 'FaultString') || xmlValue(xml, 'faultstring'),
    detail: xmlValue(xml, 'detail') || xmlValue(xml, 'Detail'),
  };
}

function escapeXml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------
// SOAP Envelope Builders
// ---------------------------------------------------------
function soapEnvelopeWrap(cwmpId, bodyContent) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:cwmp="urn:dslforum-org:cwmp-1-0"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/">
  <soap:Header>
    <cwmp:ID soap:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap:Header>
  <soap:Body>
    ${bodyContent}
  </soap:Body>
</soap:Envelope>`;
}

function buildInformResponse(cwmpId) {
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:InformResponse>
      <MaxEnvelopes>1</MaxEnvelopes>
    </cwmp:InformResponse>`
  );
}

function buildReboot(cwmpId) {
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:Reboot>
      <CommandKey>reboot-${Date.now()}</CommandKey>
    </cwmp:Reboot>`
  );
}

function buildFactoryReset(cwmpId) {
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:FactoryReset></cwmp:FactoryReset>`
  );
}

function buildSetParameterValues(cwmpId, parameterValues) {
  const pvList = (parameterValues || []).map(pv => {
    const name = pv[0];
    const value = pv[1];
    const xsdType = pv[2] || 'xsd:string';
    return `        <ParameterValueStruct>
          <Name>${escapeXml(name)}</Name>
          <Value xsi:type="${escapeXml(xsdType)}">${escapeXml(String(value))}</Value>
        </ParameterValueStruct>`;
  }).join('\n');

  const arrayType = `cwmp:ParameterValueStruct[${parameterValues.length}]`;
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:SetParameterValues>
      <ParameterList soap-enc:arrayType="${arrayType}">
${pvList}
      </ParameterList>
      <ParameterKey>${Date.now()}</ParameterKey>
    </cwmp:SetParameterValues>`
  );
}

function buildGetParameterValues(cwmpId, parameterNames) {
  const names = (parameterNames || []).map(n =>
    `        <string>${escapeXml(n)}</string>`
  ).join('\n');

  return soapEnvelopeWrap(cwmpId,
    `<cwmp:GetParameterValues>
      <ParameterNames soap-enc:arrayType="xsd:string[${parameterNames.length}]">
${names}
      </ParameterNames>
    </cwmp:GetParameterValues>`
  );
}

function buildGetParameterNames(cwmpId, objectName, nextLevel = 0) {
  let path = objectName || '';
  if (path && !path.endsWith('.')) path += '.';
  const nl = nextLevel ? '1' : '0';
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:GetParameterNames>
      <ParameterPath>${escapeXml(path)}</ParameterPath>
      <NextLevel>${nl}</NextLevel>
    </cwmp:GetParameterNames>`
  );
}

function buildAddObject(cwmpId, objectName) {
  let path = objectName || '';
  if (path && !path.endsWith('.')) path += '.';
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:AddObject>
      <ObjectName>${escapeXml(path)}</ObjectName>
      <ParameterKey></ParameterKey>
    </cwmp:AddObject>`
  );
}

function buildDeleteObject(cwmpId, objectName) {
  return soapEnvelopeWrap(cwmpId,
    `<cwmp:DeleteObject>
      <ObjectName>${escapeXml(objectName)}</ObjectName>
      <ParameterKey></ParameterKey>
    </cwmp:DeleteObject>`
  );
}

// ---------------------------------------------------------
// Persistent Session & Database Helpers
// ---------------------------------------------------------
function getOrCreateSessionPersistent(sessionId) {
  if (sessionCache.has(sessionId)) {
    return sessionCache.get(sessionId);
  }
  
  try {
    const stored = db.prepare(`
      SELECT device_id, step, current_task_id 
      FROM acs_sessions WHERE session_id = ?
    `).get(sessionId);
    
    if (stored) {
      const session = {
        deviceId: stored.device_id,
        step: stored.step || 'init',
        currentTaskId: stored.current_task_id,
        lastActivity: Date.now()
      };
      sessionCache.set(sessionId, session);
      return session;
    }
  } catch (e) {
    logger.debug(`Failed to load session from DB: ${e.message}`);
  }
  
  return {
    deviceId: null,
    step: 'init',
    currentTaskId: null,
    lastActivity: Date.now()
  };
}

function persistSession(sessionId, session) {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO acs_sessions 
      (session_id, device_id, step, current_task_id, last_activity)
      VALUES (?, ?, ?, ?, NOW_LOCAL())
    `).run(sessionId, session.deviceId || null, session.step || 'init', session.currentTaskId || null);
    
    sessionCache.set(sessionId, session);
  } catch (e) {
    logger.error(`Failed to persist session: ${e.message}`);
  }
}

function getOrCreateSession(req, res) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)acs_session=([^;]+)/);
  let sid = match ? match[1] : null;

  if (sid) {
    const sess = getOrCreateSessionPersistent(sid);
    if (sess && sess.deviceId) {
      sess.lastActivity = Date.now();
      persistSession(sid, sess);
      return { sid, session: sess };
    }
  }

  sid = crypto.randomBytes(16).toString('hex');
  const session = { deviceId: null, step: 'init', currentTaskId: null, lastActivity: Date.now() };
  persistSession(sid, session);
  res.setHeader('Set-Cookie', `acs_session=${sid}; Path=/acs; HttpOnly`);
  return { sid, session };
}

function checkTaskQueueLimit(deviceId) {
  try {
    const pending = db.prepare(`
      SELECT COUNT(*) as cnt FROM acs_tasks 
      WHERE device_id = ? AND status IN ('pending', 'in_progress')
    `).get(deviceId);
    
    if (pending && pending.cnt >= MAX_TASKS_PER_DEVICE) {
      logger.warn(`[ACS] Task queue full for device ${deviceId}: ${pending.cnt} pending tasks`);
      return false;
    }
    return true;
  } catch (e) {
    logger.error(`Failed to check task queue: ${e.message}`);
    return true;
  }
}

// ---------------------------------------------------------
// Device State Operations
// ---------------------------------------------------------
function upsertDevice(deviceId, deviceInfo, params, ipAddress) {
  const swVer = params['InternetGatewayDevice.DeviceInfo.SoftwareVersion'] || params['Device.DeviceInfo.SoftwareVersion'] || '';
  const hwVer = params['InternetGatewayDevice.DeviceInfo.HardwareVersion'] || params['Device.DeviceInfo.HardwareVersion'] || '';
  const connReqUrl = params['InternetGatewayDevice.ManagementServer.ConnectionRequestURL'] || params['Device.ManagementServer.ConnectionRequestURL'] || '';
  const connReqUser = params['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername'] || params['Device.ManagementServer.ConnectionRequestUsername'] || '';
  const connReqPass = params['InternetGatewayDevice.ManagementServer.ConnectionRequestPassword'] || params['Device.ManagementServer.ConnectionRequestPassword'] || '';

  let ipToSave = ipAddress;
  if (connReqUrl) {
    try {
      const cleanUrl = connReqUrl.trim();
      if (cleanUrl.startsWith('http')) {
        const urlObj = new URL(cleanUrl);
        if (urlObj.hostname && urlObj.hostname !== '0.0.0.0' && urlObj.hostname !== '127.0.0.1') {
          ipToSave = urlObj.hostname;
        }
      }
    } catch (_) {}
  }
  if (ipToSave && ipToSave.startsWith('::ffff:')) {
    ipToSave = ipToSave.slice(7);
  }

  const existing = db.prepare('SELECT id, params, tags FROM acs_devices WHERE id = ?').get(deviceId);
  if (existing) {
    let mergedParams = {};
    try { mergedParams = JSON.parse(existing.params || '{}'); } catch (_) {}
    Object.assign(mergedParams, params);

    db.prepare(`
      UPDATE acs_devices SET
        serial_number = ?,
        manufacturer = ?,
        product_class = ?,
        oui = ?,
        software_version = ?,
        hardware_version = ?,
        ip_address = ?,
        connection_request_url = CASE WHEN ? != '' THEN ? ELSE connection_request_url END,
        connection_request_user = CASE WHEN ? != '' THEN ? ELSE connection_request_user END,
        connection_request_pass = CASE WHEN ? != '' THEN ? ELSE connection_request_pass END,
        params = ?,
        last_inform = NOW_LOCAL(),
        updated_at = NOW_LOCAL()
      WHERE id = ?
    `).run(
      deviceInfo.SerialNumber,
      deviceInfo.Manufacturer,
      deviceInfo.ProductClass,
      deviceInfo.OUI,
      swVer,
      hwVer,
      ipToSave,
      connReqUrl, connReqUrl,
      connReqUser, connReqUser,
      connReqPass, connReqPass,
      JSON.stringify(mergedParams),
      deviceId
    );
  } else {
    db.prepare(`
      INSERT INTO acs_devices
        (id, serial_number, manufacturer, product_class, oui,
         software_version, hardware_version, ip_address,
         connection_request_url, connection_request_user, connection_request_pass,
         tags, params, last_inform)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NOW_LOCAL())
    `).run(
      deviceId,
      deviceInfo.SerialNumber,
      deviceInfo.Manufacturer,
      deviceInfo.ProductClass,
      deviceInfo.OUI,
      swVer,
      hwVer,
      ipToSave,
      connReqUrl,
      connReqUser,
      connReqPass,
      JSON.stringify(params)
    );
  }
}

function mergeDeviceParams(deviceId, newParams) {
  const existing = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!existing) return;

  let merged = {};
  try { merged = JSON.parse(existing.params || '{}'); } catch (_) {}
  Object.assign(merged, newParams);

  db.prepare('UPDATE acs_devices SET params = ?, updated_at = NOW_LOCAL() WHERE id = ?')
    .run(JSON.stringify(merged), deviceId);
}

// Bootstrap virtual parameters queries on first boot/connection
function queueBootstrapTasksIfNeeded(deviceId, currentParams) {
  try {
    if (!checkTaskQueueLimit(deviceId)) return;

    const device = db.prepare('SELECT tags FROM acs_devices WHERE id = ?').get(deviceId);
    if (!device) return;

    let tags = [];
    try { tags = JSON.parse(device.tags || '[]'); } catch (_) {}
    if (tags.includes('bootstrapped')) return;

    // Determine namespace (TR-098 vs TR-181)
    const isTr181 = Object.keys(currentParams).some(k => k.startsWith('Device.'));
    
    // Query virtual parameter definitions from DB
    const virtualParams = db.prepare('SELECT name, paths FROM acs_virtual_params').all();
    const queryPaths = [];

    for (const vp of virtualParams) {
      let paths = [];
      try { paths = JSON.parse(vp.paths || '[]'); } catch (_) {}
      
      // Filter paths that match our schema
      const matchingPaths = paths.filter(p => isTr181 ? p.startsWith('Device.') : p.startsWith('InternetGatewayDevice.'));
      if (matchingPaths.length > 0) {
        // Queue each path in its own task to be extremely safe against unsupported nodes
        queryPaths.push(matchingPaths[0]);
      }
    }

    logger.info(`[ACS] Bootstrapping device ${deviceId}. Queuing queries for ${queryPaths.length} parameters.`);

    // Group paths in batches of 4 parameters to keep requests small but efficient
    const batchSize = 4;
    for (let i = 0; i < queryPaths.length; i += batchSize) {
      const batch = queryPaths.slice(i, i + batchSize);
      db.prepare(
        `INSERT INTO acs_tasks (device_id, name, payload, status)
         VALUES (?, 'getParameterValues', ?, 'pending')`
      ).run(deviceId, JSON.stringify({ parameterNames: batch }));
    }

    // Configure Periodic Inform (300 seconds)
    const informPvs = isTr181 
      ? [
          ['Device.ManagementServer.PeriodicInformEnable', 'true', 'xsd:boolean'],
          ['Device.ManagementServer.PeriodicInformInterval', '300', 'xsd:unsignedInt']
        ]
      : [
          ['InternetGatewayDevice.ManagementServer.PeriodicInformEnable', 'true', 'xsd:boolean'],
          ['InternetGatewayDevice.ManagementServer.PeriodicInformInterval', '300', 'xsd:unsignedInt']
        ];
    
    db.prepare(
      `INSERT INTO acs_tasks (device_id, name, payload, status)
       VALUES (?, 'setParameterValues', ?, 'pending')`
    ).run(deviceId, JSON.stringify({ parameterValues: informPvs }));

    // Mark as bootstrapped
    tags.push('bootstrapped');
    db.prepare('UPDATE acs_devices SET tags = ?, updated_at = NOW_LOCAL() WHERE id = ?')
      .run(JSON.stringify(tags), deviceId);

  } catch (err) {
    logger.error(`[ACS] Bootstrap tasks queuing failed for ${deviceId}: ${err.message}`);
  }
}

// ---------------------------------------------------------
// Task Builders & Response Handlers
// ---------------------------------------------------------
function getNextPendingTask(deviceId) {
  return db.prepare(
    `SELECT * FROM acs_tasks
     WHERE device_id = ? AND status = 'pending'
     ORDER BY id ASC LIMIT 1`
  ).get(deviceId) || null;
}

function completeTask(taskId, result) {
  db.prepare(
    `UPDATE acs_tasks SET status = 'completed', result = ?, updated_at = NOW_LOCAL() WHERE id = ?`
  ).run(result ? JSON.stringify(result) : null, taskId);
}

function failTask(taskId, error) {
  db.prepare(
    `UPDATE acs_tasks SET status = 'failed', result = ?, retry_count = retry_count + 1, updated_at = NOW_LOCAL() WHERE id = ?`
  ).run(error ? JSON.stringify(error) : null, taskId);
}

function buildTaskSoap(cwmpId, task) {
  let payload = {};
  try { payload = JSON.parse(task.payload || '{}'); } catch (_) {}

  switch (task.name) {
    case 'reboot':
      return buildReboot(cwmpId);
    case 'factoryReset':
      return buildFactoryReset(cwmpId);
    case 'setParameterValues': {
      const pvs = payload.parameterValues || payload.values || [];
      if (pvs.length === 0) return null;
      return buildSetParameterValues(cwmpId, pvs);
    }
    case 'getParameterValues': {
      const names = payload.parameterNames || payload.names || [];
      if (names.length === 0) return null;
      return buildGetParameterValues(cwmpId, names);
    }
    case 'getParameterNames': {
      const objName = payload.objectName || payload.object || '';
      const nextLevel = payload.nextLevel ? 1 : 0;
      return buildGetParameterNames(cwmpId, objName, nextLevel);
    }
    case 'addObject': {
      const objName = payload.objectName || payload.object || '';
      return buildAddObject(cwmpId, objName);
    }
    case 'deleteObject': {
      const objName = payload.objectName || payload.object || '';
      return buildDeleteObject(cwmpId, objName);
    }
    default:
      logger.warn(`[ACS] Unknown task type: ${task.name}`);
      return null;
  }
}

// ---------------------------------------------------------
// CWMP Entrypoint Handler
// ---------------------------------------------------------
async function handleCwmpRequest(req, res) {
  try {
    let body = '';
    if (Buffer.isBuffer(req.body)) {
      body = req.body.toString('utf-8');
    } else if (typeof req.body === 'string') {
      body = req.body;
    } else if (req.body) {
      body = String(req.body);
    }

    const cpeIp = req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : req.socket?.remoteAddress || req.ip || '';

    const { sid, session } = getOrCreateSession(req, res);

    // 1. EMPTY POST (Step 2 or 3 of CWMP session)
    if (!body || body.trim().length === 0) {
      return handleEmptyPost(session, sid, res, cpeIp);
    }

    // 2. INFORM POST
    if (hasCwmpMethod(body, 'Inform')) {
      return handleInform(body, session, sid, cpeIp, res);
    }

    // 3. TASK RESPONSES
    if (hasCwmpMethod(body, 'SetParameterValuesResponse')) {
      return handleTaskResponse(body, session, sid, 'setParameterValues', res);
    }
    if (hasCwmpMethod(body, 'RebootResponse')) {
      return handleTaskResponse(body, session, sid, 'reboot', res);
    }
    if (hasCwmpMethod(body, 'FactoryResetResponse')) {
      return handleTaskResponse(body, session, sid, 'factoryReset', res);
    }
    if (hasCwmpMethod(body, 'GetParameterValuesResponse')) {
      return handleGetParameterValuesResponse(body, session, sid, res);
    }
    if (hasCwmpMethod(body, 'GetParameterNamesResponse')) {
      return handleGetParameterNamesResponse(body, session, sid, res);
    }
    if (hasCwmpMethod(body, 'AddObjectResponse')) {
      return handleAddObjectResponse(body, session, sid, res);
    }
    if (hasCwmpMethod(body, 'DeleteObjectResponse')) {
      return handleTaskResponse(body, session, sid, 'deleteObject', res);
    }

    // 4. FAULT RESPONSE
    const fault = parseFault(body);
    if (fault) {
      return handleFault(fault, session, sid, res);
    }

    // Unrecognized SOAP, process next task
    logger.debug(`[ACS] Unrecognized SOAP from session ${sid.substring(0, 8)}, treating as empty`);
    return handleEmptyPost(session, sid, res, cpeIp);

  } catch (err) {
    logger.error(`[ACS] CWMP error: ${err.stack}`);
    res.status(500).set('Content-Type', 'text/xml').send('');
  }
}

function handleInform(body, session, sid, cpeIp, res) {
  const cwmpId = extractCwmpId(body);
  const deviceInfo = parseDeviceId(body);

  if (!deviceInfo || !deviceInfo.SerialNumber) {
    logger.warn(`[ACS] Inform received but failed parsing DeviceId`);
    return res.status(200).set('Content-Type', 'text/xml').send(buildInformResponse(cwmpId));
  }

  const deviceId = `${deviceInfo.OUI || '000000'}-${deviceInfo.ProductClass || 'ONU'}-${deviceInfo.SerialNumber}`;
  const params = parseParameterValues(body);

  logger.info(`[ACS] Inform received from ${deviceId} IP=${cpeIp}`);

  let mergedParams = params;
  try {
    upsertDevice(deviceId, deviceInfo, params, cpeIp);
    const existing = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
    if (existing) {
      mergedParams = JSON.parse(existing.params || '{}');
    }
  } catch (err) {
    logger.error(`[ACS] Failed to write device to DB: ${err.message}`);
  }

  queueBootstrapTasksIfNeeded(deviceId, mergedParams);

  if (cpeIp) {
    lastDeviceByIp.set(String(cpeIp), { deviceId, ts: Date.now() });
  }

  session.deviceId = deviceId;
  session.step = 'informed';
  session.currentTaskId = null;
  session.lastActivity = Date.now();
  persistSession(sid, session);

  res.status(200)
    .set('Content-Type', 'text/xml; charset=utf-8')
    .set('SOAPAction', '')
    .send(buildInformResponse(cwmpId));
}

function handleEmptyPost(session, sid, res, cpeIp = '') {
  if (!session.deviceId) {
    const ipKey = String(cpeIp || '').trim();
    if (ipKey && lastDeviceByIp.has(ipKey)) {
      const rec = lastDeviceByIp.get(ipKey);
      if (Date.now() - rec.ts < SESSION_TIMEOUT_MS) {
        session.deviceId = rec.deviceId;
        session.step = 'inferred';
      }
    }
    if (!session.deviceId) {
      return res.status(204).set('Content-Type', 'text/xml').send('');
    }
  }

  const task = getNextPendingTask(session.deviceId);
  if (!task) {
    logger.debug(`[ACS] No pending tasks for ${session.deviceId}, ending CWMP session (204)`);
    return res.status(204).set('Content-Type', 'text/xml').send('');
  }

  const cwmpId = String(task.id);
  const soapXml = buildTaskSoap(cwmpId, task);

  if (!soapXml) {
    logger.warn(`[ACS] Failed to build SOAP for task ${task.id} (${task.name}), skipping`);
    failTask(task.id, { error: 'Failed building SOAP' });
    return handleEmptyPost(session, sid, res, cpeIp);
  }

  session.currentTaskId = task.id;
  session.step = 'task_sent';
  session.lastActivity = Date.now();
  persistSession(sid, session);

  db.prepare("UPDATE acs_tasks SET status = 'in_progress', updated_at = NOW_LOCAL() WHERE id = ?")
    .run(task.id);

  logger.info(`[ACS] Dispatched task ${task.id} (${task.name}) to device ${session.deviceId}`);
  res.status(200)
    .set('Content-Type', 'text/xml; charset=utf-8')
    .set('SOAPAction', '')
    .send(soapXml);
}

function handleTaskResponse(body, session, sid, taskType, res) {
  const taskId = session.currentTaskId;
  if (taskId) {
    let result = { status: 'ok' };
    if (taskType === 'setParameterValues') {
      result.status = parseSetParameterValuesResponseStatus(body);
      
      // If success, merge values into cached parameters instantly
      if (result.status === '0' || result.status === 0 || result.status === '') {
        try {
          const task = db.prepare('SELECT payload FROM acs_tasks WHERE id = ?').get(taskId);
          if (task) {
            const payload = JSON.parse(task.payload || '{}');
            const pvs = payload.parameterValues || payload.values || [];
            const newParams = {};
            for (const pv of pvs) {
              if (pv && pv[0]) newParams[pv[0]] = pv[1];
            }
            mergeDeviceParams(session.deviceId, newParams);
          }
        } catch (_) {}
      }
    }
    completeTask(taskId, result);
    logger.info(`[ACS] Task ${taskId} (${taskType}) completed for ${session.deviceId}`);
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();
  persistSession(sid, session);

  return handleEmptyPost(session, sid, res);
}

function handleGetParameterValuesResponse(body, session, sid, res) {
  const taskId = session.currentTaskId;
  const params = parseParameterValues(body);

  if (taskId) {
    completeTask(taskId, params);
    logger.info(`[ACS] Task ${taskId} (getParameterValues) completed for ${session.deviceId}`);
  }

  if (session.deviceId && Object.keys(params).length > 0) {
    mergeDeviceParams(session.deviceId, params);
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();
  persistSession(sid, session);

  return handleEmptyPost(session, sid, res);
}

function handleGetParameterNamesResponse(body, session, sid, res) {
  const taskId = session.currentTaskId;
  const names = parseGetParameterNamesResponse(body);

  if (taskId) {
    completeTask(taskId, { names });
    logger.info(`[ACS] Task ${taskId} (getParameterNames) completed for ${session.deviceId}`);
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();
  persistSession(sid, session);

  return handleEmptyPost(session, sid, res);
}

function handleAddObjectResponse(body, session, sid, res) {
  const taskId = session.currentTaskId;
  const result = parseAddObjectResponse(body);

  if (taskId) {
    completeTask(taskId, result);
    logger.info(`[ACS] Task ${taskId} (addObject) completed. New instance: ${result.instanceNumber}`);

    // If there is dynamic provisioning workflows, execute the followups!
    try {
      const task = db.prepare('SELECT payload FROM acs_tasks WHERE id = ?').get(taskId);
      const payload = JSON.parse(task?.payload || '{}');
      
      if (payload.followup && Array.isArray(payload.followup) && payload.followup.length > 0) {
        const instanceVar = payload.instanceVariable || 'instanceNumber';
        const variables = payload.variables || {};
        variables[instanceVar] = String(result.instanceNumber);

        // Queue followup tasks
        for (const fTask of payload.followup) {
          // Hydrate template variables in paths & values
          const hydratedPayload = JSON.parse(JSON.stringify(fTask.payload || {}));
          
          if (hydratedPayload.parameterValues) {
            hydratedPayload.parameterValues = hydratedPayload.parameterValues.map(pv => {
              let pPath = pv[0];
              let pVal = pv[1];
              for (const [vKey, vVal] of Object.entries(variables)) {
                pPath = pPath.replace(`{{${vKey}}}`, vVal);
                if (typeof pVal === 'string') {
                  pVal = pVal.replace(`{{${vKey}}}`, vVal);
                }
              }
              return [pPath, pVal, pv[2]];
            });
          }

          if (hydratedPayload.parameterNames) {
            hydratedPayload.parameterNames = hydratedPayload.parameterNames.map(pn => {
              let pName = pn;
              for (const [vKey, vVal] of Object.entries(variables)) {
                pName = pName.replace(`{{${vKey}}}`, vVal);
              }
              return pName;
            });
          }

          db.prepare(
            `INSERT INTO acs_tasks (device_id, name, payload, status)
             VALUES (?, ?, ?, 'pending')`
          ).run(session.deviceId, fTask.name, JSON.stringify(hydratedPayload));
        }

        // Send connection request to trigger execution
        triggerConnectionRequest(session.deviceId);
      }
    } catch (err) {
      logger.error(`[ACS] Followup tasks scheduling failed: ${err.message}`);
    }
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();
  persistSession(sid, session);

  return handleEmptyPost(session, sid, res);
}

function handleFault(fault, session, sid, res) {
  const taskId = session.currentTaskId;

  logger.warn(`[ACS] Device SOAP Fault from ${session.deviceId}: Code=${fault.faultCode}, String=${fault.faultString}`);

  try {
    db.prepare(`
      INSERT INTO acs_device_faults (device_id, fault_code, fault_string, task_id)
      VALUES (?, ?, ?, ?)
    `).run(session.deviceId, fault.faultCode, fault.faultString, taskId || null);
  } catch (_) {}

  if (taskId) {
    failTask(taskId, fault);
  }

  session.step = 'response_received';
  session.currentTaskId = null;
  session.lastActivity = Date.now();
  persistSession(sid, session);

  return handleEmptyPost(session, sid, res);
}

// ---------------------------------------------------------
// Connection Request Trigger (GET with Basic/Digest Auth)
// ---------------------------------------------------------
function parseWwwAuthenticate(header) {
  const params = {};
  const cleanHeader = header.replace(/^Digest\s+/i, '');
  const parts = cleanHeader.split(/,\s*/);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) {
      const key = part.substring(0, eqIdx).trim();
      let val = part.substring(eqIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.substring(1, val.length - 1);
      }
      params[key] = val;
    }
  }
  return params;
}

function buildDigestAuthorization(method, uri, authParams, username, password) {
  const realm = authParams.realm;
  const nonce = authParams.nonce;
  const opaque = authParams.opaque;
  const qop = authParams.qop;
  
  const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
  
  let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"`;
  
  if (qop) {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');
    authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    const response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
    authHeader += `, response="${response}"`;
  }
  
  if (opaque) {
    authHeader += `, opaque="${opaque}"`;
  }
  
  return authHeader;
}

async function performConnectionRequest(deviceId) {
  try {
    const device = db.prepare('SELECT * FROM acs_devices WHERE id = ?').get(deviceId);
    if (!device || !device.connection_request_url) {
      return { success: false, message: 'No connection URL' };
    }

    const crUrl = device.connection_request_url.trim();
    logger.info(`[ACS] Sending Connection Request to ${deviceId} → ${crUrl}`);

    const url = new URL(crUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 8000,
      rejectUnauthorized: false,
    };

    const crUser = device.connection_request_user || '';
    const crPass = device.connection_request_pass || '';

    if (crUser) {
      options.auth = `${crUser}:${crPass}`;
    }

    return new Promise((resolve) => {
      const runRequest = (authHeader = null) => {
        const reqOpts = { ...options };
        if (authHeader) {
          delete reqOpts.auth;
          reqOpts.headers = reqOpts.headers || {};
          reqOpts.headers['Authorization'] = authHeader;
        }

        const req = transport.request(reqOpts, (resp) => {
          resp.resume();
          logger.info(`[ACS] Connection Request response: HTTP ${resp.statusCode}`);

          if (resp.statusCode === 401 && resp.headers['www-authenticate'] && crUser && !authHeader) {
            const wwwAuth = resp.headers['www-authenticate'];
            try {
              const authParams = parseWwwAuthenticate(wwwAuth);
              const digestHeader = buildDigestAuthorization('GET', options.path, authParams, crUser, crPass);
              return runRequest(digestHeader);
            } catch (err) {
              return resolve({ success: false, message: `Digest build error: ${err.message}` });
            }
          }

          resolve({ success: resp.statusCode < 400, message: `Status code ${resp.statusCode}` });
        });

        req.on('error', (err) => {
          resolve({ success: false, message: err.message });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, message: 'Timeout' });
        });

        req.end();
      };

      runRequest();
    });
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function triggerConnectionRequest(deviceId) {
  if (activeTriggers.has(deviceId)) {
    clearTimeout(activeTriggers.get(deviceId));
  }

  return new Promise((resolve) => {
    const timeoutObj = setTimeout(async () => {
      activeTriggers.delete(deviceId);

      const lastTime = lastTriggerTimes.get(deviceId) || 0;
      if (Date.now() - lastTime < 3000) {
        return resolve({ success: true, message: 'Throttled' });
      }

      lastTriggerTimes.set(deviceId, Date.now());
      const res = await performConnectionRequest(deviceId);
      resolve(res);
    }, 1000);

    activeTriggers.set(deviceId, timeoutObj);
  });
}

// ---------------------------------------------------------
// Provisioning WAN Workflow (Add WAN connection)
// ---------------------------------------------------------
function provisionWanConnection(deviceId, config) {
  const mode = config.mode || 'pppoe'; // pppoe, dhcp, bridge
  const vlanId = parseInt(config.vlan, 10) || 0;
  const username = config.username || '';
  const password = config.password || '';
  const bindPorts = config.bindPorts || []; // ['LAN1', 'LAN2']

  // Find if TR-181 or TR-098
  const device = db.prepare('SELECT params FROM acs_devices WHERE id = ?').get(deviceId);
  if (!device) return { success: false, message: 'Device not found' };

  let currentParams = {};
  try { currentParams = JSON.parse(device.params || '{}'); } catch (_) {}
  const isTr181 = Object.keys(currentParams).some(k => k.startsWith('Device.'));

  if (isTr181) {
    return { success: false, message: 'TR-181 Add WAN provisioning not fully implemented' };
  }

  // TR-098 WAN Configuration
  const isPpp = mode === 'pppoe';
  const connectionType = isPpp ? 'WANPPPConnection' : 'WANIPConnection';
  const baseObject = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice';

  // 1. AddObject to WANDevice.1.WANConnectionDevice (creates instance e.g., WANConnectionDevice.3)
  const task1 = db.prepare(`
    INSERT INTO acs_tasks (device_id, name, payload, status)
    VALUES (?, 'addObject', ?, 'pending')
  `).run(deviceId, JSON.stringify({
    objectName: baseObject,
    instanceVariable: 'wanDeviceIdx',
    followup: [
      {
        name: 'addObject',
        payload: {
          objectName: `${baseObject}.{{wanDeviceIdx}}.${connectionType}`,
          instanceVariable: 'wanConnIdx',
          followup: [
            // Follow-up 1: Config type & credentials
            {
              name: 'setParameterValues',
              payload: {
                parameterValues: [
                  [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.Enable`, 'true', 'xsd:boolean'],
                  [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.ConnectionType`, isPpp ? 'IP_Routed' : 'Bridged', 'xsd:string'],
                  [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.NATEnabled`, 'true', 'xsd:boolean'],
                  ...(isPpp ? [
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.Username`, username, 'xsd:string'],
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.Password`, password, 'xsd:string']
                  ] : [])
                ]
              }
            },
            // Follow-up 2: Config VLAN
            ...(vlanId > 0 ? [
              {
                name: 'setParameterValues',
                payload: {
                  parameterValues: [
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.VLANIDMark`, String(vlanId), 'xsd:unsignedInt'],
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.VLANID`, String(vlanId), 'xsd:unsignedInt'],
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.VLANMode`, '1', 'xsd:unsignedInt']
                  ]
                }
              }
            ] : []),
            // Follow-up 3: Bind LAN interfaces
            ...(bindPorts.length > 0 ? [
              {
                name: 'setParameterValues',
                payload: {
                  parameterValues: [
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.X_HW_LANBind`, bindPorts.join(','), 'xsd:string'],
                    [`${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.X_ZTE_LANBind`, bindPorts.join(','), 'xsd:string']
                  ]
                }
              }
            ] : []),
            // Follow-up 4: Query results
            {
              name: 'getParameterValues',
              payload: {
                parameterNames: [
                  `${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.ExternalIPAddress`,
                  `${baseObject}.{{wanDeviceIdx}}.${connectionType}.{{wanConnIdx}}.ConnectionStatus`
                ]
              }
            }
          ]
        }
      }
    ]
  }));

  logger.info(`[ACS] WAN Provisioning task queued for device ${deviceId}`);
  triggerConnectionRequest(deviceId);

  return { success: true, taskId: Number(task1.lastInsertRowid), message: 'WAN provisioning tasks queued successfully.' };
}

module.exports = {
  handleCwmpRequest,
  triggerConnectionRequest,
  provisionWanConnection
};
