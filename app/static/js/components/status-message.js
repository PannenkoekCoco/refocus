export function createStatusMessage({ container, tts, onNarrationError = () => {} }) {
  let reportingNarrationError = false;

  function reportNarrationError(error) {
    if (reportingNarrationError) return;
    reportingNarrationError = true;
    try {
      onNarrationError(error);
    } catch {
      // Status text remains available even when an optional error handler fails.
    } finally {
      reportingNarrationError = false;
    }
  }

  return {
    announce(message) {
      container.textContent = message;
      if (reportingNarrationError || typeof message !== "string" || message.trim().length === 0 || !tts?.speak) {
        return;
      }
      try {
        void tts.speak(message).catch(reportNarrationError);
      } catch (error) {
        reportNarrationError(error);
      }
    },
    clear() {
      container.textContent = "";
    },
  };
}
