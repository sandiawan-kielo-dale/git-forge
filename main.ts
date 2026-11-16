// main.ts — the entrypoint: the small program that hands the forge to the trial env.
//
// The forge itself lives in app.ts; this file only runs the five-step handover the
// harness expects, in order, and then gets out of the way:
//
//   1. Find the env. MAKEFUN_ENV_URL is the env's origin (in a trial container it is
//      something like http://store:8080). With no env there is nobody to register
//      with, so the process says so on stderr and exits 1 right away.
//   2. Start the forge on an ephemeral port. listen(0) lets the kernel choose, which
//      is the point: port 8080 belongs to the env and must never be bound here.
//   3. Tell the env the port. POST {"port": N} to $MAKEFUN_ENV_URL/register; the env
//      remembers where the request came from plus N and dials that from then on.
//      A 200 means it took the registration; a 409 means some other entry got
//      there first, and this process simply waits like any other. 400 and 405 mean
//      the request itself broke the contract, so those are fatal. Anything else —
//      the env still starting, a dropped connection, an odd status — is retried
//      with a pause that doubles each time, up to a cap.
//   4. Wait for the trial to finish. GET $MAKEFUN_ENV_URL/done again and again
//      until the body reads {"done": true}. The env answers immediately
//      ({"done": false} while the suite is still running), so this is a poll.
//      A poll that fails or times out just means "not done yet". The process
//      never leaves before the env says so.
//   5. Shut the forge down and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// Nothing else happens here: no package beyond the forge, no Node built-in, no
// model call. The suite scores app.ts; this file is the harness's lifecycle.

import { createApp } from './app.ts';

/** The env's origin, with any trailing slashes trimmed so paths join cleanly. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

/** Longest a single register or done request is allowed to run before it is dropped. */
const REQUEST_BUDGET_MS = 30_000;
/** First pause between retries, and the ceiling it doubles up to. */
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

/** Resolve after `ms` milliseconds. */
const wait = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** Pause after `failures` failed attempts: doubling from FIRST_BACKOFF_MS, capped. */
function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(failures, 8));
}

/** An error that must end the program instead of being retried. */
class ContractError extends Error {}

/**
 * Keep calling `probe` until it reports a result. `probe` returns a value when the
 * step is finished and `undefined` when it should be tried again; throwing a
 * ContractError ends the program, while any other throw is treated as another
 * failed attempt and retried after the backoff.
 */
async function keepTrying<T>(probe: (round: number) => Promise<T | undefined>): Promise<T> {
  let round = 0;
  for (;;) {
    let outcome: T | undefined;
    try {
      outcome = await probe(round);
    } catch (err) {
      if (err instanceof ContractError) throw err;
      outcome = undefined;
    }
    if (outcome !== undefined) return outcome;
    await wait(backoffMs(round));
    round += 1;
  }
}

/** Tell the env which port the forge bound, retrying until it is accepted. */
async function announcePort(port: number): Promise<void> {
  await keepTrying(async () => {
    const reply = await fetch(`${envOrigin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
    });
    if (reply.status === 200 || reply.status === 409) return true;
    if (reply.status === 400 || reply.status === 405) {
      throw new ContractError(`register answered HTTP ${reply.status}: ${await reply.text()}`);
    }
    return undefined;
  });
}

/** Ask the env again and again whether the trial is over; return only when it is. */
async function waitUntilDone(): Promise<void> {
  await keepTrying(async () => {
    const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
    if (!reply.ok) return undefined;
    const payload = (await reply.json()) as { done?: unknown };
    return payload.done === true ? true : undefined;
  });
}

/** Bind, announce, wait, shut down: the whole life of the process. */
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((bound, failed) => {
    forge.once('error', failed);
    forge.listen(0, () => bound());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered with the env; waiting for it to say done\n');

  await waitUntilDone();
  forge.close();
  process.stdout.write('[entry] trial done; shutting down\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] failed: ${detail}\n`);
  process.exit(1);
}
