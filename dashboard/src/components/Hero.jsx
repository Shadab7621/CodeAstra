import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Arrow, Mark, Moon, Sun } from './Icons';

const NODE = {
  mum: { x: 86, y: 222, label: 'Mumbai' },
  hyd: { x: 230, y: 62, label: 'Hyderabad' },
  sin: { x: 374, y: 222, label: 'Singapore' },
};

// One loop: normal operation, a cut, both sides still writing, then recovery.
const PHASES = [
  { caption: 'All regions connected and in sync', cut: false, writing: false },
  { caption: 'Network failure: Mumbai is cut off', cut: true, writing: false },
  { caption: 'Both sides keep accepting reports', cut: true, writing: true },
  { caption: 'Link restored: merged, nothing lost', cut: false, writing: false },
];

function NetworkVisual() {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), 2800);
    return () => clearInterval(id);
  }, []);
  const { cut, writing, caption } = PHASES[phase];

  const links = [
    ['mum', 'hyd', true],
    ['mum', 'sin', true],
    ['hyd', 'sin', false],
  ];

  return (
    <div className="network-card" aria-label="Animated illustration of a network failure and recovery">
      <svg viewBox="0 0 460 290" width="100%" role="img">
        {links.map(([a, b, touchesMumbai]) => {
          const broken = cut && touchesMumbai;
          return (
            <motion.line
              key={`${a}-${b}`}
              x1={NODE[a].x} y1={NODE[a].y} x2={NODE[b].x} y2={NODE[b].y}
              strokeWidth="2"
              strokeLinecap="round"
              animate={{
                stroke: broken ? 'var(--bad)' : 'var(--accent)',
                strokeDasharray: broken ? '6 7' : '0 0',
                opacity: broken ? 0.95 : 0.8,
              }}
              transition={{ duration: 0.5 }}
            />
          );
        })}

        {Object.entries(NODE).map(([id, n]) => {
          const isCut = cut && id === 'mum';
          const pulse = writing && (id === 'mum' || id === 'hyd');
          return (
            <g key={id}>
              {pulse && (
                <motion.circle
                  cx={n.x} cy={n.y} r="30" fill="none" strokeWidth="2" stroke="var(--accent)"
                  initial={{ r: 28, opacity: 0.7 }}
                  animate={{ r: 46, opacity: 0 }}
                  transition={{ duration: 1.2, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <motion.circle
                cx={n.x} cy={n.y} r="30" strokeWidth="2"
                fill="var(--surface)"
                animate={{ stroke: isCut ? 'var(--bad)' : 'var(--border-strong)' }}
                transition={{ duration: 0.4 }}
              />
              <text x={n.x} y={n.y + 4} textAnchor="middle" fontSize="12" fontWeight="650" fill="var(--text)">
                {id.toUpperCase()}
              </text>
              <text x={n.x} y={id === 'hyd' ? n.y - 42 : n.y + 54} textAnchor="middle" fontSize="12" fill="var(--muted)">
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="caption">
        <motion.span
          key={phase}
          className={`dot ${cut ? 'bad' : 'ok'}`}
          initial={{ scale: 0.6 }}
          animate={{ scale: 1 }}
        />
        <motion.span key={`c${phase}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          {caption}
        </motion.span>
      </div>
    </div>
  );
}

const rise = (delay = 0) => ({
  initial: { opacity: 0, y: 18 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, delay, ease: [0.22, 0.61, 0.36, 1] },
});

export default function Hero({ onEnter, theme, onToggleTheme, results }) {
  const ours = results?.systems?.ours;
  const base = results?.systems?.lww_baseline;

  return (
    <motion.section className="hero" exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }}>
      <nav className="hero-nav">
        <span className="brand" style={{ cursor: 'default' }}>
          <Mark className="brand-mark" />
          CodeAstra
        </span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle light and dark theme">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
        <button className="btn" onClick={onEnter}>Open dashboard</button>
      </nav>

      <div className="hero-main">
        <div>
          <motion.span className="eyebrow" {...rise(0)}>Geo-distributed replication</motion.span>
          <motion.h1 {...rise(0.08)}>Disaster reports that survive a network failure.</motion.h1>
          <motion.p className="lede" {...rise(0.16)}>
            When a region loses its connection, it keeps accepting reports. When the link returns,
            every region merges to the same state, and nothing is silently overwritten.
          </motion.p>
          <motion.div className="cta-row" {...rise(0.24)}>
            <button className="btn btn-primary btn-lg" onClick={onEnter}>
              Open dashboard <Arrow />
            </button>
            <a className="btn btn-lg" href="#how" onClick={(e) => { e.preventDefault(); document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }); }}>
              How it works
            </a>
          </motion.div>
          <motion.div className="hero-stats" {...rise(0.34)}>
            <div className="hero-stat">
              <b>{ours ? `${ours.silent_overwrites_pct}%` : '0%'}</b>
              <span>edits silently lost{base ? `, vs ${base.silent_overwrites_pct}% for last-writer-wins` : ''}</span>
            </div>
            <div className="hero-stat">
              <b>2 clouds</b>
              <span>AWS and Azure, three regions</span>
            </div>
            <div className="hero-stat">
              <b>Hash-chained</b>
              <span>history, tamper-evident</span>
            </div>
          </motion.div>
        </div>

        <motion.div {...rise(0.2)}>
          <NetworkVisual />
        </motion.div>
      </div>

      <div className="how" id="how">
        {[
          ['01', 'Always writable', 'Every region saves a report locally and replies at once. The network is never in the way of recording an incident.'],
          ['02', 'Nothing silently lost', 'Edits are kept as events. When two regions disagree, both versions are shown to an operator instead of one being discarded.'],
          ['03', 'Provable history', 'Each event is chained to the one before it, so changing or removing stored history is detectable on any region.'],
        ].map(([n, title, text], i) => (
          <motion.div
            className="how-item"
            key={n}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.5, delay: i * 0.08 }}
          >
            <span className="n">{n}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </motion.div>
        ))}
      </div>

      <div className="hero-foot">CodeAstra 2.0 · Cloud Computing and Distributed Systems</div>
    </motion.section>
  );
}
