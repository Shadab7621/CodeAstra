import { useState, useRef, useCallback } from 'react';
import { REGION } from '../config';
import { PROVIDER_COLOR } from '../infra';
import { Card } from './Panel';

const POS_3D = {
  mum: { x: 95, y: 195 },
  hyd: { x: 260, y: 55 },
  sin: { x: 425, y: 155 },
};

const PAIRS = [
  ['mum', 'hyd'],
  ['mum', 'sin'],
  ['hyd', 'sin'],
];

function curvePath(a, b) {
  const p = POS_3D[a];
  const q = POS_3D[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const bow = (a === 'mum' && b === 'sin') ? 48 : -26;
  return `M ${p.x} ${p.y} Q ${mx} ${my + bow} ${q.x} ${q.y}`;
}

function midPoint3D(a, b) {
  const p = POS_3D[a];
  const q = POS_3D[b];
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const bow = (a === 'mum' && b === 'sin') ? 48 : -26;
  return {
    x: mx,
    y: 0.25 * p.y + 0.5 * (my + bow) + 0.25 * q.y,
  };
}

export default function Topology3D({ nodes = {}, links = {}, meta = {}, canAct = true, onToggleLink, onHealAll }) {
  // Front-facing 3D angle (12deg X-tilt, 0deg Y/Z) so the entire mesh faces directly forward at the user
  const [tilt, setTilt] = useState({ x: 12, y: 0, z: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [activeHoverEdge, setActiveHoverEdge] = useState(null);
  const [activeHoverNode, setActiveHoverNode] = useState(null);
  const containerRef = useRef(null);

  const anyCut = Object.values(links).some((s) => s === 'cut');

  const handleMouseMove = useCallback((e) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5; // -0.5 to 0.5
    const ny = (e.clientY - rect.top) / rect.height - 0.5; // -0.5 to 0.5

    // Smooth front-facing interactive 3D response
    setTilt({
      x: 12 - ny * 14,
      y: nx * 16,
      z: 0,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    setActiveHoverEdge(null);
    setTilt({ x: 12, y: 0, z: 0 });
  }, []);

  const resetTilt = () => {
    setTilt({ x: 12, y: 0, z: 0 });
  };

  return (
    <Card className="topology-3d-card">
      <div className="topology-3d-head">
        <div className="t3d-title-group">
          <div className="t3d-title">
            <span className="dot ok live" />
            <span>Interactive 3D Signal Mesh</span>
          </div>
          <span className="t3d-sub">
            Front-facing 3D network · Click any laser arc or floating badge to cut / restore signal
          </span>
        </div>
        <div className="t3d-actions">
          {anyCut && onHealAll && (
            <button
              className="btn btn-sm btn-primary"
              disabled={!canAct}
              onClick={onHealAll}
              title="Restore all broken network partitions"
            >
              Heal All Links
            </button>
          )}
          <button
            className="btn btn-sm btn-ghost"
            onClick={resetTilt}
            title="Reset 3D camera angle to straight front"
          >
            Reset 3D
          </button>
        </div>
      </div>

      {/* 3D Interactive Viewport */}
      <div
        className="topology-3d-viewport"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className="topology-3d-stage"
          style={{
            transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) rotateZ(${tilt.z}deg)`,
            transition: isHovered ? 'transform 0.08s ease-out' : 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {/* Ground Grid Layer */}
          <div className="t3d-floor">
            <div className="t3d-grid" />

            {/* AWS Cloud Zone boundary */}
            <div
              className="t3d-zone aws"
              style={{
                left: '40px',
                top: '30px',
                width: '280px',
                height: '210px',
              }}
            >
              <span className="t3d-zone-badge" style={{ color: PROVIDER_COLOR.AWS }}>
                AWS Cloud · ap-south
              </span>
            </div>

            {/* Azure Cloud Zone boundary */}
            <div
              className="t3d-zone azure"
              style={{
                left: '350px',
                top: '95px',
                width: '145px',
                height: '140px',
              }}
            >
              <span className="t3d-zone-badge" style={{ color: PROVIDER_COLOR.Azure }}>
                Azure Cloud · sea
              </span>
            </div>

            {/* Node Pedestals and Ground Shadows */}
            {Object.entries(POS_3D).map(([id, pos]) => {
              const node = nodes[id] || {};
              const up = node.state === 'up';
              return (
                <div
                  key={`floor-${id}`}
                  className="t3d-pedestal-group"
                  style={{ left: `${pos.x - 30}px`, top: `${pos.y - 30}px` }}
                >
                  <div className={`t3d-shadow ${up ? 'up' : 'down'}`} />
                  <div className={`t3d-ring ${up ? 'up' : 'down'}`} />
                  <div className="t3d-beam" />
                </div>
              );
            })}
          </div>

          {/* SVG 3D Signal Arcs Layer */}
          <svg className="t3d-svg-layer" viewBox="0 0 520 280">
            <defs>
              <filter id="t3d-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {PAIRS.map(([a, b]) => {
              const key = `${a}-${b}`;
              const state = links[key] || 'unknown';
              const isCut = state === 'cut';
              const isOk = state === 'ok';
              const isEdgeHovered = activeHoverEdge === key;
              const d = curvePath(a, b);

              return (
                <g
                  key={`arc-${key}`}
                  className={`t3d-edge ${state} ${isEdgeHovered ? 'hovered' : ''}`}
                  onMouseEnter={() => setActiveHoverEdge(key)}
                  onMouseLeave={() => setActiveHoverEdge(null)}
                >
                  {/* Outer glow */}
                  {isOk && <path d={d} className="t3d-edge-glow" filter="url(#t3d-glow)" />}
                  {/* Main beam line */}
                  <path d={d} className="t3d-edge-line" />
                  {/* Flowing animated light packets */}
                  {isOk && <path d={d} className="t3d-edge-flow" />}
                  {/* Clickable wide hit target */}
                  {canAct && onToggleLink && (
                    <path
                      d={d}
                      className="t3d-edge-hit"
                      onClick={() => onToggleLink(a, b, state)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') onToggleLink(a, b, state);
                      }}
                    >
                      <title>
                        {isCut
                          ? `Restore signal between ${REGION[a].name} and ${REGION[b].name}`
                          : `Cut signal between ${REGION[a].name} and ${REGION[b].name}`}
                      </title>
                    </path>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Floating 3D Midpoint Link Control Badges */}
          {PAIRS.map(([a, b]) => {
            const key = `${a}-${b}`;
            const state = links[key] || 'unknown';
            const isCut = state === 'cut';
            const isEdgeHovered = activeHoverEdge === key;
            const mid = midPoint3D(a, b);

            return (
              <div
                key={`badge-${key}`}
                className={`t3d-link-badge ${state} ${canAct && onToggleLink ? 'clickable' : ''} ${isEdgeHovered ? 'hovered' : ''}`}
                style={{
                  left: `${mid.x}px`,
                  top: `${mid.y}px`,
                }}
                onClick={canAct && onToggleLink ? () => onToggleLink(a, b, state) : undefined}
                onMouseEnter={() => setActiveHoverEdge(key)}
                onMouseLeave={() => setActiveHoverEdge(null)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (canAct && onToggleLink && (e.key === 'Enter' || e.key === ' ')) {
                    onToggleLink(a, b, state);
                  }
                }}
              >
                <span className={`t3d-badge-dot ${state}`} />
                <span className="t3d-badge-label">
                  {isCut ? 'CUT · Click to Heal' : 'Live · Click to Cut'}
                </span>
              </div>
            );
          })}

          {/* Floating 3D Elevated Server Nodes */}
          {Object.entries(POS_3D).map(([id, pos]) => {
            const node = nodes[id] || {};
            const up = node.state === 'up';
            const paused = node.state === 'paused';
            const stateClass = up ? 'up' : paused ? 'paused' : 'down';
            const rtt = up && node.rtt != null ? `${node.rtt}ms` : '';

            return (
              <div
                key={`tower-${id}`}
                className={`t3d-tower ${stateClass} ${activeHoverNode === id ? 'hovered' : ''}`}
                style={{
                  left: `${pos.x}px`,
                  top: `${pos.y}px`,
                }}
                onMouseEnter={() => setActiveHoverNode(id)}
                onMouseLeave={() => setActiveHoverNode(null)}
              >
                <div className="t3d-tower-cylinder">
                  <div className="t3d-tower-top">
                    <span className="t3d-tower-code">{REGION[id].short}</span>
                    <span className={`t3d-status-pip ${stateClass}`} />
                  </div>
                </div>

                <div className="t3d-tower-tag">
                  <span className="t3d-tower-name">{REGION[id].name}</span>
                  {rtt && <span className="t3d-tower-rtt">{rtt}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Direct Link Status Strip Below 3D Viewport */}
      <div className="t3d-foot-strip">
        <span className="t3d-foot-title">Signal Controls:</span>
        <div className="t3d-chips">
          {PAIRS.map(([a, b]) => {
            const key = `${a}-${b}`;
            const state = links[key] || 'unknown';
            const isCut = state === 'cut';
            return (
              <button
                key={`chip-${key}`}
                className={`link-chip ${isCut ? 'cut' : ''}`}
                disabled={!canAct || state === 'unknown'}
                onClick={() => onToggleLink && onToggleLink(a, b, state)}
              >
                <span className={`dot ${isCut ? 'bad' : state === 'ok' ? 'ok' : ''}`} />
                {REGION[a].name} ↔ {REGION[b].name}
                <span className="muted">{isCut ? 'Cut (click to heal)' : 'Connected (click to cut)'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
