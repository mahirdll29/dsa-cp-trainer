// ---------------------------------------------------------------------------
// THE ONLY FILE IN THIS PROJECT THAT TALKS TO GROQ.
//
// Same rule as providers/codeforces/client.ts and providers/leetcode/client.ts:
// one module owns every outbound call, so a model swap, an API change or an
// outage touches exactly one file. This is the THIRD external integration and
// it deliberately reads like the first two — same AbortController, same
// hand-written validation, same typed error `kind`, no Zod, no SDK.
//
// WHY NO GROQ SDK. The API is one POST to one URL with a bearer header. The SDK
// would save about fifteen lines and cost three things: a fourth shape of
// external call in a project whose stated rule is "all calls to a provider live
// in ONE module", a dependency whose own timeout and error semantics we would
// have to learn and then translate into our `kind` vocabulary anyway, and its
// built-in retries — which we specifically do not want here (see MAX_RETRIES
// below, which is zero).
//
// WHAT THIS FILE MUST NEVER DO: import anything from src/engine/. The
// dependency arrow points AI -> engine, never the reverse. That direction IS
// the enforcement of the boundary this whole module exists to protect; a
// comment would not be.
// ---------------------------------------------------------------------------

// FAIL SOFT — THE DELIBERATE OPPOSITE OF lib/env.ts.
//
// src/lib/env.ts calls requireEnv("JWT_SECRET") at import time and KILLS THE
// PROCESS if it is missing, because a server that cannot do auth correctly
// should not accept traffic at all.
//
// GROQ_API_KEY does the exact opposite, and env.ts is left untouched. If it is
// absent the server still boots, every other endpoint works normally, and only
// the two AI routes answer 503. That is not a preference — it is EARNED by the
// architecture. The recommendation engine is pure deterministic logic and is
// fully correct with AI switched off, so the AI is not load-bearing, so
// degrading it is the honest failure mode. Fail fast where the dependency is
// load-bearing; fail soft where the system was designed to work without it.
//
// Read at module scope, which is safe for the same reason LEETCODE_API_URL is:
// server.ts imports "dotenv/config" BEFORE it imports ./app (session-handoff
// trap 3), and everything here is reached through ./app.
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

// THE MODEL IS CONFIG, NOT CODE. Groq's lineup changes often, so a swap must be
// an env edit rather than a code change. The default is the one verified
// against GET /openai/v1/models during planning: present, active, 131,072
// context, and — the part that actually mattered — JSON mode confirmed working.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Configurable for the same reason LEETCODE_API_URL is, plus one this project
// actually uses: pointing it at a local stub is how the malformed-output and
// timeout paths get verified without waiting for a real outage.
const GROQ_BASE_URL = (
  process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"
).replace(/\/+$/, ""); // a trailing slash would produce "v1//chat/completions"

// 20 SECONDS, AND IT IS DELIBERATELY SHORTER THAN BOTH OTHER PROVIDERS.
//
// Measured against the live API during planning: 0.35 s of inference plus up to
// ~0.4 s of queue time. So 20 s is about 25x the observed worst case — a hang
// detector, not a tuning knob.
//
// Codeforces uses 30 s and LeetCode 45 s. Those two bound a long, explicit,
// user-triggered IMPORT sitting behind a spinner, where waiting is the expected
// experience. This bounds a small interactive request where the payload is two
// sentences of prose. A stalled connection is worse than a missing sentence, so
// the bound is tighter.
const REQUEST_TIMEOUT_MS = 20_000;

// ZERO RETRIES — a deliberate divergence from Modules 4 and 5, which both do one
// bounded retry.
//
// Three reasons, and they compound:
//   1. An AI failure is COSMETIC. The recommendation list is already on the
//      page; the explanation is simply absent. Nothing is lost by giving up.
//   2. A retry doubles the latency of a request a person is actively waiting on.
//   3. On 429 — the likeliest failure — retrying spends more of a quota that is
//      already gone. Module 5 reached the same conclusion from the other
//      direction: no backoff worth writing outlasts a real retry-after.
//
// Stated as a constant rather than just omitted, so the choice is visible.
const MAX_RETRIES = 0;

// ---------------------------------------------------------------------------
// ERRORS — a typed `kind`, so callers never string-match on a message.
// Same vocabulary as CodeforcesError and LeetcodeError, so routes/ai.ts reads
// like routes/codeforces.ts and routes/leetcode.ts.
// ---------------------------------------------------------------------------

export type GroqErrorKind =
  | "NOT_CONFIGURED" // no API key -> the route returns 503
  | "RATE_LIMITED" // 429 from Groq -> the route returns 429
  | "TIMEOUT" // AbortController fired
  | "UNAVAILABLE" // 5xx, DNS failure, bad key, unknown model, HTML page
  | "MALFORMED"; // we got a response but not a shape we can use

export class GroqError extends Error {
  constructor(
    public readonly kind: GroqErrorKind,
    message: string,
    // Only ever set on RATE_LIMITED, and only when Groq actually sent the
    // header. Carried as a number rather than re-parsed at the route, because
    // the header is this file's business and nobody else's.
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "GroqError";
  }
}

