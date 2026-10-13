import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Panel from './Panel';

function valueOf(record, names, fallback = '—') {
  for (const name of names) {
    const key = Object.keys(record || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && record[key] !== null && record[key] !== undefined && record[key] !== '') return record[key];
  }
  return fallback;
}

function placeOf(record) {
  const raw = valueOf(record, ['location', 'address', 'city', 'district'], 'Unknown location');
  const point = raw && typeof raw === 'object' ? raw : {};
  const address = typeof raw === 'string' ? raw : (raw.address || raw.locality || raw.city || raw.district || 'Unknown location');
  const coords = [Number(point.lat ?? point.latitude ?? record.lat ?? record.latitude ?? point.coordinates?.[1]), Number(point.lon ?? point.lng ?? point.longitude ?? record.lon ?? record.lng ?? record.longitude ?? point.coordinates?.[0])];
  const cityCoords = {
    mumbai: [19.076, 72.8777], hyderabad: [17.385, 78.4867], pune: [18.5204, 73.8567], bengaluru: [12.9716, 77.5946], bangalore: [12.9716, 77.5946], chennai: [13.0827, 80.2707], delhi: [28.6139, 77.209], kolkata: [22.5726, 88.3639], ahmedabad: [23.0225, 72.5714], jaipur: [26.9124, 75.7873], lucknow: [26.8467, 80.9462],
  };
  const city = Object.keys(cityCoords).find((name) => String(address).toLowerCase().includes(name));
  const validCoords = coords.every(Number.isFinite) && Math.abs(coords[0]) <= 90 && Math.abs(coords[1]) <= 180;
  return { address: String(address), coords: validCoords ? coords : city ? cityCoords[city] : null };
}

function displayTime(value) {
  if (!value || value === '—') return value;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function IncidentMap({ incidents }) {
  const mapElement = useRef(null);
  useEffect(() => {
    if (!mapElement.current) return undefined;
    const map = L.map(mapElement.current, { scrollWheelZoom: false }).setView([22.5, 79], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const mapped = incidents.filter((item) => item.coords);
    mapped.forEach((item) => {
      const marker = L.circleMarker(item.coords, { radius: 8, color: '#fff', weight: 2, fillColor: item.severity.toLowerCase() === 'critical' ? '#e5484d' : '#4f5bff', fillOpacity: 0.95 }).addTo(map);
      const popup = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = `${item.id} · ${item.title}`;
      const details = document.createElement('div'); details.textContent = `${item.address} | ${item.severity} | ${item.created}`;
      popup.append(title, details); marker.bindPopup(popup);
    });
    if (mapped.length > 1) map.fitBounds(L.latLngBounds(mapped.map((item) => item.coords)), { padding: [28, 28], maxZoom: 8 });
    else if (mapped.length === 1) map.setView(mapped[0].coords, 10);
    const timer = window.setTimeout(() => map.invalidateSize(), 100);
    return () => { window.clearTimeout(timer); map.remove(); };
  }, [incidents]);
  return <div className="convergence-analytics-map" ref={mapElement} aria-label="Map of incident addresses" />;
}

export default function LocationAnalytics({ records, isDemo, onClose }) {
  const incidents = useMemo(() => records.map((record, index) => {
    const place = placeOf(record || {});
    return {
      id: valueOf(record, ['incident_id', 'incidentId', 'report_id', 'id'], `Incident ${index + 1}`),
      title: valueOf(record, ['title', 'description', 'incident_type', 'type', 'name'], 'Incident report'),
      severity: String(valueOf(record, ['severity', 'priority', 'risk_level'], 'Unspecified')),
      created: displayTime(valueOf(record, ['created_at', 'createdAt', 'reported_at', 'timestamp', 'date', 'created'])),
      ...place,
    };
  }), [records]);
  const ranked = useMemo(() => {
    const counts = new Map();
    incidents.forEach((item) => counts.set(item.address, (counts.get(item.address) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [incidents]);
  const mapped = incidents.filter((item) => item.coords).length;
  const top = ranked[0];
  return (
    <div className="stack convergence-page">
      <div className="convergence-analytics-summary">
        <div className="analytics-metric-total"><span className="analytics-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 3h6l5 5v13H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path d="M14 3v5h5m-9 4h5m-5 4h6"/></svg></span><span className="analytics-metric-copy"><span>Incidents analyzed</span><strong>{incidents.length}</strong></span></div>
        <div className="analytics-metric-mapped"><span className="analytics-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15m6-12v15"/></svg></span><span className="analytics-metric-copy"><span>Mapped incidents</span><strong>{mapped} / {incidents.length}</strong></span></div>
        <div className="analytics-metric-location"><span className="analytics-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></span><span className="analytics-metric-copy"><span>Most reported location</span><strong>{top?.[0] || 'Unavailable'} ({top?.[1] || 0})</strong></span></div>
        <div className="analytics-metric-critical"><span className="analytics-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5m0 3h.01"/></svg></span><span className="analytics-metric-copy"><span>Critical severity</span><strong>{incidents.filter((item) => item.severity.toLowerCase() === 'critical').length}</strong></span></div>
      </div>
      <Panel title="Incident Address Map" hint="Select a marker to view incident details." className="convergence-analytics-panel">
        {mapped ? <IncidentMap incidents={incidents} /> : <div className="convergence-analytics-map-empty">No incident coordinates or recognized city locations are available to plot.</div>}
        <p className="convergence-analytics-note">Exact report coordinates are used when provided. City-only locations are shown at the approximate city center.</p>
      </Panel>
      <Panel title="Incident Details" className="convergence-incidents-panel">
        <div className="table-wrap"><table className="convergence-incidents-table analytics-incidents-table"><thead><tr><th>Incident ID</th><th>Title</th><th>Address / Location</th><th>Severity</th><th>Reported At</th><th>Map</th></tr></thead>
          <tbody>{incidents.map((item, index) => <tr key={`${item.id}-${index}`}><td className="incident-id">{item.id}</td><td className="incident-title">{item.title}</td><td>{item.address}</td><td>{item.severity}</td><td className="incident-time">{item.created}</td><td>{item.coords ? `${item.coords[0].toFixed(4)}, ${item.coords[1].toFixed(4)}` : 'Not mapped'}</td></tr>)}</tbody>
        </table></div>
      </Panel>
      <Panel title="Reports by Location" className="convergence-incidents-panel"><div className="convergence-location-rankings">{ranked.map(([address, count]) => <div key={address}><span>{address}</span><strong>{count} {count === 1 ? 'report' : 'reports'}</strong></div>)}</div></Panel>
    </div>
  );
}
