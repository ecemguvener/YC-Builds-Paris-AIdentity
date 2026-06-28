import { Fragment, useCallback, useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { api, type EmailActivity } from "../api";

export function EmailPanel({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [activity, setActivity] = useState<EmailActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);

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

  const identity = activity?.email_identity ?? null;
  const messages = activity?.messages ?? [];
  const notifications = activity?.reply_notifications ?? [];

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

      {identity ? (
        <div className="payments-panel">
          <h2 className="payments-panel__title">Sending controls</h2>
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
        </div>
      ) : null}

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
          <p className="payments-empty">No emails yet.</p>
        ) : (
          <>
            <p className="payments-muted" style={{ marginTop: 0 }}>
              Click a row to read the full email.
            </p>
            <table className="payments-table">
              <thead>
                <tr>
                  <th aria-label="Expand" />
                  <th>Direction</th>
                  <th>From → To</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((message) => {
                  const open = openMessageId === message.id;
                  return (
                    <Fragment key={message.id}>
                      <tr
                        onClick={() => setOpenMessageId(open ? null : message.id)}
                        style={{ cursor: "pointer" }}
                        aria-expanded={open}
                      >
                        <td className="payments-muted" aria-hidden="true">
                          {open ? "▾" : "▸"}
                        </td>
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
                      {open ? (
                        <tr>
                          <td colSpan={6}>
                            <div className="email-message-detail">
                              <div className="email-message-detail__meta">
                                <span><strong>From:</strong> {message.from_email}</span>
                                <span><strong>To:</strong> {message.to_email}</span>
                                <span><strong>Subject:</strong> {message.subject}</span>
                                {message.provider_message_id ? (
                                  <span><strong>Provider id:</strong> {message.provider_message_id}</span>
                                ) : null}
                              </div>
                              <pre className="email-message-detail__body">{message.body}</pre>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
