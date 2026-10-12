import { createPortal } from 'react-dom';
import { useThemeName } from '../hooks';
import SpotlightCard from '../reactbits/SpotlightCard';

// Our card: the ReactBits SpotlightCard, restyled to the app's own surface and border tokens.
const CARD_STYLE = {
  '--spotlight-card-surface': 'var(--surface)',
  '--spotlight-card-border': 'var(--card-border)',
  '--spotlight-card-shadow': 'var(--card-shadow)',
};

export function Card({ children, className = '', style, ...rest }) {
  const theme = useThemeName();
  return (
    <SpotlightCard
      theme={theme}
      className={`card ${className}`}
      spotlightColor={theme === 'dark' ? '#8ea0ff' : '#4f5bff'}
      intensity={theme === 'dark' ? 0.14 : 0.5}
      spotlightSize={300}
      borderGlow={0.7}
      style={{ ...CARD_STYLE, ...style }}
      {...rest}
    >
      {children}
    </SpotlightCard>
  );
}

export default function Panel({ title, hint, actions, children, flush = false, className = '' }) {
  return (
    <Card className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            <h2 className="panel-title">{title}</h2>
            {hint && <p className="panel-hint">{hint}</p>}
          </div>
          <span className="spacer" />
          {actions}
        </header>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </Card>
  );
}

/** Dialogs and drawers render at the page root so a card's clipping never cuts them off. */
export function Portal({ children }) {
  return createPortal(children, document.body);
}
