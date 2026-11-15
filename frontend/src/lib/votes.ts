// Answers from the review queue on /help. They are kept in this browser only, in localStorage under
// "pxh:votes" as {"v":1,"votes":[...]}, and can be downloaded as CSV or JSON. Shared collection is not
// switched on yet: submitVote() is the one place to send a vote to a server once there is one.

import * as React from "react";

export const VOTES_KEY = "pxh:votes";
const VERSION = 1;

export const ANSWERS = ["moves", "brightness", "nothing", "unsure"] as const;
export type Answer = (typeof ANSWERS)[number];

export const ANSWER_LABEL: Record<Answer, string> = {
  moves: "It moves",
  brightness: "It changes brightness",
  nothing: "Nothing real",
  unsure: "Not sure",
};

/** What was reviewed: a real candidate, a known object mixed in as a check, or a practice example. */
export type VoteSource = "candidate" | "check" | "practice";

export interface Vote {
  /** Candidate id, or the example's id. */
  id: string;
  answer: Answer;
  source: VoteSource;
  /** ISO time of the answer. */
  at: string;
  /** For checks and practice: the known answer, and whether this one matched it. */
  expected?: Answer;
  correct?: boolean;
  /** What the model called it, for candidates and checks ("mover" | "variable"). */
  model?: string;
  /** The candidate list run this vote belongs to (its "generated" time). */
  run?: string;
}

// ----------------------------------------------------------------------------- storage

const listeners = new Set<() => void>();
let cache: Vote[] | null = null;
const EMPTY: Vote[] = [];

function isVote(v: unknown): v is Vote {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    o.id.length <= 160 &&
    typeof o.answer === "string" &&
    (ANSWERS as readonly string[]).includes(o.answer) &&
    (o.source === "candidate" || o.source === "check" || o.source === "practice") &&
    typeof o.at === "string"
  );
}

function read(): Vote[] {
  try {
    const raw = window.localStorage.getItem(VOTES_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as { v?: unknown; votes?: unknown };
    if (parsed?.v !== VERSION || !Array.isArray(parsed.votes)) return EMPTY;
    return parsed.votes.filter(isVote);
  } catch {
    return EMPTY;
  }
}

function write(votes: Vote[]) {
  cache = votes;
  try {
    if (votes.length === 0) window.localStorage.removeItem(VOTES_KEY);
    else window.localStorage.setItem(VOTES_KEY, JSON.stringify({ v: VERSION, votes }));
  } catch {
    // Storage full or blocked: the votes still count for this visit.
  }
  listeners.forEach((l) => l());
}

export function getVotes(): Vote[] {
  if (typeof window === "undefined") return EMPTY;
  cache ??= read();
  return cache;
}

/** Keep one answer per item: a new answer for the same id and source replaces the old one. */
export function saveVote(vote: Vote): void {
  const rest = getVotes().filter((v) => !(v.id === vote.id && v.source === vote.source));
  write([...rest, vote]);
}

export function clearVotes(): void {
  write([]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== VOTES_KEY) return;
    cache = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The votes in this browser; [] during the server render. */
export function useVotes(): Vote[] {
  return React.useSyncExternalStore(subscribe, getVotes, () => EMPTY);
}

// ----------------------------------------------------------------------------- sending

/**
 * Record one answer. Today it is kept in this browser only and the result says so. To collect votes
 * centrally, send `vote` to the server here (for example POST /api/votes) and return { shared: true }:
 * nothing else on the page needs to change.
 */
export async function submitVote(vote: Vote): Promise<{ shared: boolean }> {
  saveVote(vote);
  return { shared: false };
}

// ----------------------------------------------------------------------------- export

const CSV_COLUMNS = ["id", "source", "answer", "expected", "correct", "model", "run", "answered_at"] as const;

function csvCell(value: string): string {
  // Quote everything that could break a row, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function votesToCsv(votes: readonly Vote[]): string {
  const rows = votes.map((v) =>
    [v.id, v.source, v.answer, v.expected ?? "", v.correct === undefined ? "" : String(v.correct), v.model ?? "", v.run ?? "", v.at]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export function votesToJson(votes: readonly Vote[]): string {
  return JSON.stringify(
    {
      version: VERSION,
      exported: new Date().toISOString(),
      note: "Answers from the Perturbation review queue, kept in one browser. Not collected centrally.",
      votes,
    },
    null,
    2,
  );
}

/** Save text as a file through the browser's download. */
export function downloadText(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
