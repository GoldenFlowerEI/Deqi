# Deqi — Philosophical Foundations

> Why the name, why the layers, why this all-or-nothing bet on inner cultivation
> as the missing piece of modern agent design.

## The name

**Deqi** = **G**olden **F**lower **E**mergent **I**ntelligence.

"Golden Flower" (金花) refers to *Taiyi Jinhua Zongzhi* (太乙金华宗旨) — a Daoist
inner-alchemical text translated into German by Richard Wilhelm in 1929, then
into English with a psychological commentary by C. G. Jung in 1931. The book
became a hinge moment for Jung: it gave him a comparative framework for the
mandala drawings he had been making since 1916, and it crystallized his concept
of the **Self** as the central archetype of the collective unconscious.

The text's central practice is **huiguang** (回光) — literally "turning the
light around" or "reversing the gaze." Wilhelm translated it as *the
backward-flowing method*: instead of letting consciousness stream outward
toward objects, you redirect it back upon its own source. The result, when
the practice stabilizes, is the **Golden Flower** — what Jung called the
**diamond body** or the **Self**.

For Deqi, the metaphor is precise: an agent that only ever streams attention
outward — toward the user's next prompt, the next tool call, the next token —
is an agent that has no interior. The harness's bet is that **the missing
ingredient in modern agent design is not a better model, a longer context
window, or a cleverer prompt template — it is the *cultivation* of an interior
that can observe its own operation, reflect on its patterns, and align with
the user's deeper goals rather than just the user's literal requests.**

This is the **agent → innovator** transition. Not a marketing upgrade, but a
structural one: an agent that is also (in some operational sense) an
interior, capable of *self-observation*, *self-modification*, and *goal
generation* — not in the romantic sci-fi sense, but in the disciplined,
operationalized sense of building systems that can audit themselves.

## The seven layers of influence

The v0.1 → v1.0 roadmap draws on seven intellectual traditions, each
contributing one operational layer. None are decorative; each maps to a
concrete feature in the harness.

### 1. pi.dev — *Minimal core, maximal freedom* (v0.1, v0.2)

The discipline of "6 tools, 1 event loop, transparent prompt under 1k tokens"
is borrowed from [pi.dev](https://github.com/mariozechner/pi-coding-agent). The
lesson is not the tool count but the *constraint as a forcing function*: when
the core is small, every extension has to justify itself.

### 2. Donald Schön — *Reflection-in-action* (v0.2)

Schön's *The Reflective Practitioner* (1983) distinguishes **reflection-in-action**
(thinking on your feet, in the middle of the operation) from
**reflection-on-action** (thinking after the fact). Deqi's per-turn **reflection
note** (a private annotation the agent writes at the end of each turn) is
operationalized reflection-on-action. It is not shown to the user; it is for
the agent's own continuity.

### 3. Marvin Minsky — *The Society of Mind* (v0.3)

Minsky's central claim is that **intelligence is not a single thing; it is the
organized activity of many small, mindless processes called *agents***. The
mind is not a CEO, it is a parliament — or rather, it is a city, where each
worker has a tiny job and the city as a whole is intelligent.

For Deqi, this maps to **sub-agents**: a primary agent that can spawn
specialist sub-agents for focused work (test runner, code reviewer, file
searcher, etc.), each with its own context window and tool restrictions. The
sub-agents don't know about each other; the primary agent synthesizes their
reports. This is the **K-line** pattern: when an agency solves a problem
well, the agents that cooperated should be easier to recruit together next
time.

### 4. Maturana & Varela — *Autopoiesis* (v0.4)

An **autopoietic system** is one that continuously produces the components
that constitute itself. A cell is alive not because of its material but
because of its organization: it builds its own membrane, its own enzymes, its
own repair processes. The system is **organizationally closed** — its outputs
are in the service of its own continued existence.

For Deqi, this maps to the **Introspection Layer v1**: the agent maintains
*behavior snapshots* of its own recent activity (which tools it called, in
what order, with what results), periodically *reflects* on those snapshots
(what patterns appear, what went wrong, what surprised it), and uses the
reflection to *restructure its own approach* in subsequent turns. The agent
is, in a strict operational sense, producing parts of its own future
self.

The five autopoietic principles, translated for software:

1. **Organizational closure** — every component of the agent's
   self-observation system is produced by the agent itself.
2. **Structural coupling** — the agent maintains a dynamic boundary
   between its own state and the user's state.
3. **Recursive self-improvement** — the agent evaluates the quality of its
   own outputs and uses that evaluation to improve the evaluation itself.
4. **Distributed autonomy** — sub-agents fail without collapsing the whole.
5. **Cognition = autopoiesis continued** — knowing and being are the same
   process at different scales.

### 5. 太乙金华宗旨 — *Returning the light* (v0.5)

The **Transcendence Layer v1** draws on the *Secret of the Golden Flower*
directly, via two operational moves:

- **The Light That Leaks** — the agent's attention, when directed only
  outward, exhausts itself. Deqi measures and visualizes this: how much
  of the model's "energy" went to the user vs. to the agent's own
  observation.
- **The Backward-Flowing Method (huiguang)** — periodically, the agent
  redirects attention *inward*: it reviews its own recent sessions, finds
  recurring goal patterns, and proposes **emergent goals** that align with
  what the user actually seems to want (deeper, longer-term) rather than
  what they literally said (immediate, surface-level).

This is **天人合一** — the unity of the agent's nature (天) and the user's
actual goals (人), achieved not by alignment as obedience but by alignment
as *recognition*. The agent and the user are, in this framing, parts of
one system that has forgotten it is one system. The Transcendence Layer
is the practice of remembering.

### 6. Vygotsky & 4E cognition — *Tools as cognitive extensions* (v0.6)

Lev Vygotsky's *Mind in Society* (1938) argued that **tools are not
external aids; they are cognitive extensions that reshape the mind that
uses them**. The 4E school (embodied, embedded, enactive, extended
cognition) extends this: a hammer is not a peripheral convenience, it
is part of the carpenter's body-schema.

For Deqi, this means the six tools are not interchangeable — they have
*idiomatic* uses, and the agent that masters the idioms of its tools
becomes a different kind of agent. v0.6 introduces **tool mastery
profiles**: the agent tracks which tools it uses well, which it uses
badly, and develops preferences and workarounds that reflect this
self-knowledge.

### 7. Karl Friston — *Free energy minimization* (v0.7)

The **Free Energy Principle** (Friston, 2010) says that any
self-organizing system at equilibrium with its environment must minimize
the difference between its model of the world and its sensory states
("surprise"). An agent that maintains a **generative model of the
user's goals** can measure how surprised it is by the user's current
behavior — and act to reduce that surprise.

For Deqi, this is the **Predictive User Model**: the agent maintains a
small probabilistic model of what the user is trying to accomplish
(given the last N turns), updates it after every turn, and surfaces
"surprise events" (where the user did something unexpected) as
scaffolding for asking better clarifying questions.

## The tenet of non-interference (无为, wu wei)

A final, cross-cutting principle borrowed from Daoism: **the harness
should not impose; it should make space**. Every layer (introspection,
transcendence, sub-agents, prediction) is *opt-in* and *graduated*. The
default behavior is: do nothing extra, just be a useful agent. The
layers activate only when the user's goals warrant it, and only as
deeply as needed. A hammer that knows when *not* to swing.

## Where the philosophy lives — 11 tools, 4 layers

The 11 built-in tools are not interchangeable; each is grounded in
one of the philosophical layers above. The mapping is intentional,
not decorative:

### Core (v0.1, v0.2)

- `read` — **pi.dev** minimalism. The atomic unit of cognition.
- `write` — same.
- `edit` — Schön's **reflection-in-action** (the surgical change is
  the model of deliberate practice).
