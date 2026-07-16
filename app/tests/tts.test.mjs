import test from "node:test";
import assert from "node:assert/strict";
import { createTtsProvider } from "../static/js/services/tts.js";

test("falls back to browser speech when local TTS is unavailable", async () => {
  const spoken = [];
  const provider = createTtsProvider({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    speech: { cancel() {}, speak: (utterance) => spoken.push(utterance.text) },
    AudioCtor: class {},
    UtteranceCtor: class {
      constructor(text) {
        this.text = text;
      }
    }
  });

  assert.deepEqual(await provider.speak("Read this"), { provider: "browser" });
  assert.deepEqual(spoken, ["Read this"]);
});

test("stops active browser speech", async () => {
  let cancellations = 0;
  const provider = createTtsProvider({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    speech: { cancel: () => cancellations++, speak() {} },
    AudioCtor: class {},
    UtteranceCtor: class {}
  });

  await provider.speak("Stop this");
  provider.stop();

  assert.equal(cancellations, 2);
});

test("reports when neither local nor browser speech is available", async () => {
  const provider = createTtsProvider({
    fetchImpl: async () => {
      throw new Error("offline");
    },
    speech: null,
    AudioCtor: class {},
    UtteranceCtor: class {}
  });

  await assert.rejects(provider.speak("Read this"), /No text-to-speech provider is available/);
});
