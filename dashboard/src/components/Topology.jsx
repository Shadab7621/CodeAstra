import { REGION } from '../config';
import { PROVIDER_COLOR } from '../infra';

const POS = { mum: { x: 170, y: 320 }, hyd: { x: 420, y: 100 }, sin: { x: 670, y: 260 } };
const PAIRS = [['mum', 'hyd'], ['mum', 'sin'], ['hyd', 'sin']];

// How far each link bows away from the straight line, so the three links never overlap a label.
const bowOf = (a, b) => (a === 'mum' && b === 'sin' ? 80 : -36);

function curve(a, b) {
  const p = POS[a];
  const q = POS[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  return `M${p.x} ${p.y} Q${mx} ${my + bowOf(a, b)} ${q.x} ${q.y}`;
}

// Where along each link its status chip sits (0 = first region, 1 = second), chosen so a chip
// never lands on a region's name.
const CHIP_AT = { 'mum-hyd': 0.4, 'hyd-sin': 0.62, 'mum-sin': 0.5 };

/** The point on a link's curve where its status chip sits. */
function chipPoint(a, b) {
  const p = POS[a];
  const q = POS[b];
  const t = CHIP_AT[`${a}-${b}`] ?? 0.5;
  const cx = (p.x + q.x) / 2;
  const cy = (p.y + q.y) / 2 + bowOf(a, b);
  const u = 1 - t;
  return { x: u * u * p.x + 2 * u * t * cx + t * t * q.x, y: u * u * p.y + 2 * u * t * cy + t * t * q.y };
}

function zones(meta) {
  const byProvider = {};
  for (const [id, m] of Object.entries(meta)) (byProvider[m.provider] ||= []).push(id);
  return Object.entries(byProvider).map(([provider, ids]) => {
    const xs = ids.map((i) => POS[i].x);
    const ys = ids.map((i) => POS[i].y);
    return {
      provider,
      x: Math.min(...xs) - 105, y: Math.min(...ys) - 75,
      w: Math.max(...xs) - Math.min(...xs) + 210, h: Math.max(...ys) - Math.min(...ys) + 185,
    };
  });
}

/**
 * The cluster as a picture: provider zones, regions, and the state of each link.
 * It only shows state. Links are cut and restored from the switch list beside it, so there is
 * exactly one place to do that.
 * nodes: { mum: { state: 'up' | 'paused' | 'down', rtt } }, links: { 'mum-hyd': 'ok' | 'cut' | 'unknown' }
 */
export default function Topology({ nodes, links, meta, onSelectNode, writing = [] }) {
  return (
    <svg className="topology" viewBox="40 6 760 440" role="img" aria-label="Cluster topology">
      <defs>
        <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>

      {zones(meta).map((z) => (
        <g key={z.provider}>
          <rect className="zone" x={z.x} y={z.y} width={z.w} height={z.h} rx="24" style={{ '--zone': PROVIDER_COLOR[z.provider] }} />
          <text className="zone-label" x={z.x + z.w - 20} y={z.y + 28} textAnchor="end" style={{ fill: PROVIDER_COLOR[z.provider] }}>
            {z.provider === 'Local' ? 'This computer' : z.provider}
          </text>
        </g>
      ))}

      {PAIRS.map(([a, b]) => {
        const state = links[`${a}-${b}`] || 'unknown';
        const d = curve(a, b);
        const mid = chipPoint(a, b);
        const isCut = state === 'cut';
        const isOk = state === 'ok';
        return (
          <g key={`${a}-${b}`} className={`edge ${state}`}>
            {isOk && <path d={d} className="edge-glow" filter="url(#soft-glow)" />}
            <path d={d} className="edge-line" />
            {isOk && <path d={d} className="edge-flow" />}
            {state !== 'unknown' && (
              <g className={`edge-chip ${state}`} transform={`translate(${mid.x} ${mid.y})`}>
                <rect className="chip-bg" x="-42" y="-14" width="84" height="28" rx="14" />
                <rect x="-42" y="-14" width="84" height="28" rx="14" />
                <text y="5" textAnchor="middle">{isCut ? 'Cut' : 'Connected'}</text>
                <title>{`${REGION[a].name} to ${REGION[b].name}: ${isCut ? 'cut' : 'connected'}`}</title>
              </g>
            )}
          </g>
        );
      })}

      {Object.entries(POS).map(([id, p]) => {
        const node = nodes[id] || {};
        const state = node.state || 'unknown';
        return (
          <g
            key={id} className={`tnode ${state}${onSelectNode ? ' clickable' : ''}`}
            transform={`translate(${p.x} ${p.y})`}
            {...(onSelectNode ? {
              role: 'button', tabIndex: 0,
              onClick: () => onSelectNode(id),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') onSelectNode(id); },
            } : {})}
          >
            {onSelectNode && <title>{`Open the ${REGION[id].name} log`}</title>}
            {writing.includes(id) && <circle className="tnode-pulse" r="42" />}
            <circle className="tnode-halo" r="50" />
            <circle className="tnode-body" r="40" />
            <text className="tnode-code" y="6">{REGION[id].short}</text>
            <text className="tnode-name" y="70">{REGION[id].name}</text>
            <text className="tnode-sub" y="90">
              {meta[id].regionCode}{state === 'up' && node.rtt != null ? `  ·  ${node.rtt} ms` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
