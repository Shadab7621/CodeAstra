import { useState } from 'react';
import { api } from '../api';
import { REGION } from '../config';
import { useToast } from './Toast';

/** The fault-injection actions, shared by the Overview and Infrastructure pages. */
export function useClusterActions(urls, token) {
  const toast = useToast();

  const run = async (label, fn) => {
    try {
      await fn();
      if (label) toast(label);
    } catch (err) {
      toast(`Failed: ${err.status === 401 ? 'the admin token is missing or wrong. Add it in Settings.' : err.message}`, 'bad');
    }
  };

  return {
    toggleLink: (a, b, state) => run(
      state === 'cut' ? `Restored the link between ${REGION[a].name} and ${REGION[b].name}`
        : `Cut the link between ${REGION[a].name} and ${REGION[b].name}`,
      async () => {
        const call = state === 'cut' ? api.unblock : api.block;
        await Promise.all([call(urls[a], b, token), call(urls[b], a, token)]);
      },
    ),
    pause: (n) => run(`${REGION[n].name} is paused. It now rejects requests, like a crashed server.`, () => api.pause(urls[n], token)),
    resume: (n) => run(`${REGION[n].name} resumed`, () => api.resume(urls[n], token)),
    skew: (n, ms) => run(ms ? `${REGION[n].name}'s clock is now an hour fast` : `${REGION[n].name}'s clock is back to normal`, () => api.clock(urls[n], ms, token)),
  };
}

export function ReadOnlyNotice({ canAct }) {
  if (canAct) return null;
  return (
    <div className="banner warn">
      <span className="dot warn" />
      Controls are read-only until you add the admin token in Settings.
    </div>
  );
}

export function useSelectedRegion() {
  return useState('mum');
}
