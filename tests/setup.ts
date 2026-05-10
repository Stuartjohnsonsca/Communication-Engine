/**
 * Per-worker Vitest setup. Currently a no-op; placeholder for future
 * before/after-each hooks that should run inside the worker process (the
 * global-setup runs in the parent and so cannot mutate worker globals like
 * the Prisma singleton).
 */
export {};
