import { conformanceSuite } from "../conformance.mjs";
import { makeOpenAIFake } from "./openai-kit.mjs";

Object.assign(process.env, {
  DETENT_OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
  DETENT_OPENAI_MODEL: "fake-model",
  DETENT_OPENAI_API_KEY_ENV: "DETENT_FAKE_KEY",
  DETENT_FAKE_KEY: "sk-sentinel",
});
delete process.env.DETENT_RUNTIME;

conformanceSuite({ name: "openai-compatible", makeFake: makeOpenAIFake });
