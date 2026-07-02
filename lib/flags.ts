// lib/flags.ts — feature flags read at build time (NEXT_PUBLIC_ so client
// components can inline them). Keep server-only flags un-prefixed elsewhere.

// Gates the auto-execute ("connect keys" / auto-copy) UI on the public
// prediction dashboard. Default OFF: no key-input surface should ever render
// while this is false, regardless of sign-in state. This commit wires the UI
// and the flag only — no real order execution or key storage.
export const AUTO_EXECUTE_ENABLED = process.env.NEXT_PUBLIC_AUTO_EXECUTE_ENABLED === 'true';
