const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3004;

// In-memory cache: 60-minute TTL
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// Fetch with 12s timeout
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Health-based violation category codes per EPA
const HEALTH_BASED_CATEGORIES = new Set([
  'MCL',    // Maximum Contaminant Level
  'MRDL',   // Maximum Residual Disinfectant Level
  'TT',     // Treatment Technique
  'PN',     // Public Notice (health-based)
]);

function isHealthBased(violation) {
  const cat = (violation.VIOLATION_CATEGORY_CODE || '').toUpperCase();
  return HEALTH_BASED_CATEGORIES.has(cat);
}

function formatViolation(v) {
  return {
    pwsid: v.PWSID || '',
    violationId: v.VIOLATION_ID || '',
    contaminantCode: v.CONTAMINANT_CODE || '',
    contaminantName: v.CONTAMINANT_NAME || 'Unknown',
    violationCategoryCode: v.VIOLATION_CATEGORY_CODE || '',
    violationCode: v.VIOLATION_CODE || '',
    violationTypeName: v.VIOLATION_TYPE_SHORT_NAME || v.VIOLATION_CODE || '',
    beginDate: v.COMPL_PER_BEGIN_DATE || v.VIOLATION_BEGIN_DATE || '',
    endDate: v.COMPL_PER_END_DATE || v.VIOLATION_END_DATE || '',
    status: v.VIOLATION_STATUS || '',
    isOpen: (v.VIOLATION_STATUS || '').toUpperCase() === 'OPEN',
    healthBased: isHealthBased(v),
  };
}

// Try multiple EPA endpoints for zip search
async function searchByZip(zip) {
  const cacheKey = `zip:${zip}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const urls = [
    `https://enviro.epa.gov/efservice/WATER_SYSTEM/ZIP_CODE/contains/${zip}/JSON`,
    `https://data.epa.gov/efservice/WATER_SYSTEM/ZIP_CODE/${zip}/JSON`,
  ];

  let systems = null;
  let lastError = null;

  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        lastError = `HTTP ${res.status} from ${url}`;
        continue;
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        lastError = `Invalid JSON from ${url}`;
        continue;
      }
      if (Array.isArray(data) && data.length > 0) {
        systems = data;
        break;
      }
      // Some endpoints wrap in an object
      if (data && Array.isArray(data.results)) {
        systems = data.results;
        break;
      }
    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  if (!systems) {
    // Try ECHO API as fallback
    try {
      const echoUrl = `https://echo.epa.gov/api/echo/sdw_rest_services.get_systems?output=JSON&p_zip5=${zip}`;
      const res = await fetchWithTimeout(echoUrl);
      if (res.ok) {
        const data = await res.json();
        // ECHO returns nested structure
        if (data && data.Results && data.Results.WaterSystems) {
          systems = data.Results.WaterSystems.map(ws => ({
            PWSID: ws.PwsId,
            PWS_NAME: ws.PwsName,
            POPULATION_SERVED_COUNT: ws.PopServed,
            PWS_TYPE_CODE: ws.PwsTypeCode,
            PRIMARY_SOURCE_CODE: ws.PrimarySourceCode,
            CITY_NAME: ws.City,
            STATE_CODE: ws.State,
            ZIP_CODE: zip,
          }));
        }
      }
    } catch (err) {
      // ECHO fallback also failed
    }
  }

  if (!systems || systems.length === 0) {
    return { error: lastError || 'No water systems found for this zip code', systems: [] };
  }

  // Filter to only active community water systems and normalize fields
  const result = systems
    .filter(s => {
      const status = (s.PWS_ACTIVITY_CODE || s.STATUS || '').toUpperCase();
      // Include active systems; if field missing, include anyway
      return !status || status === 'A' || status === 'ACTIVE' || status === '';
    })
    .slice(0, 20) // cap at 20
    .map(s => ({
      pwsid: s.PWSID || '',
      name: s.PWS_NAME || 'Unknown System',
      populationServed: parseInt(s.POPULATION_SERVED_COUNT || '0', 10) || 0,
      typeCode: s.PWS_TYPE_CODE || '',
      typeName: pswTypeName(s.PWS_TYPE_CODE),
      primarySource: s.PRIMARY_SOURCE_CODE || '',
      city: s.CITY_NAME || '',
      state: s.STATE_CODE || '',
      zip: s.ZIP_CODE || zip,
      activityCode: s.PWS_ACTIVITY_CODE || '',
    }))
    .sort((a, b) => b.populationServed - a.populationServed);

  setCache(cacheKey, { systems: result });
  return { systems: result };
}

function pswTypeName(code) {
  const types = {
    CWS: 'Community Water System',
    NTNCWS: 'Non-Transient Non-Community',
    TNCWS: 'Transient Non-Community',
  };
  return types[(code || '').toUpperCase()] || code || 'Unknown';
}

// Get violations for a specific PWSID
async function getSystemViolations(pwsid) {
  const cacheKey = `violations:${pwsid}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const violationUrls = [
    `https://enviro.epa.gov/efservice/VIOLATION/PWSID/EQUALS/${pwsid}/JSON`,
    `https://data.epa.gov/efservice/VIOLATION/PWSID/${pwsid}/JSON`,
  ];

  const detailUrls = [
    `https://enviro.epa.gov/efservice/WATER_SYSTEM/PWSID/EQUALS/${pwsid}/JSON`,
    `https://data.epa.gov/efservice/WATER_SYSTEM/PWSID/${pwsid}/JSON`,
  ];

  let violations = [];
  let systemDetail = null;

  // Fetch violations
  for (const url of violationUrls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { continue; }
      if (Array.isArray(data)) {
        violations = data;
        break;
      }
    } catch {
      continue;
    }
  }

  // Fetch system detail
  for (const url of detailUrls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { continue; }
      if (Array.isArray(data) && data.length > 0) {
        systemDetail = data[0];
        break;
      }
    } catch {
      continue;
    }
  }

  const formatted = violations.map(formatViolation);
  const healthBased = formatted.filter(v => v.healthBased);
  const monitoring = formatted.filter(v => !v.healthBased);

  const result = {
    pwsid,
    system: systemDetail ? {
      name: systemDetail.PWS_NAME || '',
      populationServed: parseInt(systemDetail.POPULATION_SERVED_COUNT || '0', 10) || 0,
      typeCode: systemDetail.PWS_TYPE_CODE || '',
      typeName: pswTypeName(systemDetail.PWS_TYPE_CODE),
      primarySource: systemDetail.PRIMARY_SOURCE_CODE || '',
      city: systemDetail.CITY_NAME || '',
      state: systemDetail.STATE_CODE || '',
    } : null,
    violations: {
      healthBased,
      monitoring,
      total: formatted.length,
    },
  };

  setCache(cacheKey, result);
  return result;
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/api/search', async (req, res) => {
  const { zip } = req.query;
  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Invalid zip code. Must be 5 digits.' });
  }
  try {
    const data = await searchByZip(zip);
    return res.json(data);
  } catch (err) {
    console.error('Search error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch water system data.' });
  }
});

app.get('/api/system/:pwsid', async (req, res) => {
  const { pwsid } = req.params;
  if (!pwsid || !/^[A-Z0-9]{9,12}$/i.test(pwsid)) {
    return res.status(400).json({ error: 'Invalid PWSID.' });
  }
  try {
    const data = await getSystemViolations(pwsid);
    return res.json(data);
  } catch (err) {
    console.error('System error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch system data.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Water Safety running on http://localhost:${PORT}`);
  });
}
