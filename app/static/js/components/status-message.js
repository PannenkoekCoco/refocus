export function createStatusMessage(container) {
  return {
    announce(message) {
      container.textContent = message;
    },
    clear() {
      container.textContent = "";
    },
  };
}
