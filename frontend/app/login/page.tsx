"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthLink, AuthShell } from "@/components/auth-shell";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const { status, signIn } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Someone who already has a valid session should not be looking at a login
  // form. `replace` rather than `push` so the back button does not walk them
  // into a page they will only be bounced off again.
  useEffect(() => {
    if (status === "authed") router.replace("/");
  }, [status, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
      router.replace("/");
    } catch (caught) {
      // The backend answers "no such user" and "wrong password" with a
      // byte-identical 401 "Invalid credentials" — deliberately, so login
      // cannot be used to discover which email addresses are registered. We
      // pass that message through unchanged rather than trying to be more
      // helpful, because being more helpful here is the vulnerability.
      setError(caught instanceof ApiError ? caught.message : "Could not reach the server.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      intro="Your progress is where you left it."
      footer={
        <>
          No account yet? <AuthLink href="/register">Create one</AuthLink>
        </>
      }
    >
      {/* A real <form> with a submit button, so Enter submits from either field
          and browsers offer to save the password. */}
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <FormError message={error} />

        <FormField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          disabled={submitting}
          invalid={Boolean(error)}
        />
        <FormField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={submitting}
          invalid={Boolean(error)}
        />

        <Button type="submit" disabled={submitting} className="mt-2 h-9 rounded-[2px]">
          {/* The button says what is happening, not "Loading". Sign in ->
              Signing in keeps the same verb through the whole action. */}
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthShell>
  );
}
