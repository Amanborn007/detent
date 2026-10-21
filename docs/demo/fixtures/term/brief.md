# Brief: acme/widgets#1

## Goal
Redelivery honours a `Retry-After: 0` header instead of waiting a default second.

## Acceptance criteria
1. An endpoint answering `Retry-After: 0` is retried immediately.
2. Other `Retry-After` values keep their current delay.

## Unknowns & open questions
- U1. Should a `Retry-After` of 0 still count against the attempt cap? (PROPOSED: yes)
