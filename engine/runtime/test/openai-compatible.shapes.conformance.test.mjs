import { shapeConformance } from "../conformance-shapes.mjs";
import { makeOpenAIFake } from "./openai-kit.mjs";

shapeConformance({ name: "openai-compatible", makeFake: makeOpenAIFake });
