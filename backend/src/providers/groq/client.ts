// The only file in this project that talks to Groq. No SDK: the API is one POST to
// one URL, and the SDK's built-in retries are specifically not wanted here.
//
// This file must never import from src/engine/. The dependency arrow points AI ->
// engine, and reversing it would be a visible import cycle.

// Fails SOFT, the deliberate opposite of lib/env.ts. With no key the server boots,
// every other endpoint works, and only the AI routes answer 503. Fail fast where the
// dependency is load-bearing; fail soft where the system was designed to work
// without it - which the engine being correct with AI off is what earns.
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? "";

// Model is config, not code: Groq's lineup changes, so a swap is an env edit.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const GROQ_BASE_URL = (
  process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"
).replace(/\/+$/, ""); // a trailing slash would produce "v1//chat/completions"

// 20 s, deliberately shorter than Codeforces' 30 and LeetCode's 45. Those bound a
// long explicit import behind a spinner; this bounds a small interactive request
// where a stalled connection is worse than a missing sentence.
const REQUEST_TIMEOUT_MS = 20_000;

// Zero retries, against one on both other providers. An AI failure is cosmetic - the
// recommendation list is already on the page - and on 429, the likeliest failure,
// retrying spends a quota that is already gone. Stated as a constant so the choice
// is visible rather than merely absent.
const MAX_RETRIES = 0;

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
    // Only ever set on RATE_LIMITED, and only when Groq actually sent the header.
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "GroqError";
  }
}

export function isAiConfigured(): boolean {
  return GROQ_API_KEY !== "";
}

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

// Returns the named JSON field or throws a GroqError. Parameterised by field name
// because /explain wants "explanation" and /hint wants "hint"; the validation is
// otherwise identical and two near-copies would be two places to forget a check.
//
// The response is treated as untrusted input. An LLM is a LESS reliable source of
// well-shaped data than a REST API, because it generates output token by token.
// JSON mode makes malformed output rare, not impossible, and does nothing at all
// about a valid JSON object with the wrong fields in it.

export async function completeJsonField(
  systemPrompt: string,
  userMessage: string,
  fieldName: string
): Promise<string> {
  if (!isAiConfigured()) {
    // Checked here as well as at the route: a caller that forgets gets a typed error
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
  // AbortController is the only way to bound fetch.
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
          // System and user messages stay SEPARATE rather than concatenated. Nothing
          // user-authored reaches either slot, but keeping the instruction channel apart from
          // the content channel is the right default.
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],

        // JSON mode. Without it a reasoning model's reply arrives wrapped in prose framing
        // ("Here's an explanation:", markdown), and stripping that is exactly the string
        // surgery this project refuses to do.
        response_format: { type: "json_object" },

        // Low, not zero. Zero would NOT buy determinism - Groq assigns a per-request seed
        // and batching makes identical inputs able to differ. This layer is not
        // deterministic and no parameter makes it so, which is precisely why the AI sits on
        // top of the engine rather than inside it.
        temperature: 0.3,

        // max_tokens IS A CORRECTNESS PARAMETER HERE, not a cost knob. This model reasons
        // before answering and reasoning tokens come out of the same budget. In JSON mode an
        // under-budgeted request is a hard 400 (json_validate_failed), not a truncated
        // string - so tuning it down to "about right" turns every call into an API error.
        max_tokens: 500,

        // Cuts reasoning from 59 tokens to 9 with no quality loss on a two-sentence answer.
        reasoning_effort: "low",
      }),
      signal: controller.signal,
    });
  } catch (error) {
    // Answered by the signal, not by the error message.
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
    // A leaked timer keeps the event loop alive and hangs shutdown.
    clearTimeout(timer);
  }

  // Groq's own errors are JSON, so the realistic non-JSON case is something between us
  // and them - a proxy or gateway HTML page, on which JSON.parse throws.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 429 first: a rate-limit body is the one case where non-JSON has actionable meaning.
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

  // Matched on `code`, never on message text. Bad key, unknown model and an
  // under-budgeted request are all OUR misconfiguration rather than a transient
  // upstream problem, so they collapse to UNAVAILABLE and are logged with the code.
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

    // A bad ANSWER, not a broken service - operationally the same event as a reply we
    // could not parse ourselves.
    if (code === "json_validate_failed") {
      throw new GroqError(
        "MALFORMED",
        `Groq could not produce valid JSON: ${message}`
      );
    }

    throw new GroqError("UNAVAILABLE", `Groq error [${code}]: ${message}`);
  }

  // Only now is the status code worth consulting: a body that explains the failure is
  // more informative than a number that does not.
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

  // Each check is a separate `if` because the failure messages differ, and a message
  // naming which check failed is the difference between a five-minute diagnosis and an
  // hour of guessing.
  if (!Array.isArray(record.choices) || record.choices.length === 0) {
    throw new GroqError("MALFORMED", "Groq response contained no choices");
  }

  const choice = asRecord(record.choices[0]);
  const message = choice ? asRecord(choice.message) : null;
  const content = message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    // Reachable, not theoretical: a reasoning model that spends its whole budget
    // thinking returns content "" with finish_reason "length".
    throw new GroqError("MALFORMED", "Groq response contained no content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // NO REPAIR. No slicing out the first {...}, no stripping code fences, no retry with
    // a sterner prompt. String surgery on model output turns an obvious failure into a
    // subtle one: the repaired object parses, so nothing downstream notices.
    throw new GroqError("MALFORMED", "Groq content was not valid JSON");
  }

  // The shape of the parsed object - the check people skip. JSON mode guarantees valid
  // JSON and guarantees nothing whatsoever about the keys inside it.
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
