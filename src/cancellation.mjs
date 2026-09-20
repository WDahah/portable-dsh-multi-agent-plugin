// Normal Node ESM. Call only at a trusted, real Cordis Context boundary.
export function registerLifetimeTool(realCtx, definition) {
  const lifetime = new AbortController();
  const active = new Set();
  let unregister;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    lifetime.abort(new DOMException('Tool lifetime disposed', 'AbortError'));
    for (const controller of active) controller.abort(lifetime.signal.reason);
    return unregister?.();
  };
  const wrapped = {
    ...definition,
    async execute(params, exec) {
      lifetime.signal.throwIfAborted();
      const original = exec.signal;
      const controller = new AbortController();
      const onParentAbort = () => controller.abort(original.reason);
      active.add(controller);
      try {
        original.addEventListener('abort', onParentAbort, { once: true });
        if (original.aborted) onParentAbort();
        controller.signal.throwIfAborted();
        return await definition.execute(params, { ...exec, signal: controller.signal });
      } finally {
        original.removeEventListener('abort', onParentAbort);
        active.delete(controller);
      }
    },
  };
  // Cordis invokes the callback immediately, owns release, and returns its
  // callable/thenable effect disposer. Do not replace it with a raw cleanup.
  return realCtx.effect(() => {
    try {
      unregister = realCtx.tools.register(wrapped);
      if (released) unregister();
      return release;
    } catch (error) {
      release();
      throw error;
    }
  });
}
