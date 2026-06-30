import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(data));
}

function parseLatLon(value) {
  const parts = String(value || '').split(',').map(Number);
  if (parts.length < 2) return null;

  const lat = parts[0];
  const lon = parts[1];

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  return [lat, lon];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'regatta-assistent/0.3'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function nearestHourlyCurrent(payload) {
  const current = payload?.current || {};
  const hourly = payload?.hourly;

  if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) {
    return current;
  }

  const now = Date.now();
  let bestIndex = 0;
  let bestDiff = Infinity;

  hourly.time.forEach((time, index) => {
    const timestamp = Date.parse(time);
    const diff = Number.isFinite(timestamp) ? Math.abs(timestamp - now) : Infinity;

    if (diff < bestDiff) {
      bestDiff = diff;
      bestIndex = index;
    }
  });

  const out = { ...current };

  for (const key of Object.keys(hourly)) {
    if (key === 'time') continue;
    if (out[key] == null && Array.isArray(hourly[key])) {
      out[key] = hourly[key][bestIndex];
    }
  }

  return out;
}

function normalizeMarineCurrent(marine, units = {}) {
  const out = { ...(marine || {}) };
  const unit = String(units.ocean_current_velocity || '').toLowerCase();

  if (
    Number.isFinite(out.ocean_current_velocity) &&
    (unit.includes('km/h') || unit.includes('kmh'))
  ) {
    out.ocean_current_velocity = out.ocean_current_velocity / 3.6;
  }

  return out;
}

async function getWeather(lat, lon) {
  const weatherUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&wind_speed_unit=ms&timezone=auto&forecast_days=1&model=best_match`;

  const marineUrl =
    `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
    `&current=ocean_current_velocity,ocean_current_direction,wave_height,wave_direction,wave_period` +
    `&hourly=ocean_current_velocity,ocean_current_direction,wave_height,wave_direction,wave_period` +
    `&timezone=auto&forecast_days=1&model=best_match`;

  const [weatherPayload, marinePayload] = await Promise.all([
    fetchJson(weatherUrl),
    fetchJson(marineUrl)
  ]);

  const wind = nearestHourlyCurrent(weatherPayload);
  const marineRaw = nearestHourlyCurrent(marinePayload);
  const marine = normalizeMarineCurrent(
    marineRaw,
    marinePayload.current_units || marinePayload.hourly_units || {}
  );

  return {
    ok: true,
    wind,
    marine,
    source: 'route-api-open-meteo',
    t: Date.now()
  };
}

async function serveStatic(req, res, pathname) {
  let safePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  safePath = safePath.replace(/^\/+/, '');

  const filePath = path.resolve(ROOT, safePath);

  if (!filePath.startsWith(ROOT) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const body = await readFile(filePath);

  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
  });

  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,OPTIONS',
        'access-control-allow-headers': 'content-type'
      });
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'regatta-route-api',
        t: Date.now()
      });
      return;
    }

    if (url.pathname === '/route') {
      const from = parseLatLon(url.searchParams.get('from'));
      const to = parseLatLon(url.searchParams.get('to'));

      if (!from || !to) {
        sendJson(res, 400, {
          ok: false,
          error: 'Mangler eller ugyldig from/to. Bruk format: ?from=59.2,10.7&to=59.3,10.8'
        });
        return;
      }

      sendJson(res, 200, {
        ok: true,
        route: [from, to],
        points: [
          { lat: from[0], lon: from[1] },
          { lat: to[0], lon: to[1] }
        ],
        source: 'direct-server-fallback'
      });
      return;
    }

    if (url.pathname === '/weather') {
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        sendJson(res, 400, {
          ok: false,
          error: 'Mangler eller ugyldig lat/lon'
        });
        return;
      }

      sendJson(res, 200, await getWeather(lat, lon));
      return;
    }

    if (url.pathname === '/weather-grid') {
      const lats = String(url.searchParams.get('lats') || '')
        .split(',')
        .filter(Boolean)
        .map(Number);

      const lons = String(url.searchParams.get('lons') || '')
        .split(',')
        .filter(Boolean)
        .map(Number);

      if (
        !lats.length ||
        lats.length !== lons.length ||
        lats.some(n => !Number.isFinite(n)) ||
        lons.some(n => !Number.isFinite(n))
      ) {
        sendJson(res, 400, {
          ok: false,
          error: 'Ugyldig lats/lons. Bruk format: ?lats=59.2,59.3&lons=10.7,10.8'
        });
        return;
      }

      const points = await Promise.all(
        lats.map(async (lat, index) => {
          const lon = lons[index];
          const data = await getWeather(lat, lon);

          return {
            lat,
            lon,
            ...data
          };
        })
      );

      sendJson(res, 200, {
        ok: true,
        points,
        source: 'route-api-open-meteo-grid',
        t: Date.now()
      });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, {
      ok: false,
      error: err?.message || 'Serverfeil'
    });
  }
});

server.listen(PORT, () => {
  console.log(`Regatta app live on port ${PORT}`);
});