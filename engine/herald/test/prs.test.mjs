import { test } from "node:test";
import assert from "node:assert/strict";
import { countUnresolvedBotThreads } from "../herald.mjs";

test("countUnresolvedBotThreads counts only unresolved review threads with a bot author", () => {
  const threads = [
    // unresolved + bot author -> counts
    { isResolved: false, comments: { nodes: [{ author: { __typename: "Bot" } }] } },
    // resolved -> skip even though bot
    { isResolved: true, comments: { nodes: [{ author: { __typename: "Bot" } }] } },
    // unresolved but only human authors -> skip
    { isResolved: false, comments: { nodes: [{ author: { __typename: "User" } }] } },
    // unresolved, mixed authors incl. a bot -> counts
    {
      isResolved: false,
      comments: { nodes: [{ author: { __typename: "User" } }, { author: { __typename: "Bot" } }] },
    },
  ];
  assert.equal(countUnresolvedBotThreads(threads), 2);
});

test("countUnresolvedBotThreads tolerates missing/empty input", () => {
  assert.equal(countUnresolvedBotThreads(undefined), 0);
  assert.equal(countUnresolvedBotThreads([]), 0);
  assert.equal(countUnresolvedBotThreads([{ isResolved: false, comments: { nodes: [] } }]), 0);
});
