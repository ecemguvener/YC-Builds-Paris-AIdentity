import { Phone } from "lucide-react";

export function PhonePanel({ siteName }: { siteName: string }) {
  return (
    <div className="payments-panel-view">
      <header className="site-detail-page__header">
        <div>
          <h1 id="siteDetailTitle">Phone</h1>
          <p className="payments-screen__subtitle">
            {siteName} can place outbound calls through its agent identity phone number.
          </p>
        </div>
        <div className="payments-card">
          <Phone size={18} aria-hidden="true" />
          <div>
            <span className="payments-card__brand">+1 (415) 555-0198</span>
            <span className="payments-card__meta">outbound calls enabled</span>
          </div>
        </div>
      </header>

      <div className="payments-panel">
        <h2 className="payments-panel__title">Call policy</h2>
        <dl className="payments-policy">
          <div>
            <dt>Provider</dt>
            <dd>Voice provider</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>Agent initiated</dd>
          </div>
          <div>
            <dt>Approvals</dt>
            <dd>High-impact calls</dd>
          </div>
          <div>
            <dt>Fallback</dt>
            <dd>Mock queue</dd>
          </div>
        </dl>
      </div>

      <div className="payments-panel">
        <h2 className="payments-panel__title">Call activity</h2>
        <p className="payments-empty">No calls yet. Ask in Chat to call a person, business, or service.</p>
      </div>
    </div>
  );
}
