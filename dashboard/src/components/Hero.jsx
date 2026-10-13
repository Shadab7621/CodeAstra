import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useThemeName } from '../hooks';
import { INFRA, STACK } from '../infra';
import Aurora from '../reactbits/Aurora';
import BlurText from '../reactbits/BlurText';
import CountUp from '../reactbits/CountUp';
import GradientText from '../reactbits/GradientText';
import ShinyText from '../reactbits/ShinyText';
import StarBorder from '../reactbits/StarBorder';
import { Arrow, Moon, Sun } from './Icons';
import { Card } from './Panel';
import Topology from './Topology';

const ALL_OK = { 'mum-hyd': 'ok', 'hyd-sin': 'ok', 'mum-sin': 'ok' };
const MUMBAI_CUT = { 'mum-hyd': 'cut', 'hyd-sin': 'ok', 'mum-sin': 'cut' };
const UP = { mum: { state: 'up' }, hyd: { state: 'up' }, sin: { state: 'up' } };

// One loop of the story the product exists for.
const PHASES = [
  { links: ALL_OK, writing: [], tone: 'ok', caption: 'Three regions on two clouds, connected and in sync' },
  { links: MUMBAI_CUT, writing: [], tone: 'bad', caption: 'Link failure: Mumbai can no longer reach the other regions' },
  { links: MUMBAI_CUT, writing: ['mum', 'hyd'], tone: 'bad', caption: 'Both sides keep accepting writes while disconnected' },
  { links: ALL_OK, writing: [], tone: 'ok', caption: 'Link restored: every region merges, nothing is silently lost' },
];

function LivePreview() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((p) => (p + 1) % PHASES.length), 3000);
    return () => clearInterval(id);
  }, []);
  const phase = PHASES[i];
  return (
    <Card className="preview-card">
      <div className="preview-bar">
        <span className="lights"><i /><i /><i /></span>
        <span className={`dot ${phase.tone} live`} />
        <motion.span key={i} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
          {phase.caption}
        </motion.span>
      </div>
      <Topology nodes={UP} links={phase.links} meta={INFRA.cloud} writing={phase.writing} />
    </Card>
  );
}

const rise = (delay = 0) => ({
  initial: { opacity: 0, y: 22 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, delay, ease: [0.22, 0.61, 0.36, 1] },
});

const inView = (delay = 0) => ({
  initial: { opacity: 0, y: 26 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.6, delay, ease: [0.22, 0.61, 0.36, 1] },
});

const FEATURES = [
  ['01', 'Always writable', 'Each region saves a write locally and answers at once. A broken link between regions never blocks anyone from recording data.'],
  ['02', 'Nothing silently lost', 'Every change is kept as an event. When two regions edited the same thing while apart, both versions are kept for a person to decide.'],
  ['03', 'History you can verify', 'Each event carries the hash of the one before it. Editing or deleting stored history is detectable, and forged events are refused.'],
];

