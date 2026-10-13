import { motion } from 'motion/react';
import { Gear, Moon, Sun } from './Icons';

export function Segmented({ id, value, options, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: 'spring', stiffness: 460, damping: 38 }} />
          )}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function TopBar({ view, onView, env, onEnv, theme, onToggleTheme, onSettings, onHome }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="brand" onClick={onHome} aria-label="Back to the landing page">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="DisasterSync" className="brand-mark" />
          <span className="brand-name">DisasterSync</span>
        </button>
      </div>

      <div className="topbar-center">
        <Segmented
          id="view" label="Section" value={view} onChange={onView}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'infrastructure', label: 'Infrastructure' },
            { value: 'logs', label: 'Logs' },
            { value: 'convergence', label: 'Convergence' },
          ]}
        />
      </div>

      <div className="topbar-right">
        {view !== 'logs' && view !== 'convergence' && view !== 'analytics' && (
          <Segmented
            id="env" label="Environment" value={env} onChange={onEnv}
            options={[{ value: 'local', label: 'Local' }, { value: 'cloud', label: 'Cloud' }]}
          />
        )}
        <button className="icon-btn" onClick={onSettings} aria-label="Settings"><Gear /></button>
        <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle light and dark theme">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
      </div>
    </header>
  );
}
