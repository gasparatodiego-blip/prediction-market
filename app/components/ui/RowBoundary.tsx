'use client';

// RowBoundary — rule 55: a single row that throws while rendering must NOT take down the
// whole tab. This React error boundary isolates one row: if its child throws, it renders a
// compact, calm "riga non disponibile" placeholder and the SIBLING rows still render.
//
// Display-only and honest: it never fabricates a value — it shows that one row is
// unavailable, nothing more. Errors are logged to the console for a human to inspect.

import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { failed: boolean }

export class RowBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // eslint-disable-next-line no-console
    console.error('[row-boundary] a row failed to render — showing placeholder, siblings unaffected:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div
          className="rounded-card font-body"
          style={{ border: '1px solid #e6eaef', background: '#fbfcfd', color: '#9aa5b3', fontSize: 12, padding: '12px 14px' }}
          role="status"
        >
          riga non disponibile
        </div>
      );
    }
    return this.props.children;
  }
}
