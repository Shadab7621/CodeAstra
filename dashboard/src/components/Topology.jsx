import { REGION } from '../config';
import { PROVIDER_COLOR } from '../infra';

const POS = { mum: { x: 170, y: 232 }, hyd: { x: 400, y: 104 }, sin: { x: 730, y: 168 } };
const PAIRS = [['mum', 'hyd'], ['mum', 'sin'], ['hyd', 'sin']];

// A gentle curve between two nodes, bowed away from the centre of the diagram.
function curve(a, b) {
  const p = POS[a];
  const q = POS[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const bow = a === 'mum' && b === 'sin' ? 70 : -26;
  return `M${p.x} ${p.y} Q${mx} ${my + bow} ${q.x} ${q.y}`;
}

function zones(meta) {
  const byProvider = {};
  for (const [id, m] of Object.entries(meta)) (byProvider[m.provider] ||= []).push(id);
  return Object.entries(byProvider).map(([provider, ids]) => {
    const xs = ids.map((i) => POS[i].x);
    const ys = ids.map((i) => POS[i].y);
    return {
      provider,
      x: Math.min(...xs) - 96, y: Math.min(...ys) - 74,
      w: Math.max(...xs) - Math.min(...xs) + 192, h: Math.max(...ys) - Math.min(...ys) + 166,
    };
  });
}

/**
 * The cluster as a picture: provider zones, regions, and the links between them.
 * nodes: { mum: { state: 'up' | 'paused' | 'down', rtt } }, links: { 'mum-hyd': 'ok' | 'cut' | 'unknown' }
 */
export default function Topology({ nodes, links, meta, onToggleLink, writing = [] }) {
  return (
    <svg className="topology" viewBox="0 0 900 340" role="img" aria-label="Cluster topology">
      <defs>
        <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>

      {zones(meta).map((z) => (
        <g key={z.provider}>
          <rect className="zone" x={z.x} y={z.y} width={z.w} height={z.h} rx="22" style={{ '--zone': PROVIDER_COLOR[z.provider] }} />
          <text className="zone-label" x={z.x + 18} y={z.y + 26} style={{ fill: PROVIDER_COLOR[z.provider] }}>
            {z.provider === 'Local' ? 'This computer' : z.provider}
          </text>
        </g>
      ))}

      {PAIRS.map(([a, b]) => {
        const state = links[`${a}-${b}`] || 'unknown';
        const d = curve(a, b);
        const clickable = Boolean(onToggleLink) && state !== 'unknown';
        return (
          <g key={`${a}-${b}`} className={`edge ${state}`}>
            {state === 'ok' && <path d={d} className="edge-glow" filter="url(#soft-glow)" />}
            <path d={d} className="edge-line" />
            {state === 'ok' && <path d={d} className="edge-flow" />}
            {clickable && (
              <path
                d={d} className="edge-hit" onClick={() => onToggleLink(a, b, state)}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleLink(a, b, state); }}
              >
                <title>{state === 'cut' ? 'Restore this link' : 'Cut this link'}</title>
              </path>
            )}
          </g>
        );
      })}

      {Object.entries(POS).map(([id, p]) => {
        const node = nodes[id] || {};
        const state = node.state || 'unknown';
        return (
          <g key={id} className={`tnode ${state}`} transform={`translate(${p.x} ${p.y})`}>
            {writing.includes(id) && <circle className="tnode-pulse" r="34" />}
            <circle className="tnode-halo" r="40" />
            <circle className="tnode-body" r="32" />
            <text className="tnode-code" y="5">{REGION[id].short}</text>
            <text className="tnode-name" y="58">{REGION[id].name}</text>
            <text className="tnode-sub" y="74">
              {meta[id].regionCode}{state === 'up' && node.rtt != null ? `  ·  ${node.rtt} ms` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
