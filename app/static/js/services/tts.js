export function createTtsProvider({
  fetchImpl = fetch,
  speech = globalThis.speechSynthesis,
  AudioCtor = globalThis.Audio,
  UtteranceCtor = globalThis.SpeechSynthesisUtterance,
  urlApi = globalThis.URL,
  localOrigin = "http://127.0.0.1:8767"
} = {}) {
  let audio = null;
  let audioUrl = null;
  let requestGeneration = 0;

  function releaseActiveAudio() {
    const activeAudio = audio;
    const activeUrl = audioUrl;
    audio = null;
    audioUrl = null;
    activeAudio?.pause();
    if (activeUrl !== null) {
      urlApi.revokeObjectURL(activeUrl);
    }
  }

  function stop() {
    requestGeneration++;
    releaseActiveAudio();
    speech?.cancel();
  }

  async function speak(text) {
    stop();
    const generation = requestGeneration;
    let requestAudio = null;
    let requestUrl = null;
    try {
      const response = await fetchImpl(`${localOrigin}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/wav" },
        body: JSON.stringify({ text })
      });
      if (!response.ok) {
        throw new Error(`Local TTS returned ${response.status}`);
      }
      const blob = await response.blob();
      if (generation !== requestGeneration) {
        throw new Error("Speech request was cancelled.");
      }
      requestUrl = urlApi.createObjectURL(blob);
      requestAudio = new AudioCtor(requestUrl);
      audio = requestAudio;
      audioUrl = requestUrl;
      const releasePlaybackUrl = () => {
        if (audio === requestAudio) {
          audio = null;
        }
        if (audioUrl === requestUrl) {
          audioUrl = null;
          urlApi.revokeObjectURL(requestUrl);
        }
      };
      requestAudio.onended = releasePlaybackUrl;
      requestAudio.onerror = releasePlaybackUrl;
      await requestAudio.play();
      if (generation !== requestGeneration) {
        throw new Error("Speech request was cancelled.");
      }
      return { provider: "local" };
    } catch (error) {
      if (audio === requestAudio) {
        audio = null;
        requestAudio?.pause();
      }
      if (requestUrl !== null && audioUrl === requestUrl) {
        audioUrl = null;
        urlApi.revokeObjectURL(requestUrl);
      } else if (requestUrl !== null && requestAudio === null) {
        urlApi.revokeObjectURL(requestUrl);
      }
      if (generation !== requestGeneration) {
        throw error;
      }
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