export default function Hero({ onEnter, onToggleTheme, results }) {
  const theme = useThemeName();
  const dark = theme === 'dark';
  const baselineLoss = results?.systems?.lww_baseline?.silent_overwrites_pct ?? 42.2;
  const trials = results?.runs ?? 100;

  return (
    <motion.div className="hero" exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
      <div className="hero-bg">
        <Aurora
          colorStops={dark ? ['#4f5bff', '#3fe0a2', '#5fd0ff'] : ['#8b9bff', '#7fe9c9', '#9fd8ff']}
          amplitude={1.05} blend={0.62} speed={0.7} lightMode={!dark} opacity={dark ? 0.72 : 0.7}
        />
      </div>

      <nav className="hero-nav">
        <div className="hero-nav-left">
          <span className="brand">
            <img src="/logo.png" alt="DisasterSync" className="brand-mark" />
            <span className="brand-name">DisasterSync</span>
          </span>
        </div>

        <div className="hero-nav-center">
          <div className="hero-links">
            <button type="button" onClick={() => onEnter('overview')}>Console</button>
            <button type="button" onClick={() => onEnter('infrastructure')}>Infrastructure</button>
          </div>
        </div>

        <div className="hero-nav-right">
          <button type="button" className="icon-btn" onClick={onToggleTheme} aria-label="Toggle light and dark theme">
            {dark ? <Sun /> : <Moon />}
          </button>
          <button type="button" className="btn btn-glass" onClick={() => onEnter('overview')}>Open console</button>
        </div>
      </nav>

      <header className="hero-center">
        <motion.span className="live-chip" {...rise(0)}>
          <span className="dot ok live" />
          <ShinyText
            text="Running on AWS and Azure across three regions"
            color={dark ? '#a9b3c6' : '#586275'} shineColor={dark ? '#ffffff' : '#0f131c'} speed={3}
          />
        </motion.span>

        <div className="hero-title" role="heading" aria-level="1">
          <BlurText text="Stay writable when the" className="blur-line" delay={70} animateBy="words" direction="top" />
          <GradientText
            className="title-gradient"
            colors={dark ? ['#8b9bff', '#5fd0ff', '#45e6b4', '#8b9bff'] : ['#4f5bff', '#2f8bff', '#0fae84', '#4f5bff']}
            animationSpeed={7}
          >
            link between regions breaks.
          </GradientText>
        </div>

        <motion.p className="lede" {...rise(0.35)}>
          A replicated data service that keeps running through a network partition. Regions accept writes
          while cut off, then merge to one state, with every conflict visible and a history you can verify.
        </motion.p>

        <motion.div className="cta-row" {...rise(0.45)}>
          <StarBorder
            as="button" theme={theme} className="star-cta" radius={12} duration={3.5} glow={0.8}
            color={dark ? '#8b9bff' : '#4f5bff'} onClick={() => onEnter('overview')}
          >
            Open the console <Arrow />
          </StarBorder>
          <button className="btn btn-glass btn-lg" onClick={() => onEnter('infrastructure')}>
            See the live infrastructure
          </button>
        </motion.div>
      </header>

      <motion.div className="hero-preview" {...rise(0.55)}>
        <LivePreview />
      </motion.div>

      <section className="section">
        <motion.div {...inView()}>
          <span className="section-kicker">Measured, not claimed</span>
          <h2>What a link failure costs, on each system.</h2>
        </motion.div>
        <div className="hero-stats" style={{ marginTop: 28 }}>
          {[
            { big: <><CountUp to={baselineLoss} duration={1.6} />%</>, bad: true, text: `of acknowledged edits silently lost by a last-writer-wins store, across ${trials} fault trials` },
            { big: '0%', text: 'silently lost by this engine in the same trials, with identical operations' },
            { big: <CountUp to={72} duration={1.4} />, text: 'automated tests, including random partitions, crashes and clock skew' },
            { big: <>&lt;1 s</>, text: 'to converge after a link is restored, measured across AWS and Azure' },
          ].map((s, k) => (
            <motion.div key={k} {...inView(k * 0.07)}>
              <Card className="hero-stat">
                <div className={`big ${s.bad ? 'bad' : 'grad-text'}`}>{s.big}</div>
                <p>{s.text}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="section">
        <motion.div {...inView()}>
          <span className="section-kicker">How it works</span>
          <h2>Built for the moment the network lets you down.</h2>
        </motion.div>
        <div className="grid-3" style={{ marginTop: 28 }}>
          {FEATURES.map(([n, title, text], k) => (
            <motion.div key={n} {...inView(k * 0.08)} style={{ height: '100%' }}>
              <Card className="feature">
                <span className="n">{n}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="section" style={{ textAlign: 'center' }}>
        <motion.span className="section-kicker" {...inView()}>What it runs on</motion.span>
        <motion.div className="stack-strip" style={{ marginTop: 20 }} {...inView(0.08)}>
          {STACK.map((s) => <span className="stack-chip" key={s}>{s}</span>)}
        </motion.div>
      </section>

      <footer className="hero-foot">DisasterSync · Built for CodeAstra 2.0 · Cloud Computing and Distributed Systems</footer>
    </motion.div>
  );
}
