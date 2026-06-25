# First-run acknowledgement

This file holds the consent text Scenecraft shows once, before the first generation. It is referenced by `README.md` and is implemented as a one-time modal in the app (see integration notes at the bottom).

---

## Modal copy

**Title:** Before you start

**Body:**

Scenecraft generates images and videos of characters built from reference images you provide. Before you use it, understand and agree to the following.

- Use only likenesses you own or have explicit permission to use. For a real person, that means their consent.
- Do not create sexual or intimate imagery of any real person without their consent. In many places this is illegal.
- Never create sexual content involving minors. This is illegal everywhere and is never permitted, including when running fully offline.
- You are solely responsible for what you generate and for following the terms of any cloud provider you connect.

Running Scenecraft locally removes provider content filters and keeps your data on your machine. It does not remove these legal and ethical limits. They apply no matter where generation happens.

**Checkbox:** I have read this and agree to use Scenecraft only for content I am permitted to create.

**Button (disabled until checkbox is ticked):** Agree and continue

---

## Integration notes (for Claude Code)

- Show this modal on first launch, before any generation is possible. Block the generate action until it is accepted.
- Persist acceptance to a local flag (e.g. `accepted_terms: true` plus a timestamp and the app version in the app's settings/config file). Do not show it again once accepted.
- Re-show it once if this document's terms change in a future version: store the accepted version and compare on launch.
- Keep the copy verbatim. Do not soften, shorten, or paraphrase the four bullets or the minors line.
- Style it as a plain, non-dismissible modal: no "skip", no close button, only the checkbox-gated continue. Match the app's light/dark theming.
- The checkbox must default to unchecked and the continue button must be disabled until it is ticked.
