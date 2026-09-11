import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { useSession } from "../state/session";
import { Icon } from "../components/Visual";
import "./meetings.css";

export function MeetingsPage() {
  const { currentWorkspace, me } = useSession();
  const slug = currentWorkspace?.workspace.slug;
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const [title, setTitle] = useState("");
  const [hours, setHours] = useState(168);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const query = useQuery({
    queryKey: ["meetings", me?.id, slug],
    queryFn: () => endpoints.meetings(slug!),
    enabled: !!slug,
  });
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["meetings", me?.id, slug] });
  return (
    <section className="bc-meetings">
      <header>
        <span className="bc-eyebrow">MAKE ROOM FOR EVERYONE</span>
        <h1>Meetings</h1>
        <p>Bring your workspace and guests together with one link.</p>
      </header>
      <form
        className="bc-meeting-create"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!slug || busy) return;
          setBusy(true);
          setError("");
          try {
            await endpoints.createMeeting(slug, title.trim(), hours);
            setTitle("");
            await refresh();
          } catch {
            setError("Could not create a meeting. Please try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Meeting name
          <input
            required
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Project catch-up"
          />
        </label>
        <label>
          Link expires after
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={1}>1 hour</option>
            <option value={24}>24 hours</option>
            <option value={168}>7 days</option>
          </select>
        </label>
        <button
          className="bc-primary"
          disabled={busy || !title.trim() || !slug}
        >
          <Icon name="video" size={18} /> Create meeting
        </button>
        <small>
          Up to 8 people · Anyone with the link can join · No chat access for
          guests
        </small>
      </form>
      {(error || query.isError) && (
        <p role="alert">
          {error ||
            "Meetings are unavailable. Check your connection and try again."}
        </p>
      )}
      <h2>Your meeting links</h2>
      {query.isPending ? (
        <p>Loading meetings…</p>
      ) : !query.data?.length ? (
        <div className="bc-meeting-empty">
          <Icon name="video" size={32} />
          <h3>A place to meet, inside and out.</h3>
          <p>Create your first link and share it with your guests.</p>
        </div>
      ) : (
        <div className="bc-meeting-list">
          {query.data.map((m) => {
            const closed = !!m.ended_at || Date.parse(m.expires_at) <= now;
            const path = "/meet/" + m.code;
            return (
              <article key={m.id}>
                <div className="bc-meeting-symbol">
                  <Icon name="video" />
                </div>
                <div>
                  <h3>{m.title}</h3>
                  <p>
                    {m.ended_at
                      ? "Ended"
                      : closed
                        ? "Expired"
                        : "Expires " + new Date(m.expires_at).toLocaleString()}
                  </p>
                </div>
                <div className="bc-meeting-actions">
                  {!closed && (
                    <>
                      <Link className="bc-primary" to={path}>
                        Open meeting
                      </Link>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              location.origin + path,
                            );
                            setCopied(m.id);
                          } catch {
                            setError(
                              "Copy the meeting link from the field below.",
                            );
                          }
                        }}
                      >
                        {copied === m.id ? "Copied!" : "Copy link"}
                      </button>
                      <button
                        onClick={async () => {
                          if (!slug) return;
                          try {
                            await endpoints.endMeeting(slug, m.id);
                            await refresh();
                          } catch {
                            setError(
                              "Could not end this meeting. Please try again.",
                            );
                          }
                        }}
                      >
                        End meeting
                      </button>
                    </>
                  )}
                </div>
                {!closed && (
                  <input
                    aria-label={"Meeting link for " + m.title}
                    readOnly
                    value={location.origin + path}
                    onFocus={(e) => e.target.select()}
                  />
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
