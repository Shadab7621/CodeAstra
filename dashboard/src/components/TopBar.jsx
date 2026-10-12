import { motion } from 'motion/react';
import { Gear, Mark, Moon, Sun } from './Icons';

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
  const cloud = env === 'cloud';
  return (
    <header className="topbar">
      <button className="brand" onClick={onHome} aria-label="Back to the landing page">
        <Mark className="brand-mark" />
        CodeAstra
      </button>
      <span className="spacer" />
      <Segmented
        id="view" label="Section" value={view} onChange={onView}
        options={[
          { value: 'overview', label: 'Overview' },
          { value: 'infrastructure', label: 'Infrastructure' },
          { value: 'compare', label: 'Compare', disabled: cloud, title: cloud ? 'The comparison runs on the local clusters' : undefined },
        ]}
      />
      <span className="spacer" />
      <Segmented
        id="env" label="Environment" value={env} onChange={onEnv}
        options={[{ value: 'local', label: 'Local' }, { value: 'cloud', label: 'Cloud' }]}
      />
      <button className="icon-btn" onClick={onSettings} aria-label="Settings"><Gear /></button>
      <button className="icon-btn" onClick={onToggleTheme} aria-label="Toggle light and dark theme">
        {theme === 'dark' ? <Sun /> : <Moon />}
      </button>
    </header>
  );
}
