import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Mail, Sparkles } from "lucide-react";
import { api, type EmailActivity, type ParsedEmail } from "../api";

export function EmailPanel({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [activity, setActivity] = useState<EmailActivity | null>(null);
  const [prompt, setPrompt] = useState("");
  const [parsed, setParsed] = useState<ParsedEmail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setActivity(await api.getSiteEmailActivity(siteId));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not load email activity");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError("");
      try {
        await action();
        await refresh();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : "Action failed");
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const instruction = prompt.trim();
    if (!instruction) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.siteRequestEmailFromText(siteId, instruction);
      setParsed(result.parsed);
      setPrompt("");
      await refresh();
    } catch (sendError) {
      setParsed(null);
      setError(sendError instanceof Error ? sendError.message : "Could not send that email");
    } finally {
      setBusy(false);
    }
  }

  const identity = activity?.email_identity ?? null;
  const messages = activity?.messages ?? [];
  const notifications = activity?.reply_notifications ?? [];
  const examplePrompts = useMemo(
    () => [
      "Email sarah@acme.com and ask if she can send the contract today",
      "Email john@example.com to confirm tomorrow's 2pm call",
      "Reply to maria@startup.io thanking her for the intro"
    ],
    []
  );

  return (
    <div className="payments-panel-view">
      <header className="site-detail-page__header">
        <div>
          <h1 id="siteDetailTitle">Email</h1>
          <p className="payments-screen__subtitle">
            {siteName} can email people in plain English — drafted and sent from its own address.
          </p>
        </div>
        <div className="payments-card">
          <Mail size={18} aria-hidden="true" />
          <div>
            <span className="payments-card__brand">{identity?.email_address ?? "no address"}</span>
            <span className="payments-card__meta">
              {identity ? `${identity.provider} · ${identity.status}` : loading ? "loading…" : "not provisioned"}
            </span>
          </div>
        </div>
      </header>

      {error ? <div className="payments-alert">{error}</div> : null}

      <div className="payments-panel">
        <h2 className="payments-panel__title">
          <Sparkles size={15} aria-hidden="true" /> Compose
        </h2>
        <form className="payments-shop" onSubmit={handleSend}>
          <input
            className="payments-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder='e.g. "email sarah@acme.com and ask for the contract"'
            disabled={busy || loading || identity?.status === "paused"}
          />
          <button className="payments-btn payments-btn--primary" type="submit" disabled={busy || loading || identity?.status === "paused"}>
            {busy ? <Loader2 size={15} className="payments-spin" aria-hidden="true" /> : "Send"}
          </button>
        </form>
        <div className="payments-examples">
          {examplePrompts.map((example) => (
            <button key={example} type="button" className="payments-chip" onClick={() => setPrompt(example)} disabled={busy}>
              {example}
            </button>
          ))}
        </div>
        {parsed ? (
          <p className="payments-parsed">
            Drafted by <strong>{parsed.parsed_by}</strong> · <strong>{parsed.subject}</strong>
            {parsed.to ? ` → ${parsed.to}` : ""}
          </p>
        ) : null}
        {identity ? (
          <p className="payments-parsed">
            {identity.status === "active" ? (
              <button type="button" className="payments-chip" disabled={busy} onClick={() => void runAction(() => api.sitePauseEmail(siteId))}>
                Pause sending
              </button>
            ) : (
              <button type="button" className="payments-chip" disabled={busy} onClick={() => void runAction(() => api.siteResumeEmail(siteId))}>
                Resume sending
              </button>
            )}
          </p>
        ) : null}
      </div>

      <div className="payments-panel">
        <h2 className="payments-panel__title">Replies</h2>
        {notifications.length === 0 ? (
          <p className="payments-empty">No replies yet. When someone responds, the summary lands here.</p>
        ) : (
          <table className="payments-table">
            <thead>
              <tr>
                <th>From</th>
                <th>Subject</th>
                <th>Summary</th>
                <th>Suggested reply</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((notification) => (
                <tr key={notification.id}>
                  <td>{notification.from_email}</td>
                  <td>{notification.subject}</td>
                  <td className="payments-muted">{notification.summary}</td>
                  <td className="payments-muted">{notification.suggested_reply}</td>
                  <td className="payments-muted">{new Date(notification.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="payments-panel">
        <h2 className="payments-panel__title">Activity</h2>
        {messages.length === 0 ? (
          <p className="payments-empty">No emails yet. Try the Compose box above, or ask in Chat.</p>
        ) : (
          <table className="payments-table">
            <thead>
              <tr>
                <th>Direction</th>
                <th>From → To</th>
                <th>Subject</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id}>
                  <td>
                    <span className={`payments-badge payments-badge--${message.direction === "inbound" ? "approved" : "executed"}`}>
                      {message.direction}
                    </span>
                  </td>
                  <td className="payments-muted">
                    {message.from_email} → {message.to_email}
                  </td>
                  <td>{message.subject}</td>
                  <td>
                    <span className={`payments-badge payments-badge--${message.status === "failed" ? "rejected" : "executed"}`}>
                      {message.status}
                    </span>
                  </td>
                  <td className="payments-muted">{new Date(message.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