// ---------------------------------------------------------------------------
// IS THE FEATURE AVAILABLE AT ALL?
//
// A function rather than an exported boolean so it reads as a question at the
// call site: `if (!isAiConfigured())`. The value cannot change at runtime, so
// either would work — this one just documents itself better.
// ---------------------------------------------------------------------------

export function isAiConfigured(): boolean {
  return GROQ_API_KEY !== "";
}

// ---------------------------------------------------------------------------
// VALIDATION HELPERS — identical to the other two providers'.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

// ---------------------------------------------------------------------------
// THE ONE PUBLIC CALL.
//
// Takes a system prompt, a user message and the name of the single JSON field
// the caller wants back; returns that field's string value or throws a
// GroqError. Parameterised by field name because /explain wants "explanation"
// and /hint wants "hint" — the validation is otherwise identical, and two
// near-copies of it would be two places to forget a check.
//
// EVERYTHING BELOW TREATS THE RESPONSE AS UNTRUSTED INPUT, exactly like the
// Codeforces and LeetCode responses. That is not paranoia dressed up as rigour:
// an LLM is a far LESS reliable source of well-shaped data than a documented
// REST API, because it generates its output token by token rather than
// serialising a struct. JSON mode makes malformed output rare; it does not make
// it impossible, and it does nothing at all about a valid JSON object with the
// wrong fields in it.
// ---------------------------------------------------------------------------

export async function completeJsonField(
  systemPrompt: string,
  userMessage: string,
  fieldName: string
): Promise<string> {
  if (!isAiConfigured()) {
    // Checked here as well as at the route, because this is the module that
    // knows the key is missing. A caller that forgets gets a clean typed error
    // rather than a 401 from Groq.
    throw new GroqError("NOT_CONFIGURED", "GROQ_API_KEY is not set");
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callOnce(systemPrompt, userMessage, fieldName);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) throw error;
    }
  }

  throw lastError;
}

