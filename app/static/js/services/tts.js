export function createTtsProvider({
  fetchImpl = fetch,
  speech = globalThis.speechSynthesis,
  AudioCtor = globalThis.Audio,
  UtteranceCtor = globalThis.SpeechSynthesisUtterance,
  localOrigin = "http://127.0.0.1:8767"
} = {}) {
  let audio = null;

  function stop() {
    if (audio) {
      audio.pause();
      audio = null;
    }
    speech?.cancel();
  }

  async function speak(text) {
    stop();
    try {
      const response = await fetchImpl(`${localOrigin}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/wav" },
        body: JSON.stringify({ text })
      });
      if (!response.ok) {
        throw new Error(`Local TTS returned ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      audio = new AudioCtor(url);
      await audio.play();
      return { provider: "local" };
    } catch {
      if (!speech) {
        throw new Error("No text-to-speech provider is available.");
      }
      const utterance = new UtteranceCtor(text);
      speech.speak(utterance);
      return { provider: "browser" };
    }
  }

  return { speak, stop };
}