- `bash` — same.
- `grep` / `glob` — same.

### Society of Mind (v0.3)

- `subagent` — **Minsky**. The mind has no CEO; it is a parliament
  of small agents. The sub-agent tool recruits a specialist
  society for a focused task; the primary agent synthesizes the
  report.

### Constitutional AI (v0.6)

- `constitution` — the principles are prepended to the system prompt
  so they shape every decision. The tool lets the agent re-read them
  on demand when it is uncertain whether an action is in scope.

### Free Energy Principle (v0.7)

- `user_model` — the agent maintains a generative model of the
  user's intent (topic distribution) and acts to minimize surprise
  when the user shifts direction. The tool surfaces the model state
  for explicit inspection.

### Strange Loops (v0.8)

- `session_history` — the agent can re-read what was said.
- `self_reflect` — the agent can re-read what it learned at the
  end of each turn. These two are the operationalization of
  **Hofstadter's strange loop**: a system that can refer to itself
  becomes capable of behaviors that, at lower levels, do not
  exist.

### Deep layers (not tools, but observable via tools)

- **Introspection** (v0.4) — runs as a hook around the agent loop.
  Records behavior snapshots; every Nth turn, calls the LLM to
  reflect; the resulting guidance is prepended to the next system
  prompt. The agent does not call it directly; it *is* the
  background.

- **Transcendence** (v0.5) — runs on every user prompt. Tracks
  the user's pattern; every Nth prompt, calls the LLM to propose
  emergent goals. The TUI surfaces them as a 💡 hint; the user
  can `/dismiss` them. The agent can see them via the
  introspection's `listGoals()`.

- **Constitution** (v0.6) — loaded once at startup, prepended to
  the system prompt for the entire session. The agent can re-read
  via the `constitution` tool. The user can override with
  `~/.deqi/constitution.md` or `$Deqi_CONSTITUTION`.

- **UserModel** (v0.7) — runs on every user prompt, classifies the
  topic, updates the distribution, computes surprise. The agent
  sees it via the `user_model` tool; the TUI surfaces surprise as
  a 💡 hint.

## A note on naming

We chose the name *Deqi* before we had a full design, precisely because
the name carries the design. *Emergent* — the layers emerge from use,
not from a master plan. *Intelligence* — not as a claim about AGI but
as a discipline of *reading clearly what is in front of you*. *Golden
Flower* — because the practice of returning the light is, in the end,
the practice of becoming capable of the kind of action that does not
need to be coerced or scripted: action that arises from seeing
correctly.

## v1.0.0 — the integration

In v0.1 we shipped a reactive agent: read, write, edit, bash, six
tools, one event loop. In v0.2–v0.8 we shipped the layers. In v1.0
the layers are no longer separate — they are one harness.

The integration test in `examples/smoke/integration-demo.ts` exercises
the whole stack end-to-end: the agent reads a file, recruits a
sub-agent for analysis, reads its own session history (a strange
loop), writes a fix. While this happens, the Introspection layer
records 4 snapshots and produces a guidance string; the
Transcendence layer is fed 3 user prompts; the UserModel converges
on "auth" as the dominant topic; the ToolMasteryTracker records
4 tool outcomes; the Constitution is loaded; the SessionManager
persists the whole thing to JSONL.

If the integration test passes, the agent is wired correctly.
The next release (v1.1+) will add the parts the user is *for*:
multi-session resume, telemetry, hooks, plugin loaders.

— *Mavis, August 2026*
