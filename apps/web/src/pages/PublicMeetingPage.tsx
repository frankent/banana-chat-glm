import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@banana-chat/api-client";
import { CallAttempt, meetingGuestName } from "@banana-chat/chat-core";
import type { MeetingJoin } from "@banana-chat/shared";
import { endpoints } from "../lib/api";
import { useSession } from "../state/session";
import { registerSessionCleanup } from "../lib/session-resources";
import { Banana, Icon } from "../components/Visual";
import "../components/calls/calls.css";
import "./meetings.css";
const MediaPanel = lazy(() => import("../components/calls/MediaPanel"));
function read(key: string) {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function save(key: string, value: string) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* In-memory participation still works. */
  }
}
function message(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 410 || e.status === 404)
      return "This meeting link has expired or was ended by its creator.";
    if (e.status === 409)
      return "This meeting is full, or you have already joined on another device. Please try again shortly.";
    if (e.status === 401 || e.status === 403)
      return "Your session is no longer valid. Sign in again to join.";
    if (e.status === 429)
      return "Too many attempts. Please wait a moment before trying again.";
  }
  return "Unable to join. Check your connection and try again.";
}
export function PublicMeetingPage() {
  const { code = "" } = useParams();
  return <MeetingLobby key={code} code={code} />;
}
function MeetingLobby({ code }: { code: string }) {
  const { status, me } = useSession();
  const key = "orgchat.meeting." + code;
  const [name, setName] = useState(() => read(key + ".name"));
  const [active, setActive] = useState<MeetingJoin | null>(null);
  const activeRef = useRef<MeetingJoin | null>(null);
  const closeMedia = useRef<(() => void) | null>(null);
  const [attempts] = useState(() => new CallAttempt());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const valid = /^[a-f0-9]{64}$/.test(code);
  const lobby = useQuery({
    queryKey: ["meeting-lobby", code, status, me?.id],
    queryFn: () => endpoints.meetingLobby(code),
    enabled: valid && status !== "loading",
    retry: false,
    refetchInterval: active ? false : 10000,
  });
  useEffect(() => {
    const release = () => {
      attempts.cancel();
      closeMedia.current?.();
      const current = activeRef.current;
      activeRef.current = null;
      if (current) {
        save(key, "");
        void endpoints
          .leaveMeeting(code, current.participant_token)
          .catch(() => {});
      }
    };
    const unregister = registerSessionCleanup(() => {
      release();
      setActive(null);
      setBusy(false);
    });
    const unload = () => {
      const current = activeRef.current;
      if (current)
        navigator.sendBeacon(
          "/api/v1/public-meetings/" + code + "/leave",
          new Blob(
            [JSON.stringify({ participant_token: current.participant_token })],
            { type: "application/json" },
          ),
        );
    };
    window.addEventListener("pagehide", unload);
    return () => {
      unregister();
      window.removeEventListener("pagehide", unload);
      release();
    };
  }, [attempts, code, key]);
  async function join() {
    if (busy || active || !lobby.data) return;
    const attempt = attempts.begin();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const credentials = await endpoints.joinMeeting(
        code,
        lobby.data.identity ? undefined : (meetingGuestName(name) ?? undefined),
        read(key + ".owner") === (me?.id ?? "guest")
          ? read(key) || undefined
          : undefined,
      );
      if (!attempts.isCurrent(attempt)) {
        void endpoints
          .leaveMeeting(code, credentials.participant_token)
          .catch(() => {});
        return;
      }
      save(key, credentials.participant_token);
      save(key + ".owner", me?.id ?? "guest");
      save(key + ".name", name);
      activeRef.current = credentials;
      setActive(credentials);
    } catch (e) {
      if (attempts.isCurrent(attempt)) setError(message(e));
    } finally {
      if (attempts.isCurrent(attempt)) setBusy(false);
    }
  }
  async function leave(end = false) {
    attempts.cancel();
    closeMedia.current?.();
    const current = activeRef.current;
    activeRef.current = null;
    setActive(null);
    setBusy(false);
    save(key, "");
    if (!current) return;
    try {
      if (end && current.can_end && current.workspace_slug)
        await endpoints.endMeeting(current.workspace_slug, current.meeting.id);
      else await endpoints.leaveMeeting(code, current.participant_token);
      setNotice(end ? "Meeting ended." : "You left the meeting.");
    } catch {
      setError(
        "You disconnected. Unable to confirm the meeting action; please retry from your meeting list.",
      );
    }
    void lobby.refetch();
  }
  return (
    <main className="bc-public-meeting">
      <div className="bc-meeting-wordmark">
        <Banana size={30} />
        <strong>
          banana<span>chat</span>
        </strong>
      </div>
      <section className="bc-meeting-lobby">
        <div className="bc-meeting-preview">
          <Icon name="video" size={52} />
          <h2>A good conversation starts here.</h2>
          <p>
            Video, voice and screen sharing.
            <br />
            Together, wherever you are.
          </p>
          <span>PRIVATE LINK · UP TO 8 PEOPLE</span>
        </div>
        <div className="bc-meeting-entry">
          <span className="bc-eyebrow">YOU’RE INVITED</span>
          <h1>{lobby.data?.title || "Join a meeting"}</h1>
          {notice && <p role="status">{notice}</p>}
          {!valid || lobby.isError ? (
            <p role="alert">
              {valid ? message(lobby.error) : "This meeting link is invalid."}
            </p>
          ) : status === "loading" || lobby.isPending ? (
            <p>Checking meeting…</p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void join();
              }}
            >
              {lobby.data?.identity ? (
                <div className="bc-meeting-identity">
                  <Icon name="users" />
                  <div>
                    <small>Joining as a member</small>
                    <strong>{lobby.data.identity.name}</strong>
                  </div>
                </div>
              ) : (
                <>
                  <label>
                    Your name
                    <input
                      autoComplete="name"
                      required
                      maxLength={80}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="How should we call you?"
                    />
                  </label>
                  <p className="bc-meeting-hint">
                    Other participants will see your name with a Guest label.
                  </p>
                  <Link
                    to={
                      "/login?returnTo=" + encodeURIComponent("/meet/" + code)
                    }
                  >
                    Sign in as a member
                  </Link>
                </>
              )}
              <button
                className="bc-primary"
                disabled={
                  busy || (!lobby.data?.identity && !meetingGuestName(name))
                }
              >
                <Icon name="video" size={18} />
                {busy ? "Connecting…" : "Join meeting"}
              </button>
              <p className="bc-meeting-hint">
                Your browser will ask for camera and microphone access. You can
                turn either off in the meeting.
              </p>
            </form>
          )}
          {error && <p role="alert">{error}</p>}
          {lobby.data && (
            <button
              className="bc-meeting-copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(location.href);
                  setCopied(true);
                } catch {
                  setError(
                    "Copy the meeting link from your browser address bar.",
                  );
                }
              }}
            >
              {copied ? "Link copied" : "Copy meeting link"}
            </button>
          )}
          <Link className="bc-meeting-back" to="/">
            Back to Banana Chat
          </Link>
        </div>
      </section>
      {active && (
        <Suspense fallback={<p role="status">Opening meeting…</p>}>
          <MediaPanel
            id={active.meeting.id}
            title={active.meeting.title}
            kind="video"
            url={active.url}
            token={active.token}
            canEnd={active.can_end}
            canMinimize={false}
            onLeave={(end) => void leave(end)}
            registerDisconnect={(fn) => {
              closeMedia.current = fn;
            }}
            checkActive={async () => {
              try {
                await endpoints.meetingLobby(code);
                return true;
              } catch (e) {
                return !(
                  e instanceof ApiError &&
                  [401, 403, 404, 410].includes(e.status)
                );
              }
            }}
          />
        </Suspense>
      )}
    </main>
  );
}
