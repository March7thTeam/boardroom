import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConnectionStatus, SseFrame } from "../types";
import type { Locale } from "../i18n/core";
import { invalidateBoardEventQueries } from "./boardEventInvalidation";

function getSeqStorageKey(projectId: string): string {
  return `boardroom.lastSeq.${projectId}`;
}

function readStoredSeq(projectId: string): number {
  try {
    const raw = window.localStorage.getItem(getSeqStorageKey(projectId));
    if (!raw) return 0;
    const num = Number(raw);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  } catch {
    return 0;
  }
}

function writeStoredSeq(projectId: string, seq: number): void {
  try {
    window.localStorage.setItem(getSeqStorageKey(projectId), String(seq));
  } catch {
    // ignore storage failures
  }
}

type UseBoardEventsOptions = {
  projectId: string | null;
  locale: Locale;
  boardSeq?: number;
  selectedCardId?: string | null;
};

export function useBoardEvents({
  projectId,
  locale,
  boardSeq,
}: UseBoardEventsOptions): {
  status: ConnectionStatus;
  currentSeq: number;
} {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [currentSeq, setCurrentSeq] = useState<number>(() =>
    projectId ? readStoredSeq(projectId) : 0,
  );

  const lastAppliedSeqRef = useRef<number>(0);
  const projectIdRef = useRef<string | null>(null);
  // Keep seq synchronized when board snapshot arrives with a newer seq
  useEffect(() => {
    if (!projectId) {
      projectIdRef.current = null;
      lastAppliedSeqRef.current = 0;
      setCurrentSeq(0);
      return;
    }

    if (projectIdRef.current !== projectId) {
      // Project switched: never carry the previous project's seq into the new stream.
      projectIdRef.current = projectId;
      const initial = Math.max(readStoredSeq(projectId), boardSeq ?? 0);
      lastAppliedSeqRef.current = initial;
      writeStoredSeq(projectId, initial);
      setCurrentSeq(initial);
      return;
    }

    const initial = Math.max(lastAppliedSeqRef.current, boardSeq ?? 0);
    if (initial > lastAppliedSeqRef.current) {
      lastAppliedSeqRef.current = initial;
      writeStoredSeq(projectId, initial);
      setCurrentSeq(initial);
    } else {
      setCurrentSeq(lastAppliedSeqRef.current);
    }
  }, [projectId, boardSeq]);

  useEffect(() => {
    if (!projectId) {
      setStatus("offline");
      return;
    }

    let disposed = false;
    let es: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let invalidateTimer: number | null = null;
    let pendingCardIds = new Set<string>();
    let invalidateAllCards = false;
    let retryAttempt = 0;

    // Initialize seq from storage or latest board snapshot
    const initialSeq = Math.max(
      lastAppliedSeqRef.current,
      readStoredSeq(projectId),
      boardSeq ?? 0,
    );
    lastAppliedSeqRef.current = initialSeq;
    setCurrentSeq(initialSeq);

    const scheduleBoardRefresh = (cardId?: string | null) => {
      if (cardId) {
        pendingCardIds.add(cardId);
      } else {
        invalidateAllCards = true;
      }
      if (invalidateTimer !== null) {
        return;
      }
      // Refresh board within 150ms of event arrival (coalesce burst frames within 80ms)
      invalidateTimer = window.setTimeout(() => {
        invalidateTimer = null;
        if (disposed) return;

        void invalidateBoardEventQueries(
          queryClient,
          projectId,
          invalidateAllCards ? null : pendingCardIds,
        );
        pendingCardIds.clear();
        invalidateAllCards = false;
      }, 80);
    };

    const connect = () => {
      if (disposed) return;

      if (!navigator.onLine) {
        setStatus("offline");
      } else if (retryAttempt > 0) {
        setStatus("reconnecting");
      }

      const sinceSeq = lastAppliedSeqRef.current;
      const params = new URLSearchParams({
        since: String(sinceSeq),
        lang: locale,
      });
      const url = `/api/v1/projects/${encodeURIComponent(projectId)}/events?${params.toString()}`;

      es = new EventSource(url);

      es.onopen = () => {
        if (disposed) return;
        retryAttempt = 0;
        setStatus("connected");
      };

      es.onmessage = (msg) => {
        if (disposed) return;
        setStatus("connected");

        let frame: SseFrame;
        try {
          frame = JSON.parse(msg.data) as SseFrame;
        } catch {
          return;
        }

        if (frame.t === "hello") {
          const serverSeq = Number(frame.seq);
          if (Number.isFinite(serverSeq)) {
            if (serverSeq > lastAppliedSeqRef.current) {
              // If server seq jumped ahead while disconnected, resync snapshot
              const hadGap =
                lastAppliedSeqRef.current > 0 &&
                serverSeq > lastAppliedSeqRef.current;
              lastAppliedSeqRef.current = serverSeq;
              writeStoredSeq(projectId, serverSeq);
              setCurrentSeq(serverSeq);
              if (hadGap) {
                scheduleBoardRefresh();
              }
            } else {
              setCurrentSeq(lastAppliedSeqRef.current);
            }
          }
          return;
        }

        if (frame.t === "resync") {
          const fromSeq = Number(frame.from);
          if (Number.isFinite(fromSeq) && fromSeq > lastAppliedSeqRef.current) {
            lastAppliedSeqRef.current = fromSeq;
            writeStoredSeq(projectId, fromSeq);
            setCurrentSeq(fromSeq);
          }
          scheduleBoardRefresh();
          return;
        }

        if (frame.t === "event") {
          const seq = Number(frame.seq);
          // Deduplicate: never apply the same or older seq twice
          if (Number.isFinite(seq)) {
            if (seq <= lastAppliedSeqRef.current) {
              return;
            }
            lastAppliedSeqRef.current = seq;
            writeStoredSeq(projectId, seq);
            setCurrentSeq(seq);
          }
          scheduleBoardRefresh(frame.e?.card_id ?? null);
        }
      };

      es.onerror = () => {
        if (disposed) return;
        if (es) {
          es.close();
          es = null;
        }

        if (!navigator.onLine) {
          setStatus("offline");
        } else {
          setStatus("reconnecting");
        }

        retryAttempt += 1;
        const delay = Math.min(1000 * Math.pow(1.5, retryAttempt - 1), 8000);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      };
    };

    const handleOnline = () => {
      if (disposed) return;
      if (!es) {
        retryAttempt = 0;
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connect();
      }
    };

    const handleOffline = () => {
      if (disposed) return;
      setStatus("offline");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    connect();

    return () => {
      disposed = true;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (invalidateTimer !== null) {
        window.clearTimeout(invalidateTimer);
      }
      if (es) {
        es.close();
      }
    };
    // Note: boardSeq is intentionally not in the dependency array so that board query
    // refreshes do not tear down and recreate the SSE connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, locale, queryClient]);

  return { status, currentSeq };
}
