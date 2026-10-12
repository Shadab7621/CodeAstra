import { motion } from 'framer-motion';
import { Gear, Mark, Moon, Sun } from './Icons';

function Segmented({ id, value, options, onChange }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />
          )}
          <span style={{ position: 'relative' }}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function TopBar({ view, onView, env, onEnv, theme, onToggleTheme, onSettings, onHome }) {
  const cloud = env === 'cloud';
  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} aria-label="Back to the overview">
        <Mark className="brand-mark" />
        CodeAstra
      </button>
      <Segmented
        id="view"
        value={view}
        onChange={onView}
        options={[
          { value: 'engine', label: 'Engine' },
          { value: 'baseline', label: 'Baseline', disabled: cloud, title: cloud ? 'The baseline runs locally only' : undefined },
          { value: 'compare', label: 'Compare', disabled: cloud, title: cloud ? 'Comparison runs on the local clusters' : undefined },
        ]}
      />
      <span className="spacer" />
      <Segmented
        id="env"
        value={env}
        onChange={onEnv}
        options={[
          { value: 'local', label: 'Local' },
          { value: 'cloud', label: 'Cloud' },
        ]}
      />
      <button className="icon-btn" onClick={onSettings} aria-label="Settings"><Gear /></button>
      <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle light and dark theme">
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>
    </header>
  );
}
