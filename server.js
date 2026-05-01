require('dotenv').config();
const express  = require('express');
const path     = require('path');
const { transit_realtime } = require('gtfs-realtime-bindings');

const app         = express();
const PORT        = process.env.PORT || 3000;
const BUS_API_KEY = process.env.BUS_API_KEY || '';

// GTFS-RT feed URLs keyed by the lines they carry
const GTFS_FEEDS = {
  '123456S': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  'ACEH':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'BDFM':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'G':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'JZ':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
  'NQRW':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  'L':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
};

// Which feed covers each route
function feedForRoute(route) {
  if ('1234567S'.includes(route)) return GTFS_FEEDS['123456S'];
  if ('ACEH'.includes(route))     return GTFS_FEEDS['ACEH'];
  if ('BDFM'.includes(route))     return GTFS_FEEDS['BDFM'];
  if (route === 'G')              return GTFS_FEEDS['G'];
  if ('JZ'.includes(route))       return GTFS_FEEDS['JZ'];
  if ('NQRW'.includes(route))     return GTFS_FEEDS['NQRW'];
  if (route === 'L')              return GTFS_FEEDS['L'];
  return null;
}

// Fetch and decode a GTFS-RT protobuf feed
async function fetchFeed(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`feed ${r.status}`);
  const buf = await r.arrayBuffer();
  return transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

// Serve the HTML file
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'prospect-place-transit.html'));
});

// Subway: fetch relevant GTFS-RT feeds, filter to requested stop IDs,
// return a simple JSON structure the front-end already knows how to render.
app.get('/api/subway', async (req, res) => {
  const ids = req.query.ids;
  if (!ids) return res.status(400).json({ error: 'ids query param required' });
  if (!/^[A-Z0-9,]+$/i.test(ids)) return res.status(400).json({ error: 'invalid ids' });

  const stopSet = new Set(ids.split(',').map(s => s.trim().toUpperCase()));

  // Determine which feeds we need (deduplicated)
  // We serve Crown Heights–Utica (3/4) and Utica Av A/C so fetch both feeds
  const feedUrls = [...new Set([GTFS_FEEDS['123456S'], GTFS_FEEDS['ACEH']])];

  try {
    const feeds = await Promise.all(feedUrls.map(fetchFeed));

    // Convert to a simple {trips:[{route_id, stop_time_updates:[{stop_id, arrival:{time}}]}]}
    // Note: gtfs-realtime-bindings uses camelCase property names
    const trips = [];
    for (const feed of feeds) {
      for (const entity of feed.entity) {
        if (!entity.tripUpdate) continue;
        const route_id = entity.tripUpdate.trip?.routeId || '';
        const stop_time_updates = (entity.tripUpdate.stopTimeUpdate || [])
          .filter(stu => stopSet.has(stu.stopId))
          .map(stu => ({
            stop_id: stu.stopId,
            arrival:   { time: Number(stu.arrival?.time   || 0) },
            departure: { time: Number(stu.departure?.time || 0) },
          }));
        if (stop_time_updates.length > 0) {
          trips.push({ route_id, stop_time_updates });
        }
      }
    }
    res.json({ trips });
  } catch (e) {
    console.error('subway fetch error:', e.message);
    res.status(502).json({ error: 'upstream error' });
  }
});

// Proxy: BusTime SIRI API (requires BUS_API_KEY env var)
app.get('/api/bus/:code', async (req, res) => {
  const code = req.params.code;
  if (!/^\d+$/.test(code)) return res.status(400).json({ error: 'invalid stop code' });

  if (!BUS_API_KEY) {
    return res.status(503).json({ error: 'BUS_API_KEY not configured' });
  }

  try {
    const upstream = await fetch(
      `https://bustime.mta.info/api/siri/stop-monitoring.json` +
      `?key=${BUS_API_KEY}&OperatorRef=MTA&MonitoringRef=${code}&MaximumStopVisits=8`
    );
    const data = await upstream.json();
    res.json(data);
  } catch (e) {
    console.error('bus fetch error:', e.message);
    res.status(502).json({ error: 'upstream error' });
  }
});

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
