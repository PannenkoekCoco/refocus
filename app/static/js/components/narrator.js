export function renderNarrator({ container, speechText, tts, onError = () => {} }) {
  if (typeof speechText !== "string" || speechText.length === 0) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "Listen";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await tts.speak(speechText);
      container.dataset.ttsProvider = result.provider;
    } catch {
      onError("Narration is unavailable right now. You can keep learning by reading this screen.");
    } finally {
      button.disabled = false;
    }
  });
  container.append(button);
}
