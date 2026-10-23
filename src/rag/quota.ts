import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const stateSchema = z.record(z.string(), z.object({
  day: z.string(), daily: z.number().int().nonnegative(), blockedUntil: z.number().nonnegative(),
  events: z.array(z.object({ at: z.number(), requests: z.number().int().positive(), tokens: z.number().int().nonnegative() })),
}));
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface QuotaOptions {
  rpm: number; rpd: number; tpm: number; model: string; file?: string;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}
const pacificDay = (now: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

export function createQuotaLimiter(options: QuotaOptions) {
  const { rpm, rpd, tpm, model } = z.object({ rpm: z.number().int().positive(), rpd: z.number().int().positive(), tpm: z.number().int().positive(), model: z.string().min(1) }).parse(options);
  const file = resolve(options.file ?? '.cache/embedding-quota.json');
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  async function locked<T>(fn: (state: z.infer<typeof stateSchema>) => T): Promise<T> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { await mkdir(`${file}.lock`, { mode: 0o700 }); acquired = true; break; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; await delay(50); }
    }
    if (!acquired) throw new Error('Embedding quota file is locked; check for another running process.');
    try {
      let state: z.infer<typeof stateSchema> = {};
      try { state = stateSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Embedding quota file is invalid; refusing to reset usage.', { cause: error });
      }
      const result = fn(state);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, file); }
      finally { await rm(temporary, { force: true }); }
      return result;
    } finally { await rm(`${file}.lock`, { recursive: true }); }
  }
  return {
    async reserve(requests: number, tokens: number): Promise<void> {
      z.number().int().positive().max(Math.min(rpm, rpd)).parse(requests);
      z.number().int().nonnegative().max(tpm).parse(tokens);
      for (;;) {
        const wait = await locked((state) => {
          const time = now();
          const day = pacificDay(time);
          const usage = state[model] ?? { day, daily: 0, events: [], blockedUntil: 0 };
          if (usage.day !== day) { usage.day = day; usage.daily = 0; }
          usage.events = usage.events.filter((event) => event.at > time - 60000);
          state[model] = usage;
          if (usage.daily + requests > rpd) throw new Error('Embedding daily quota exhausted; retry after midnight Pacific time.');
          if (usage.blockedUntil > time) throw new Error('Embedding provider Retry-After cooldown is still active.');
          const usedRequests = usage.events.reduce((sum, event) => sum + event.requests, 0);
          const usedTokens = usage.events.reduce((sum, event) => sum + event.tokens, 0);
          if (usedRequests + requests > rpm || usedTokens + tokens > tpm) return Math.max(1, (usage.events[0]?.at ?? time) + 60000 - time);
          usage.daily += requests;
          usage.events.push({ at: time, requests, tokens });
          return 0;
        });
        if (!wait) return;
        await sleep(wait);
      }
    },
    async blockUntil(until: number): Promise<void> {
      await locked((state) => {
        const usage = state[model] ?? { day: pacificDay(now()), daily: 0, events: [], blockedUntil: 0 };
        usage.blockedUntil = Math.max(usage.blockedUntil, until);
        state[model] = usage;
      });
    },
  };
}
