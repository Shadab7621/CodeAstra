import { REGION } from './config';

export const shortId = (id) => (id ? String(id).slice(0, 8) : '');
export const shortHash = (h) => (h ? String(h).slice(0, 8) : '');
export const regionName = (id) => (REGION[id] ? REGION[id].name : id);

export function relativeTime(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function formatFields(fields = {}) {
  return Object.entries(fields)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => {
      if (k === 'location') return `location ${Number(v.lat).toFixed(3)}, ${Number(v.lon).toFixed(3)}`;
      return `${k.replace('_', ' ')}: ${v}`;
    })
    .join('  ·  ');
}

export const STATUS_LABEL = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

export const TYPE_LABEL = {
  flood: 'Flood',
  fire: 'Fire',
  road_blocked: 'Road blocked',
  medical: 'Medical',
};

export function offsetLabel(ms) {
  if (!ms) return 'Normal';
  const minutes = Math.round(ms / 60000);
  return `${minutes > 0 ? '+' : ''}${minutes} min`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
