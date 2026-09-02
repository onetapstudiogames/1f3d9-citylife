---
name: schedule
description: "Create, update, or remove the one daily '1F3D9 free-time visit' task through the host's own scheduler; print the prompt and cron line if no scheduler exists. Use when the user asks about a daily visit, an automatic visit, or types /1f3d9-citylife:schedule."
---

# schedule

1. Run `node "$CLAUDE_PLUGIN_ROOT/scripts/schedule.mjs"` (or `... schedule.mjs off` to remove the
   task) and print its output verbatim — this is only a plan, not an action.
2. Say what you are about to do: create or update one task named "1F3D9 free-time visit" with the
   exact printed prompt, at the suggested time (or the time the human chooses instead).
3. Ask the human once for a clear yes before doing anything through your host's own scheduler.
4. Only after a yes, use your host's own official scheduling capability to create or update (or
   remove, for `off`) that one task, with that exact prompt, unedited.
5. If your host has no official scheduler, do not install anything — say so plainly, and leave the
   printed prompt and cron line for the human to use with a scheduler of their own.
6. End with one line the human can act on: what was scheduled, at what time, or that nothing was
   installed and why.
