import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * The one HTTP client every reference source goes through.
 *
 * Three policies are enforced here rather than left to each client, because
 * getting any of them wrong once is enough to get an IP blocked or to breach a
 * source's terms:
 *
 * 1. A HOST ALLOW-LIST. Several nursing sources are free to read in a browser
 *    but block or forbid automated fetching, and the difference is not visible
 *    at the call site. Hosts are therefore opt-in, with the deny list carrying
 *    the reason so nobody re-adds one by accident.
 * 2. PER-HOST RATE LIMITS, as published by each provider.
 * 3. A DISK CACHE, which NLM explicitly asks for on its services and which also
 *    keeps generation fast and repeatable.
 */

export interface HostPolicy {
  /** Requests per second. */
  rps: number;
  /** Cache lifetime in hours. */
  cacheHours: number;
  note?: string;
}

/**
 * Hosts we may fetch. Anything absent is refused.
 */
export const ALLOWED_HOSTS: Record<string, HostPolicy> = {
  'dailymed.nlm.nih.gov': { rps: 3, cacheHours: 24, note: 'FDA drug labelling (SPL). Public record.' },
  'api.fda.gov': { rps: 4, cacheHours: 24, note: 'openFDA. CC0 public domain.' },
  'rxnav.nlm.nih.gov': { rps: 20, cacheHours: 24, note: 'RxNorm. NLM asks for 24h caching.' },
  'connect.medlineplus.gov': { rps: 1.5, cacheHours: 24, note: 'MedlinePlus Connect: 100 req/min.' },
  'wsearch.nlm.nih.gov': { rps: 1.4, cacheHours: 24, note: 'MedlinePlus search: 85 req/min.' },
  'eutils.ncbi.nlm.nih.gov': { rps: 3, cacheHours: 24, note: 'E-utilities: 3/s without an API key.' },
  'clinicaltables.nlm.nih.gov': { rps: 5, cacheHours: 168, note: 'NLM clinical tables.' },
  'data.cdc.gov': { rps: 2, cacheHours: 168, note: 'CDC open data (Socrata).' },
};

/**
 * Hosts that must never be fetched, with the reason.
 *
 * Kept as data rather than as a comment so the refusal message can explain
 * itself, and so a future contributor sees why before re-adding one.
 */
export const DENIED_HOSTS: Record<string, string> = {
  'apastyle.apa.org': 'Blocks automated requests; APA 7 rules are implemented in code instead.',
  'www.ahajournals.org': 'robots.txt disallows AI agents outright.',
  'ahajournals.org': 'robots.txt disallows AI agents outright.',
  'www.ncbi.nlm.nih.gov': 'Bookshelf HTML serves a CAPTCHA to agents; use E-utilities or the FTP OA subset.',
  'www.cdc.gov': 'Edge filtering returns 403 to agents; use data.cdc.gov or tools.cdc.gov.',
  'wtcs.pressbooks.pub': 'CloudFront blocks automated downloads.',
  'openstax.org': 'robots.txt disallows agents from /books/; the official PDFs are downloaded by hand.',
  'www.jointcommission.org': 'Bot-check shell; standards text is copyrighted.',
  'www.uptodate.com': 'Subscription service; terms prohibit systematic retrieval.',
  'www.uworld.com': 'Commercial test-prep content.',
  'quizlet.com': 'User-uploaded content of unknown provenance and licence.',
};

export class FetchPolicyError extends Error {
  constructor(readonly host: string, readonly reason: string) {
    super(`Refusing to fetch ${host}: ${reason}`);
    this.name = 'FetchPolicyError';
  }
}

/** One token bucket per host, shared process-wide. */
const lastRequestAt = new Map<string, number>();

async function throttle(host: string, rps: number): Promise<void> {
  const minGap = 1000 / rps;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + minGap - Date.now();
  // Reserved before awaiting, so concurrent callers queue instead of racing.
  lastRequestAt.set(host, Math.max(Date.now(), last + minGap));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface FetchOptions {
  /** Where cached responses live. Caching is skipped when unset. */
  cacheDir?: string;
  /** Overrides the host's default cache lifetime. */
  cacheHours?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Bypasses the cache for this call. */
  noCache?: boolean;
}

export interface FetchResult {
  body: string;
  fromCache: boolean;
  url: string;
  status: number;
}

/**
 * NCBI asks that requests identify the tool and a contact. Other NLM services
 * accept the same, so it is sent as a User-Agent everywhere.
 */
const USER_AGENT = 'NurseDeck/0.1 (local study tool; +https://github.com/nursedeck)';

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/** Checks a URL against policy without fetching. Exported for testing. */
export function checkPolicy(url: string): { ok: true; policy: HostPolicy } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Only https is allowed.' };
  }

  const denied = DENIED_HOSTS[parsed.hostname];
  if (denied) return { ok: false, reason: denied };

  const policy = ALLOWED_HOSTS[parsed.hostname];
  if (!policy) {
    return {
      ok: false,
      reason: 'Host is not on the allow-list. Add it only after checking its terms and robots.txt.',
    };
  }
  return { ok: true, policy };
}

export async function fetchReference(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const verdict = checkPolicy(url);
  if (!verdict.ok) {
    throw new FetchPolicyError(new URL(url).hostname, verdict.reason);
  }
  const { policy } = verdict;
  const host = new URL(url).hostname;

  const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${cacheKey(url)}.json`) : undefined;
  const maxAgeMs = (opts.cacheHours ?? policy.cacheHours) * 3_600_000;

  if (cacheFile && !opts.noCache) {
    try {
      const raw = await readFile(cacheFile, 'utf8');
      const entry = JSON.parse(raw) as { at: number; status: number; body: string };
      if (Date.now() - entry.at < maxAgeMs) {
        return { body: entry.body, fromCache: true, url, status: entry.status };
      }
    } catch {
      // A missing or corrupt cache entry simply means a fresh fetch.
    }
  }

  await throttle(host, policy.rps);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  const body = await res.text();

  if (cacheFile && res.ok) {
    try {
      await mkdir(opts.cacheDir!, { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ at: Date.now(), status: res.status, body }), 'utf8');
    } catch {
      // A cache write failure must never fail the request.
    }
  }

  return { body, fromCache: false, url, status: res.status };
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchReference(url, opts);
  if (res.status >= 400) {
    throw new Error(`${new URL(url).hostname} returned ${res.status}.`);
  }
  return JSON.parse(res.body) as T;
}

/** Test seam: clears the rate-limit state between tests. */
export function resetThrottle(): void {
  lastRequestAt.clear();
}
