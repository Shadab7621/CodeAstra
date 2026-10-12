import { useState } from 'react';
import { motion } from 'framer-motion';
import { DEFAULT_CLOUD, NODES, REGION } from '../config';
import { Close } from './Icons';

export default function Settings({ cloudUrls, token, onSave, onClose }) {
  const [urls, setUrls] = useState(cloudUrls);
  const [secret, setSecret] = useState(token);

  const submit = (e) => {
    e.preventDefault();
    const clean = Object.fromEntries(NODES.map((n) => [n, urls[n].trim().replace(/\/$/, '')]));
    onSave(clean, secret.trim());
  };

  return (
    <>
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.form
        className="modal"
        onSubmit={submit}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.2 }}
      >
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 17 }}>Settings</h2>
          <button type="button" className="icon-btn" style={{ flex: 'none' }} onClick={onClose} aria-label="Close"><Close /></button>
        </div>

        <div className="field">
          <label htmlFor="token">Admin token</label>
          <input
            id="token" type="password" autoComplete="off" value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Needed for cloud controls. Kept for this browser session only."
          />
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <div className="panel-title">Cloud addresses</div>
          {NODES.map((n) => (
            <div className="field" key={n}>
              <label htmlFor={`url-${n}`}>{REGION[n].name}</label>
              <input id={`url-${n}`} className="mono" value={urls[n]} onChange={(e) => setUrls({ ...urls, [n]: e.target.value })} />
            </div>
          ))}
          <p className="muted" style={{ fontSize: 13 }}>
            These change whenever the cluster is redeployed. Local addresses are fixed.
          </p>
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn btn-ghost" style={{ flex: 'none' }} onClick={() => setUrls(DEFAULT_CLOUD)}>
            Restore defaults
          </button>
          <div className="row" style={{ flex: 'none' }}>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary">Save</button>
          </div>
        </div>
      </motion.form>
    </>
  );
}