async function callOnce(
  systemPrompt: string,
  userMessage: string,
  fieldName: string
): Promise<string> {
  // AbortController is the ONLY way to bound fetch — it has no timeout option
  // and will otherwise wait as long as the socket stays open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          // The system prompt and the user message are kept as SEPARATE
          // messages rather than concatenated into one. Nothing user-authored
          // reaches either slot in this module — both are built server-side
          // from database rows — but keeping the instruction channel separate
          // from the content channel is the right default, and it is what would
          // matter if a code-review endpoint ever landed.
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],

        // JSON MODE. CLAUDE.md specifies "structured JSON output", and it is
        // verified working on this model.
        //
        // The fair objection is that for a one-string payload this is extra
        // tokens and an extra failure mode for no structural gain. It loses on
        // one concrete point: without it, a reasoning model's prose reply
        // arrives wrapped in framing ("Here's an explanation:", markdown,
        // occasional preamble), and stripping that is exactly the string
        // surgery this project refuses to do. JSON mode moves the format
        // guarantee to the API instead of to a regex of ours.
        response_format: { type: "json_object" },

        // LOW, NOT ZERO — and the distinction is the point.
        //
        // Low temperature buys consistency. Zero would NOT buy determinism:
        // Groq assigns a per-request seed, and batching plus floating-point
        // non-associativity mean identical inputs can still produce different
        // text. Claiming otherwise would be exactly the false precision this
        // project refuses elsewhere. The engine is deterministic and therefore
        // testable; this layer is not, and no parameter fixes that — which is
        // precisely why the AI sits ON TOP of the engine rather than inside it.
        temperature: 0.3,

        // 500 IS NOT A COST KNOB HERE, IT IS A CORRECTNESS ONE.
        //
        // This model REASONS before answering, and reasoning tokens come out of
        // the same completion budget as the answer. Measured: 161 completion
        // tokens for a two-sentence reply, 59 of them reasoning.
        //
        // THE TRAP, verified live during planning: in JSON mode an insufficient
        // budget does NOT return a truncated string. Groq returns
        //   400 {"error":{"code":"json_validate_failed","failed_generation":""}}
        // A max_tokens tuned down to "about right" therefore turns every call
        // into a hard API error. 500 is roughly 3x the measured usage.
        max_tokens: 500,

        // Verified: drops reasoning from 59 tokens to 9 and total completion
        // from 161 to 70, with no quality loss on a two-sentence output.
        // Cheaper and faster for free.
        reasoning_effort: "low",
      }),
      signal: controller.signal,
    });
  } catch (error) {
    // An aborted fetch rejects, so "did we time out?" is answered by the signal
    // rather than by inspecting the error message.
    if (controller.signal.aborted) {
      throw new GroqError(
        "TIMEOUT",
        `Groq request timed out after ${REQUEST_TIMEOUT_MS} ms`
      );
    }
    throw new GroqError(
      "UNAVAILABLE",
      `Groq could not be reached: ${(error as Error).message}`
    );
  } finally {
    // Always clear it. A pending timer keeps the event loop alive, so leaking
    // one per request makes the process hang on shutdown for up to 20 s.
    clearTimeout(timer);
  }

  // CHECK 1: is the body JSON at all?
  //
  // Groq's own errors ARE JSON (verified below), so the realistic non-JSON case
  // is something in between us and them — a proxy, a gateway page, a load
  // balancer's HTML. JSON.parse on "<!DOCTYPE html>" throws, and an unhandled
  // throw here would be a 500 instead of a clean 502.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 429 is checked first because a rate-limit body is the one case where a
    // non-JSON response has a specific, actionable meaning. Module 5 found the
    // LeetCode wrapper serving plain text here; the same shape of care applies.
    if (response.status === 429) {
      throw new GroqError(
        "RATE_LIMITED",
        "Groq rate limit reached",
        parseRetryAfter(response)
      );
    }
    throw new GroqError(
      "UNAVAILABLE",
      `Groq returned non-JSON (HTTP ${response.status})`
    );
  }

  const record = asRecord(body);
  if (!record) {
    throw new GroqError("MALFORMED", "Groq did not return a JSON object");
  }

  // CHECK 2: a top-level `error` object, and it is matched on `code`, never on
  // message text. Verified live against the real API:
  //
  //   bad key    -> {"error":{"message":"Invalid API Key",
  //                           "code":"invalid_api_key"}}
  //   bad model  -> HTTP 404 {"error":{...,"code":"model_not_found"}}
  //   tiny budget-> HTTP 400 {"error":{"code":"json_validate_failed", ...}}
  //
  // All three are OUR misconfiguration, not a transient upstream problem, so
  // they collapse to UNAVAILABLE and get logged server-side with the real code
  // while the client sees a generic message.
  const errorRecord = asRecord(record.error);
  if (errorRecord) {
    const code =
      typeof errorRecord.code === "string" ? errorRecord.code : "unknown";
    const message =
      typeof errorRecord.message === "string"
        ? errorRecord.message
        : "no reason given";

    if (response.status === 429) {
      throw new GroqError(
        "RATE_LIMITED",
        `Groq rate limit reached: ${message}`,
        parseRetryAfter(response)
      );
    }

    // json_validate_failed means the model could not produce valid JSON inside
    // the token budget. It is a bad ANSWER, not a broken service, so it is
    // MALFORMED — which keeps it in the same bucket as a reply we could not
    // parse ourselves, because operationally they are the same event.
    if (code === "json_validate_failed") {
      throw new GroqError(
        "MALFORMED",
        `Groq could not produce valid JSON: ${message}`
      );
    }

    throw new GroqError("UNAVAILABLE", `Groq error [${code}]: ${message}`);
  }

  // CHECK 3: only now is the status code worth consulting, as a fallback — the
  // same ordering Modules 4 and 5 arrived at, for the same reason. A body that
  // explains the failure is more informative than a number that does not.
  if (!response.ok) {
    if (response.status === 429) {
      throw new GroqError(
        "RATE_LIMITED",
        "Groq rate limit reached",
        parseRetryAfter(response)
      );
    }
    throw new GroqError("UNAVAILABLE", `Groq returned HTTP ${response.status}`);
  }

  // CHECK 4: the envelope. `choices` must exist, be a non-empty array, and its
  // first element must carry a message with non-empty string content. Each of
  // these is a separate `if` rather than one long boolean because the failure
  // messages differ, and a message that says which check failed is the
  // difference between a five-minute diagnosis and an hour of guessing.
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    throw new GroqError("MALFORMED", "Groq response contained no choices");
  }

  const choice = asRecord(record.choices[0]);
  const message = choice ? asRecord(choice.message) : null;
  const content = message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    // Reachable in practice, not theoretical: a reasoning model that spends its
    // whole budget thinking returns content: "" with finish_reason "length".
    throw new GroqError("MALFORMED", "Groq response contained no content");
  }

  // CHECK 5: does the content parse? JSON mode makes this rare, not impossible,
  // and "rare" is exactly the failure that reaches production unhandled.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // NO REPAIR. We do not slice out the first {...}, do not strip code fences,
    // do not retry with a sterner prompt. String surgery on a model's output is
    // how you turn an obvious failure into a subtle one — the repaired object
    // parses, so nothing downstream notices it may be missing half its content.
    throw new GroqError("MALFORMED", "Groq content was not valid JSON");
  }

  // CHECK 6: the shape of the parsed object. THIS IS THE ONE PEOPLE SKIP.
  // Syntactically valid JSON with the wrong shape is the likeliest bad output
  // of all — {"explanation": {"text": "..."}}, or the field renamed, or an
  // array where an object belongs. JSON mode guarantees valid JSON. It
  // guarantees nothing whatsoever about the keys inside it.
  const parsedRecord = asRecord(parsed);
  if (!parsedRecord) {
    throw new GroqError("MALFORMED", "Groq content was not a JSON object");
  }

  const value = parsedRecord[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new GroqError(
      "MALFORMED",
      `Groq content had no usable "${fieldName}" string`
    );
  }

  return value.trim();
}
