import { REGION } from '../config';
import { PROVIDER_COLOR } from '../infra';

const POS = { mum: { x: 170, y: 320 }, hyd: { x: 420, y: 100 }, sin: { x: 670, y: 260 } };
const PAIRS = [['mum', 'hyd'], ['mum', 'sin'], ['hyd', 'sin']];

// A gentle curve between two nodes, bowed away from the centre of the diagram.
function curve(a, b) {
  const p = POS[a];
  const q = POS[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const bow = (a === 'mum' && b === 'sin') || (a === 'sin' && b === 'mum') ? 80 : -36;
  return `M${p.x} ${p.y} Q${mx} ${my + bow} ${q.x} ${q.y}`;
}

function midPoint(a, b) {
  const p = POS[a];
  const q = POS[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const bow = (a === 'mum' && b === 'sin') || (a === 'sin' && b === 'mum') ? 80 : -36;
  return {
    x: mx,
    y: 0.25 * p.y + 0.5 * (my + bow) + 0.25 * q.y,
  };
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
 * The cluster as a picture: provider zones, regions, and the links between them.
 * nodes: { mum: { state: 'up' | 'paused' | 'down', rtt } }, links: { 'mum-hyd': 'ok' | 'cut' | 'unknown' }
 */
export default function Topology({ nodes, links, meta, onToggleLink, onSelectNode, writing = [] }) {
  return (
    <svg className="topology" viewBox="0 0 840 460" role="img" aria-label="Cluster topology">
      <defs>
        <filter id="soft-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>

      {zones(meta).map((z) => (
        <g key={z.provider}>
          <rect className="zone" x={z.x} y={z.y} width={z.w} height={z.h} rx="24" style={{ '--zone': PROVIDER_COLOR[z.provider] }} />
          <text className="zone-label" x={z.x + 20} y={z.y + 28} style={{ fill: PROVIDER_COLOR[z.provider] }}>
            {z.provider === 'Local' ? 'This computer' : z.provider}
          </text>
        </g>
      ))}

      {PAIRS.map(([a, b]) => {
        const state = links[`${a}-${b}`] || 'unknown';
        const d = curve(a, b);
        const mid = midPoint(a, b);
        const clickable = Boolean(onToggleLink) && state !== 'unknown';
        const isCut = state === 'cut';
        const isOk = state === 'ok';

        return (
          <g key={`${a}-${b}`} className={`edge ${state}`}>
            {isOk && <path d={d} className="edge-glow" filter="url(#soft-glow)" />}
            <path d={d} className="edge-line" />
            {isOk && <path d={d} className="edge-flow" />}
            {clickable && (
              <path
                d={d}
                className="edge-hit"
                onClick={() => onToggleLink(a, b, state)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleLink(a, b, state); }}
              >
                <title>{isCut ? `Restore link between ${REGION[a].name} and ${REGION[b].name}` : `Cut signal between ${REGION[a].name} and ${REGION[b].name}`}</title>
              </path>
            )}

            {state !== 'unknown' && (
              <g
                className={`edge-badge-group ${state} ${clickable ? 'clickable' : ''}`}
                transform={`translate(${mid.x}, ${mid.y})`}
                onClick={clickable ? () => onToggleLink(a, b, state) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onToggleLink(a, b, state); } : undefined}
              >
                <rect
                  x="-70"
                  y="-16"
                  width="140"
                  height="32"
                  rx="16"
                  className={`edge-badge-pill ${state}`}
                />
                <circle
                  cx="-52"
                  cy="0"
                  r="4.5"
                  className={`edge-badge-dot ${state}`}
                />
                <text
                  x="-40"
                  y="4.5"
                  className={`edge-badge-text ${state}`}
                >
                  {isCut ? 'CUT · Restore' : clickable ? 'Live · Cut signal' : 'Connected'}
                </text>
                <title>{isCut ? `Restore link between ${REGION[a].name} and ${REGION[b].name}` : `Cut signal between ${REGION[a].name} and ${REGION[b].name}`}</title>
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
            {writing.includes(id) && <circle className="tnode-pulse" r="38" />}
            <circle className="tnode-halo" r="46" />
            <circle className="tnode-body" r="36" />
            <text className="tnode-code" y="6">{REGION[id].short}</text>
            <text className="tnode-name" y="62">{REGION[id].name}</text>
            <text className="tnode-sub" y="80">
              {meta[id].regionCode}{state === 'up' && node.rtt != null ? `  ·  ${node.rtt} ms` : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
