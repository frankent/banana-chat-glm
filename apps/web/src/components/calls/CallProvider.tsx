import { Icon } from "../Visual";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { RoomCall, CallJoin } from "@banana-chat/shared";
import { CallAttempt, canRingCall } from "@banana-chat/chat-core";
import { useSession } from "../../state/session";
import { useEcho } from "../../echo/EchoProvider";
import { endpoints } from "../../lib/api";
import { registerSessionCleanup } from "../../lib/session-resources";
import "./calls.css";
const CallPanel = lazy(() => import("./CallPanel"));
type Active = CallJoin & { slug: string };
const attempts = new CallAttempt();
let closeMedia: (() => void) | null = null;
registerSessionCleanup(() => {
  attempts.cancel();
  closeMedia?.();
  closeMedia = null;
});
const Context = createContext<{
  enabled: boolean;
  calls: RoomCall[];
  busy: boolean;
  start: (roomId: string, kind: "voice" | "video") => void;
  join: (call: RoomCall) => void;
}>({ enabled: false, calls: [], busy: false, start: () => {}, join: () => {} });
const useCalls = () => useContext(Context);
export function CallProvider({ children }: { children: ReactNode }) {
  const { me, status, currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug;
  const { echo } = useEcho();
  const qc = useQueryClient();
  const [active, setActive] = useState<Active | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ["calls", me?.id, slug],
    queryFn: () => endpoints.calls(slug!),
    enabled: status === "authenticated" && !!slug,
    refetchInterval: 5000,
  });
  const calls = query.data?.calls ?? [];
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: ["calls"] }),
    [qc],
  );
  const userId = me?.id;
  useEffect(() => {
    if (!echo || !userId) return;
    const channel = echo.private(`user.${userId}`);
    const handler = () => refresh();
    channel.listen(".call.changed", handler);
    return () => {
      channel.stopListening(".call.changed", handler);
    };
  }, [echo, userId, refresh]);
  useEffect(() => {
    if (status !== "authenticated") {
      attempts.cancel();
      closeMedia?.();
      // Session changes invalidate external media ownership and its visible UI.
      // eslint-disable-next-line react/set-state-in-effect
      setActive(null);
      setBusy(false);
      setDismissed([]);
    }
  }, [status]);
  const incoming = calls.filter(
    (c) => me && canRingCall(c, me.id) && !dismissed.includes(c.id),
  );

  async function join(call: RoomCall) {
    if (active || busy || !slug) return;
    const attempt = attempts.begin();
    setBusy(true);
    setError("");
    try {
      const credentials = await endpoints.joinCall(call.id, slug);
      if (attempts.isCurrent(attempt)) setActive({ ...credentials, slug });
    } catch (e) {
      if (attempts.isCurrent(attempt))
        setError(e instanceof Error ? e.message : "Unable to join call");
    } finally {
      if (attempts.isCurrent(attempt)) setBusy(false);
      refresh();
    }
  }
  async function start(roomId: string, kind: "voice" | "video") {
    if (active || busy || !slug) return;
    const attempt = attempts.begin();
    setBusy(true);
    setError("");
    try {
      const call = await endpoints.startCall(roomId, kind, slug);
      if (!attempts.isCurrent(attempt)) return;
      const credentials = await endpoints.joinCall(call.id, slug);
      if (attempts.isCurrent(attempt)) setActive({ ...credentials, slug });
    } catch (e) {
      if (attempts.isCurrent(attempt))
        setError(e instanceof Error ? e.message : "Unable to start call");
    } finally {
      if (attempts.isCurrent(attempt)) setBusy(false);
      refresh();
    }
  }
  async function leave(end = false) {
    const current = active;
    attempts.cancel();
    closeMedia?.();
    closeMedia = null;
    setActive(null);
    setBusy(false);
    if (current)
      try {
        await endpoints.callAction(
          current.call.id,
          end ? "end" : "leave",
          current.slug,
        );
      } catch {
        setError("Disconnected. Server cleanup will finish automatically.");
      } finally {
        refresh();
      }
  }
  return (
    <Context.Provider
      value={{
        enabled: query.data?.enabled ?? false,
        calls,
        busy: busy || !!active,
        start: (r, k) => void start(r, k),
        join: (c) => void join(c),
      }}
    >
      {children}
      {error && (
        <div className="bc-call-alert" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss call error">
            ×
          </button>
        </div>
      )}
      {!active &&
        !busy &&
        incoming.slice(0, 1).map((c) => (
          <div
            className="bc-call-incoming"
            role="dialog"
            aria-label="Incoming call"
            key={c.id}
          >
            <span className="bc-call-pulse">
              <Icon name={c.kind === "voice" ? "phone" : "video"} size={28} />
            </span>
            <div>
              <strong>{c.caller_name}</strong>
              <p>
                {c.kind === "voice" ? "Voice call" : "Video call"}
                {c.room_name ? ` · ${c.room_name}` : ""}
              </p>
            </div>
            <button onClick={() => void join(c)}>Join</button>
            <button
              className="bc-call-decline"
              onClick={() => {
                setDismissed((v) => [...v, c.id]);
                void endpoints
                  .callAction(c.id, "decline", slug!)
                  .then(refresh)
                  .catch(() => {});
              }}
            >
              Decline
            </button>
          </div>
        ))}
      {active && (
        <Suspense
          fallback={
            <div className="bc-call-loading">
              Preparing call…{" "}
              <button onClick={() => void leave()}>Cancel</button>
            </div>
          }
        >
          <CallPanel
            key={active.call.id}
            active={active}
            onLeave={(end) => void leave(end)}
            registerDisconnect={(fn) => {
              closeMedia = fn;
            }}
          />
        </Suspense>
      )}
    </Context.Provider>
  );
}
export function CallButtons({
  roomId,
  type,
}: {
  roomId: string;
  type: "dm" | "group";
}) {
  const c = useCalls();
  if (!c.enabled) return null;
  const ongoing = c.calls.find((call) => call.room_id === roomId);
  return (
    <>
      {ongoing ? (
        <button
          className="bc-tool-button bc-call-join"
          disabled={c.busy}
          onClick={() => c.join(ongoing)}
        >
          Join call
        </button>
      ) : (
        <>
          {type === "dm" && (
            <button
              className="bc-tool-button"
              disabled={c.busy}
              aria-label="Start voice call"
              onClick={() => c.start(roomId, "voice")}
            >
              <Icon name="phone" size={16} />{" "}
              <span className="bc-call-label">Voice</span>
            </button>
          )}
          <button
            className="bc-tool-button"
            disabled={c.busy}
            aria-label="Start video call"
            onClick={() => c.start(roomId, "video")}
          >
            <Icon name="video" size={16} />{" "}
            <span className="bc-call-label">Video</span>
          </button>
        </>
      )}
    </>
  );
}
