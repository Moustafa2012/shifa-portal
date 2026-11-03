"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { isLocalPath } from "@/lib/safe-path";

export type FormState = {
  ok?: boolean; error?: string; message?: string; data?: Record<string, string>; redirectTo?: string;
  /** asks the user to confirm and resubmit (e.g. a probable duplicate): a checkbox `name` is added to the form */
  confirm?: { name: string; label: string };
  /** the `name` of the input the error belongs to: the message is also shown under that field, which takes the focus */
  field?: string;
} | undefined;
export type FormAction = (prev: FormState, fd: FormData) => Promise<FormState>;

export function SubmitButton({ children, className = "btn primary", pending: pendingText }: { children: React.ReactNode; className?: string; pending?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending && <span className="spinner" aria-hidden="true" />}{pending && pendingText ? pendingText : children}
    </button>
  );
}

function clearFieldErrors(form: HTMLFormElement, field?: string) {
  form.querySelectorAll<HTMLElement>(field ? `[data-field-error="${CSS.escape(field)}"]` : "[data-field-error]").forEach((n) => {
    const id = n.id;
    n.remove();
    form.querySelectorAll<HTMLElement>(`[aria-describedby~="${CSS.escape(id)}"]`).forEach((i) => {
      const rest = (i.getAttribute("aria-describedby") ?? "").split(" ").filter((x) => x && x !== id).join(" ");
      if (rest) i.setAttribute("aria-describedby", rest); else i.removeAttribute("aria-describedby");
      i.removeAttribute("aria-invalid");
    });
  });
}

/** Wraps a server action: shows its error/success message and clears the form after a successful save. */
export function ActionForm({
  action, children, className, resetOnSuccess = true, id,
}: { action: FormAction; children: React.ReactNode; className?: string; resetOnSuccess?: boolean; id?: string }) {
  // The redirect is performed here, as soon as the server action answers: a revalidation that accompanies the answer can
  // unmount this form (e.g. a pending-deletion panel that disappears after "restore") before any effect would run.
  const [state, formAction] = useFormState(async (prev: FormState, fd: FormData) => {
    const result = await action(prev, fd);
    const to = result?.redirectTo;
    if (isLocalPath(to)) window.location.assign(to);
    return result;
  }, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess && !state.redirectTo) ref.current?.reset();
  }, [state, resetOnSuccess]);
  // an error that names its field is also written under that field (what was typed is kept), marked invalid, and the field takes focus
  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    clearFieldErrors(form);
    if (!state?.error || !state.field) return;
    const named = form.elements.namedItem(state.field);
    const first = named instanceof RadioNodeList ? named[0] : named;
    if (!(first instanceof HTMLElement)) return;
    const input = first instanceof HTMLInputElement && first.type === "hidden"
      ? (first.closest(".field")?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea") ?? first) : first;
    const wrap = input.closest(".field") ?? input.parentElement;
    if (!wrap) return;
    const msg = document.createElement("p");
    msg.className = "field-error"; msg.setAttribute("data-field-error", state.field);
    msg.id = `${id ?? "f"}-${state.field}-err`; msg.textContent = state.error;
    wrap.appendChild(msg);
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", [input.getAttribute("aria-describedby"), msg.id].filter(Boolean).join(" "));
    if (input.offsetParent !== null) input.focus({ preventScroll: false });
    const clear = () => clearFieldErrors(form, state.field);
    form.addEventListener("input", clear, { once: true });
    return () => form.removeEventListener("input", clear);
  }, [state, id]);
  return (
    <form action={formAction} ref={ref} className={className} id={id}>
      {children}
      <div aria-live="polite">
        {state?.error && <p className={`form-msg ${state.confirm ? "warn" : "err"}`} role="alert">{state.error}</p>}
        {state?.confirm && (
          <label className="form-confirm"><input type="checkbox" name={state.confirm.name} />{state.confirm.label}</label>
        )}
        {state?.ok && state.message && <p className="form-msg ok">{state.message}</p>}
      </div>
    </form>
  );
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(+d)) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local that submits an absolute ISO instant, so the viewer's own time zone is respected. */
export function DateTimeField({ name, defaultValue, required, blank }: { name: string; defaultValue?: string | null; required?: boolean; blank?: boolean }) {
  const [local, setLocal] = useState("");
  useEffect(() => { setLocal(defaultValue ? toLocalInput(defaultValue) : blank ? "" : toLocalInput(null)); }, [defaultValue, blank]);
  const iso = local ? new Date(local).toISOString() : "";
  return (
    <>
      <input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} required={required} aria-label={name} />
      <input type="hidden" name={name} value={iso} />
    </>
  );
}

/** Remembers the browser time zone in a cookie so server-rendered times read correctly. */
export function TzSetter({ current }: { current: string }) {
  const router = useRouter();
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz !== current) {
        document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }
    } catch { /* ignore */ }
  }, [current, router]);
  return null;
}

export function ConfirmButton({ message, children, className = "btn danger sm" }: { message: string; children: React.ReactNode; className?: string }) {
  return (
    <button type="submit" className={className} onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}>
      {children}
    </button>
  );
}

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="btn sm" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
    }}>
      {copied ? done : label}
    </button>
  );
}
