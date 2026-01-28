export const createStreamRuntime = ({ output, toolNormalizer, finishTracker }) => {
  let terminated = false;
  const terminalOnce = (fn) => (payload) => {
    if (terminated) return;
    terminated = true;
    fn(payload);
  };

  return {
    handleDelta({ choiceIndex, delta, ...context }) {
      if (terminated) return;
      const normalized = toolNormalizer.ingestDelta(delta);
      finishTracker?.onDelta?.(normalized);
      output.emitDelta(choiceIndex, normalized, context);
    },
    handleMessage({ choiceIndex, message, ...context }) {
      if (terminated) return;
      const normalized = toolNormalizer.ingestMessage(message);
      finishTracker?.onMessage?.(normalized);
      output.emitMessage(choiceIndex, normalized, context);
    },
    handleUsage({ choiceIndex, usage, ...context }) {
      if (terminated) return;
      output.emitUsage(choiceIndex, usage, context);
    },
    handleResult: terminalOnce(({ choiceIndex, finishReason, ...context }) => {
      finishTracker?.finalize?.(finishReason);
      output.emitFinish(choiceIndex, finishReason, context);
    }),
    handleError: terminalOnce(({ choiceIndex, error, ...context }) => {
      output.emitError(choiceIndex, error, context);
    }),
  };
};
