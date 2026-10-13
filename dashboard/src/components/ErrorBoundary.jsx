import { Component } from 'react';

/**
 * Keeps one failing page (for example a file that did not load) from blanking the whole console.
 * The navigation stays usable and the person gets a way back.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    // Visible in the browser console for whoever is debugging.
    console.error('Page failed to render:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" role="alert" style={{ padding: '48px 24px' }}>
        <h2 style={{ marginTop: 0 }}>This page could not load</h2>
        <p className="muted">
          Something went wrong while opening it. The rest of the console still works.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={() => window.location.reload()}>Reload the page</button>
          {this.props.onBack && (
            <button type="button" className="btn btn-primary" onClick={() => { this.setState({ error: null }); this.props.onBack(); }}>
              {this.props.backLabel || 'Go back'}
            </button>
          )}
        </div>
      </div>
    );
  }
}
