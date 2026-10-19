# NOTICE

This engine layer is original work, but several of its concepts are inspired
by MIT-licensed tools by **Kun Chen**:

- **no-mistakes** — the staged SDLC pipeline concept (intake → research →
  plan → intent check → implement → recheck → review) and the review-finding
  taxonomy (findings carrying an explicit action: `no-op` / `auto-fix` /
  `ask-user`, plus a risk level).
- **lavish-axi** — the visual plan-review loop (plans rendered via curator
  for human eyeballing before implementation).
- **gnhf** — the long-run safeguards: standing PR comment loops, explicit-only
  heavyweight harnesses, and loud-failure guard scripts.

No code was copied from any of these projects; all code in `engine/` was
written from scratch against concept descriptions only.
