import { conformanceSuite } from "../conformance.mjs";
import { makeFake } from "./kit.mjs";

conformanceSuite({ name: "claude-code", makeFake });
