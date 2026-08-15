"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// One labelled input, and one error banner. Both exist because the two auth
// forms need them identically and a divergence would be invisible — the classic
// version of this bug is one form wiring up `htmlFor` and the other not, which
// nobody notices until someone tries to use it with a screen reader.
//
// SEMANTICS THAT ARE NOT OPTIONAL HERE:
//   - a real <label> bound by htmlFor/id, so clicking the label focuses the
//     field and assistive tech announces it
//   - aria-invalid on failure, so the state is not carried by colour alone
//   - autoComplete tokens, so password managers behave
// ---------------------------------------------------------------------------

export function FormField({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  hint,
  disabled,
  invalid,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  hint?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="t-body-sm font-medium">
        {label}
      </Label>
      {/* The border below is bumped from --rule to --quiet, and the dark-mode
          fill shadcn ships is dropped. WCAG 1.4.11 wants a form field's
          boundary at 3:1 against its background; --rule is a hairline value
          tuned for table separators and measures well under that. An input is
          a control, not a separator, so it gets the stronger value. */}
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="border-quiet/70 h-9 rounded-[2px] bg-transparent dark:bg-transparent"
      />
      {hint ? (
        <p id={`${id}-hint`} className="t-body-sm text-quiet">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// THE ERROR BANNER.
//
// `role="alert"` so it is announced the moment it appears — a sighted user sees
// it because it just materialised, and this is the equivalent for everyone
// else.
//
// It renders the BACKEND'S OWN MESSAGE rather than a generic one. Those
// messages were written to be specific ("Email format is invalid", "Password
// must be at least 8 characters", "Email already registered"), and replacing
// them with "Something went wrong" would throw away the only part of the
// response the user can act on.
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="border-deficit/40 bg-deficit/5 text-deficit t-body-sm rounded-[2px] border px-3 py-2"
    >
      {message}
    </p>
  );
}
