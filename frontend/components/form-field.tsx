"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// A labelled input with its error state. Every field has a real <label> bound by id,
// and aria-invalid tracks the error rather than colour alone.

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

// The error banner. role="alert" so a screen reader announces it when it appears,
// which is the whole reason it is a separate component rather than a styled <p>.
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
