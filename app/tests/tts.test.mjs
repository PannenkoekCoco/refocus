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

test("does not claim speech after stop cancels a pending local request", async () => {
  let resolveFetch;
  const spoken = [];
  let audioInstances = 0;
  let playCalls = 0;
  const pendingFetch = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const provider = createTtsProvider({
    fetchImpl: () => pendingFetch,
    speech: { cancel() {}, speak: (utterance) => spoken.push(utterance.text) },
    AudioCtor: class {
      constructor() {
        audioInstances++;
      }

      async play() {
        playCalls++;
      }

      pause() {}
    },
    UtteranceCtor: class {},
    urlApi: { createObjectURL: () => "blob:cancelled", revokeObjectURL() {} }
  });

  const pendingSpeak = provider.speak("Do not play this");
  provider.stop();
  resolveFetch({ ok: true, blob: async () => new Blob(["wav"]) });

  await assert.rejects(pendingSpeak, /cancelled/i);
  assert.equal(audioInstances, 0);
  assert.equal(playCalls, 0);
  assert.deepEqual(spoken, []);
});

test("releases a local Blob URL when stopped", async () => {
  const revoked = [];
  const provider = createTtsProvider({
    fetchImpl: async () => ({ ok: true, blob: async () => new Blob(["wav"]) }),
    speech: { cancel() {}, speak() {} },
    AudioCtor: class {
      async play() {}

      pause() {}
    },
    UtteranceCtor: class {},
    urlApi: {
      createObjectURL: () => "blob:stopped",
      revokeObjectURL: (url) => revoked.push(url)
    }
  });

  await provider.speak("Stop this local audio");
  provider.stop();

  assert.deepEqual(revoked, ["blob:stopped"]);
});

test("releases a local Blob URL before replacing local audio", async () => {
  const urls = ["blob:first", "blob:second"];
  const revoked = [];
  let nextUrl = 0;
  const provider = createTtsProvider({
    fetchImpl: async () => ({ ok: true, blob: async () => new Blob(["wav"]) }),
    speech: { cancel() {}, speak() {} },
    AudioCtor: class {
      async play() {}

      pause() {}
    },
    UtteranceCtor: class {},
    urlApi: {
      createObjectURL: () => urls[nextUrl++],
      revokeObjectURL: (url) => revoked.push(url)
    }
  });

  await provider.speak("First local audio");
  await provider.speak("Second local audio");

  assert.deepEqual(revoked, ["blob:first"]);
});

test("releases a local Blob URL when playback ends", async () => {
  const revoked = [];
  let createdAudio;
  const provider = createTtsProvider({
    fetchImpl: async () => ({ ok: true, blob: async () => new Blob(["wav"]) }),
    speech: { cancel() {}, speak() {} },
    AudioCtor: class {
      constructor() {
        createdAudio = this;
      }

      async play() {}

      pause() {}
    },
    UtteranceCtor: class {},
    urlApi: {
      createObjectURL: () => "blob:ended",
      revokeObjectURL: (url) => revoked.push(url)
    }
  });

  await provider.speak("Finish local audio");

  assert.equal(typeof createdAudio.onended, "function");
  createdAudio.onended();
  assert.deepEqual(revoked, ["blob:ended"]);
});
