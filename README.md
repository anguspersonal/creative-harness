# creative harness

An agent loop that turns a creative brief into finished content, and shows its working. It explores many ideas, picks between them with a bias-checked tournament, critiques its own renders against a written rubric, revises, and only then spends on a high-quality final. If it animates the result, it measures every frame of the clip and renders it again when the motion is broken.

Built in Bun and TypeScript on [fal](https://fal.ai), for **No Slop Allowed** (36 Labs x fal, London, 28 Nov 2026).

<img src="docs/run3-hero.png" alt="Hero image from the third live run: a hand pouring a moka pot into a cracked mug at a kitchen counter at night, London terraces through the window" width="320" align="right">

**A live run** on the coffee brief with default settings:
- 8 concepts and 12 pairwise matches, each judged twice.
- 3 finalists developed in parallel, up to 4 drafts each.
- One hero render.

That's **about 3 minutes, about $0.34 and 60 model calls, with no errors.** The image on the right is the winner of run 3: *"11pm and Fine With It. The cup that doesn't care what time it is."*

Seven live runs so far: three to get the improve loop actually improving, then four tuning its taste, measured with a blind A/B judge, then a same-session A/B of the critic itself. See [Three live runs](#three-live-runs-and-what-each-one-taught-it), [Tuning taste](#tuning-taste-measured-blind-runs-4-to-7) and [Judging the result](#judging-the-result-not-the-prompt).

<br clear="right">

## How it works

```
brief
  │
  ▼
1. diverge     director LLM writes N concepts, each forced onto a different axis
  │            (emotional register, format, hook mechanism, point of view...)
  ▼
2. select      tournament of pairwise judgements on the text alone (round-robin up to 8, Swiss above).
  │            Every match is judged twice with A and B swapped, to catch position bias.
  ▼
3. develop     for each of K finalists, in parallel:
  │              cheap draft render → vision critic scores it against rubric.md → reviser
  │              repeats until the critic says ship, the score stops rising, or rounds run out
  ▼
4. motion      video runs only: a cheap 3s clip of each of the top 2 finalists, checked by the
  │            video verifier. A finalist whose clip is flagged leaves the showdown.
  ▼
5. showdown    vision judge compares the finalists' best renders head to head, with each one's
  │            motion-test result in the prompt
  ▼
6. final       hero render on a stronger model
  │
  ▼
7. animate     optional 5s image-to-video. Every frame of the clip is measured in code, a vision
               model is shown the moments where the pixels changed most, and a flagged clip is
               re-rendered with a revised motion prompt.
```

Every decision emits a trace event. The UI polls the run and shows rejected concepts, every match and its reason, each draft with its score, flagged slop and the fixes applied, and a running cost counter.

## Design decisions

**Choose with pairwise comparisons, not scores.** LLMs are poor at absolute scores ("7/10") and much better at "which of these two is better, and why". Selection is a tournament of comparisons:
- **Round-robin** up to 8 contenders (the default `tournament: 'auto'`, threshold `roundRobinMax`), so every pair is decided directly. 8 concepts means 28 matches.
- **Swiss rounds** above that, pairing neighbours in the standings for log2(n) rounds, so 16 concepts need 32 matches rather than 120.
- **Configurable:** `--tournament auto|round-robin|swiss` and `--round-robin-max N` on the CLI, or the Tournament menu in the UI. Fields of 3 or fewer always get round-robin.
- **Byes** go to the lowest-ranked contender that hasn't had one, so nobody goes unjudged.
- **Ties** between two break on head-to-head. Ties of three or more break on the judge's summed confidence, because head-to-head can go in a circle (a beat b, b beat c, c beat a).

**Check the judge for position bias.** Each match runs twice with the order swapped. If the two verdicts disagree, the match is marked order-biased in the UI and decided by confidence. Running both orders in parallel with `Promise.allSettled` means one failed call doesn't lose the match.

**Critique what was rendered, not what was asked for.** A vision model looks at the actual image, without being shown the prompt, and scores it against [rubric.md](rubric.md), a plain-language list of what makes content stop a scroll and what counts as slop. The rubric is re-read on every call, so taste can be tuned while the server runs.

**Keep quality and slop as separate signals, and enforce the rules in code.** The critic gives a score for attention and brief fit, and separately lists slop flags. `normaliseCritique` then applies the rules itself rather than trusting the model:
- **Slop blocks shipping.** A flagged "ship" becomes "revise".
- **Each flag costs a point in the ranking.**
- **Duplicate and echoed-empty flags are dropped.**
- **Draft rules differ.** On drafts it ignores faults the final model fixes (garbled text, anatomy), in the flags and in the fixes.

The showdown judge gets the same draft rules.

**Revise from the best version, not the latest.** A revision that scores worse is discarded rather than built upon. The reviser is told what was tried and failed, so its next attempt goes a different way. A "kill" verdict only kills a concept on its first draft; on a later draft it means the revision broke the idea, so that draft is discarded.

**Treat model output as untrusted input.** Every LLM response is pulled out of whatever prose surrounds it and validated with a zod schema. On a validation failure it retries once, sending the error back to the model.

**Refuse the obvious, in the prompt and in code.** The director lists the category's clichés before writing anything and must avoid them. Stock-photography phrases are stripped from every image prompt, because models drift back to them however they are told.

**Measure changes blind.** Absolute critic scores drift between runs, so changes to taste are A/B tested by judging final images pairwise, in both orders, with no titles.

**Spend cheaply until the decision is made.** Concepts are compared as text. Drafts use FLUX schnell (about $0.002, 1s). Only the winner gets the expensive model.

**Fail loudly before spending, carry on after.** A failure before money is spent stops the run. After that, one failed call is logged and the run continues:
- A failed revision keeps the last critiqued version.
- A failed showdown falls back to critic scores.
- A failed hero critique keeps the image.

**Respect the provider's limits.** Every fal call goes through one shared concurrency limiter (new fal accounts start at 2 parallel requests), with per-kind timeouts. `bun run smoke --parallel N` measures the real cap.

**Never guess an API.** Model ids and input/output shapes live only in [src/models.ts](src/models.ts). Each was checked against fal's published schema first. Models disagree in small ways: `768P` vs `720p`, `image_url` vs `start_image_url`, `image_size` vs `aspect_ratio`. `bun run smoke` checks every model against the live API for a few cents.

**Run offline by default.** With no key, a deterministic mock LLM and SVG placeholders run the whole loop and UI for free. `MOCK_FAIL=<regex>` makes chosen calls fail, to rehearse failure paths. Tests always run in mock mode, enforced by a preload, so they can never spend money.

## Three live runs, and what each one taught it

All three runs used the same brief and default settings.

| Run | Draft scores per finalist | Time | Cost | Calls |
|---|---|---|---|---|
| 1 | 4→5→4 · 4→3 · 3→4→2 (killed) | 213s | $0.30 | 50 |
| 2 | 5→5→5 · 5→5→5 · 5→5→5 | 159s | $0.34 | 58 |
| 3 | 4→3→**6**→5 · 6→6→4 · 5→2→5 (score minus slop) | 184s | $0.34 | 60 |

**Run 1: the loop made things worse.**
- **The reviser added things.** To fix "concept and image disagree" it added title cards, numbered labels and four-panel montages. The cheap draft model can't draw text or panels, so each version picked up new faults.
- **Drafts were judged on faults only the final model can fix,** such as garbled text and hands.
- **Some concepts were video ideas drawn as stills,** like quick-cut montages with video switched off.
- **The loop stopped after one worse version,** and a bad revision could kill a good concept.

**The fixes after run 1:**
- The reviser changes at most two things, prefers removing, and never adds text or panels.
- Drafts get their own critic stage.
- Every concept must work as a single frame.
- One more attempt after a non-improving version, revised from the best version so far.
- A "kill" verdict only counts on the first draft.

**Run 2: the machinery worked, but every score was exactly 5.**
- Revisions came from the best version, nothing was killed, and the reviser removed props instead of adding them.
- But all 10 critiques scored exactly 5. The rubric said any slop flag caps the score at 5, and the critic always finds one, usually "stock-photo composition". So the cap turned the score into a constant, and the loop couldn't tell better from worse.
- **The fix:** keep the score as the critic gave it, make slop block shipping, and rank by score minus a point per flag.

**Run 3: scores spread out (4 to 7 raw, 2 to 6 after slop), and the loop improved a concept.** "The Snob's Confession" went from 4 to 6:
1. v2 got worse, so it was discarded.
2. v3 was revised from v1, with the reviser told what had failed in v2.
3. The garbled tasting note became one clean "decaf." card.

<p>
<img src="docs/run3-c2-v1.jpg" alt="v1: espresso glass on dark wood with beans, a spoon and a tasting note card covered in garbled handwriting" width="220">
<img src="docs/run3-c2-v3.jpg" alt="v3: the same glass with a single clean card reading 'decaf.' resting on it" width="220">
</p>

*v1 (6/10, 2 slop flags) → v3 (7/10, 1 slop flag). Both are cheap 1-second drafts. Only the winner gets the expensive render.*

The other two finalists didn't improve on their first draft, and the loop correctly kept v1 for both. The next lever is taste, not plumbing. "Stock-photo composition" was flagged on 9 of 10 drafts and on the hero, so the rubric's definition of it, and the director's first prompts, are where the next gains are.

The tests cover each behaviour above in mock mode. The critic's scores can be scripted per version (`MOCK_SCORES`, `MOCK_VERDICTS`, `MOCK_SLOP`), so the stopping rules, ranking and ship gate are tested directly.

## Tuning taste, measured blind (runs 4 to 7)

"Stock-photo composition" was flagged on 23 of 30 critiques in runs 1 to 3. The critic's evidence showed three causes:
- **The director asked for the stock look.** All 8 run-3 prompts asked for a blurred background ("shallow depth of field", "soft focus", "bokeh"), and several added "golden hour" or "cozy".
- **The scenes were moods, not events.** The evidence kept saying "nothing happening" and "arranged rather than lived-in".
- **The reviser moved things instead of changing them.** It kept shifting the subject off-centre, and the flag came back.

**What changed:**
- **The director refuses the obvious.** It first lists the category's six most obvious images (shown in the trace as "Refused the obvious: ..."). It then names the *moment* happening in each frame, and never hinges an idea on text, a clock or a screen.
- **Stock vocabulary is stripped from every image prompt in code** ([src/util/stock.ts](src/util/stock.ts)), because models drift back to it. This includes "centred" and "symmetrical", which image models take literally.
- **The reviser fixes stock-photo flags by changing what is happening.**
- **The hero render asks for a candid, unposed photograph.**

**Did the loop improve its concepts?** Yes, more reliably than before (scores here are score minus slop):

| Run | Brief | Finalists' draft scores | Finalists improved |
|---|---|---|---|
| 4 | coffee | 2→3→5→4 · 2→1→2 · 1→3→1→**6** | 2 of 3 |
| 5 | coffee | 3→4→3→4 · 2→(critic error) · 3→3→**6**→4 | 2 of 3 |
| 6 | coffee | 1→**6**→(kill, discarded)→3 · 3→2→2 · 4→**6**→4→4 | 2 of 3 |
| 7 | film | 2→**5**→5→2 · 4→4→3 · 4→4→4 | 1 of 3 |

Runs 2 and 3 improved 0 and 1 finalists.

**Were the final images better?** Not measurably. The critic's absolute scores drift, so I compared heroes blind instead, with [scripts/compare.ts](scripts/compare.ts):
- The same vision judge gets two finished images with no titles.
- Each pair is judged in both orders, and only counts if both orders agree.

| Comparison | Wins | Ties (orders disagreed) |
|---|---|---|
| Tuned heroes (runs 5, 6) vs pre-tuning heroes (runs 1 to 3) | 1 to 2 | 3 of 6 |
| Run 4's hero (before the no-text fix) vs runs 1 to 3 | 0 to 3 | 0 of 3 |

<p>
<img src="docs/film-hero.png" alt="Film brief hero: an empty white lifeguard chair on an out-of-season beach, circular grooves dragged in the sand around it, grey sky and shuttered beach huts" width="240">
<img src="docs/run5-hero.png" alt="Coffee run 5 hero: a woman in a baggy t-shirt pours a French press by the light of an open fridge and a crescent-moon nightlight at 3am" width="240">
</p>

*Left: the film brief's winner, "The Lifeguard Chair, Occupied Wrong". Right: coffee run 5, "3am Truce".*

So the tuning made the loop more reliable and the concepts more original, but didn't measurably improve the finished image.

The stock-photo flag didn't go away either: the critic now uses it for "the person looks posed". The critic is shown the prompt, and often flags "concept and image disagree" for literal deviations from it. The film hero lost points because the chair faces sideways rather than inland. That led to the next change: [judging the result, not the prompt](#judging-the-result-not-the-prompt).

## Judging the result, not the prompt

The critic used to be shown the image prompt, and it checked the image against it word for word. In runs 6 and 7, 13 of its 40 slop flags cited the prompt ("the prompt calls for directional grooves, not concentric circles"). Most of those flags were "concept and image disagree". The film brief's most original image lost points because the chair faced sideways rather than inland.

**The change:**
- The critic no longer sees the prompt.
- It's told to judge whether the image delivers the concept's idea to someone scrolling past. Different details are fine if the idea lands.
- The rubric's "concept and image disagree" flag now means "a viewer would not get the idea".

**Measuring it without rendering anything.** I re-critiqued the saved images from runs 6 and 7 (23 renders) twice in the same session: once with the old critic, reconstructed exactly, and once with the new one. Running both on the same images in one sitting controls for drift in model behaviour between days.

| | Old critic (prompt shown) | New critic (judges the result) |
|---|---|---|
| "Concept and image disagree" flags | 18 of 23 renders | 9 of 23 |
| Slop evidence that cites the prompt | 13 of 40 | 3 of 24 |
| Mean score, before and after slop | 5.30 / 3.57 | 5.52 / 4.48 |

**It still catches real failures.** Two known-bad heroes were included as checks, and the new critic flags both:
- The clock reading 8:44 in a concept that depends on 11:42.
- The made-up "NIGHT OWL BREW" mug.

Its objection to the film hero changed from a literal mismatch to a viewer-level point: "a scrolling viewer would likely just see an empty lifeguard chair at an angle". That's a fair critique of the image.

[scripts/recritique.ts](scripts/recritique.ts) re-scores any saved run with the current critic and rubric, so changes to taste can be checked on existing images before paying for new runs.

## Checking video: measure what a model cannot see

The still critic does not transfer to video, for two reasons.

- **A vision model sees a video as a few stills a second.** Timing, stillness, and anything that lasts a frame or two are invisible to it. It cannot tell whether a clip starts moving at once or sits dead for a second, and that is most of what decides whether someone scrolls past.
- **Generated video breaks in time, not in any one frame.** Things pop in, melt, drift into something else, or the shot jumps. Each frame can look fine on its own.

So the verifier splits the job by who is good at what ([src/harness/verifier.ts](src/harness/verifier.ts)).

**Code measures every frame** ([src/video/signals.ts](src/video/signals.ts)). ffmpeg decodes the whole clip into 48x48 greyscale thumbnails, and plain arithmetic on those gives:
- **Frozen:** nothing changes from frame to frame.
- **Dead first second:** the clip does not move until after the first second.
- **Jumps:** the whole frame changes far more than the frames on both sides of it (a cut, a flash).
- **Pops:** an area changes for one frame and changes back.
- **The fastest movement,** in one area and across the frame.

Measurements cost nothing, do not drift between runs, and need no key. A frozen clip is rejected without paying a model to look.

**A vision model looks only where the measurements point.** It is never asked "is this video good?". It gets four narrow questions, each with frames chosen for it:
- **First second:** five frames, a quarter of a second apart. Has an event started?
- **Each sudden change and the fastest moments (up to three):** the frames either side, zoomed into the area that changed. Real movement, a cut, or a generation fault?
- **Start to end:** first, middle and last frame. Is everything still itself?
- **Whole clip:** eight frames. What happens, does anything in the scene move, is it the concept's moment, is anything impossible?

**The verdict is decided in code,** as it is for stills. A measured dead start is flagged whatever the model says. A fault the model is unsure of, or cannot describe, is not a flag. A check that could not run makes the clip "not fully checked", never "pass". Any flag sends the clip back: the motion prompt is rewritten from the flags and the clip is rendered again, up to `videoAttempts` (default 2). The best clip is kept.

The motion criteria live in [rubric.video.md](rubric.video.md), separate from the still rubric.

**Choose on motion, not just the still.** With video on, the top 2 finalists by critic score are each animated as a 3-second 480P clip (about 7.5 cents each at fal's list price) and verified before the showdown. A finalist whose clip is flagged leaves the showdown; if every clip is flagged, all stay in and the judge sees the faults. The showdown judge gets each option's motion result (first second, what happens, motion score, faults) and is told to weigh motion as heavily as the still. Only the winner gets the full 5-second clip. `motionTest` (default 2, `--motion-test N`, 0 to turn off) sets how many finalists are tested. This has only run in mock mode so far.

**Tested by injecting known faults.** I had no labelled set of bad AI clips, so `bun run verify-video <clip> --inject all` puts six known faults into a real clip with ffmpeg and reports which are caught. On four public sample clips from fal's model pages (Veo 3.1, Kling 2.1, Wan 2.2, Hailuo 02):

| Injected fault | Caught by the measurements |
|---|---|
| First frame held for the whole clip | 4 of 4 |
| First frame held for 1.5s | 4 of 4 |
| A third of the clip removed (jump cut) | 4 of 4 |
| Whole frame brightens for one frame | 4 of 4 |
| White block a quarter of the frame wide, one frame | 4 of 4 |
| Grey block a tenth of the frame wide, one frame | 0 of 4 |

The four clean clips raised no alarm. On a fifth sample (Kling v4, multi-shot, handheld action) it reported five jumps, and each is a real cut when viewed frame by frame. It also raised two one-frame pops there; one of them is camera shake. That is what the model step is for: a pop or a jump is a place to look, and it becomes a flag only if the model sees a fault.

**What this does not show yet:**
- **The model checks have only run against the mock.** The build machine had no fal key, so the four vision questions are untested on real clips. `bun run smoke --video` runs the whole path once; `--inject pop --idea "..."` shows whether the model names a fault it is shown.
- **Morphing and identity drift are gradual,** so no measurement catches them. They depend entirely on the model seeing the right frames.
- **A one-frame change smaller than about 2% of the frame is missed.** At that size it cannot be told apart from a fast-moving hand.
- **Thresholds come from five clips.** They are in one block at the top of `signals.ts`.
- **Sound is not checked.**

## Run it

Needs [Bun](https://bun.sh) 1.3+. Checking video also needs [ffmpeg](https://ffmpeg.org) on your PATH (`brew install ffmpeg`); without it clips are still rendered, and the trace says they were not checked.

```bash
bun install
```

```bash
bun run dev
```

Open http://localhost:3000, pick a brief and press Run. With no key it runs in mock mode, offline and free.

### Live, with fal

```bash
cp .env.example .env
```

Add your `FAL_KEY` to `.env`, then check every model works with your account:

```bash
bun run smoke
```

Optionally measure how many calls fal lets you run at once, and set `CONCURRENCY` to match:

```bash
bun run smoke --parallel 6
```

| Command | What it does |
|---|---|
| `bun run start` | Server without file watching (use this for live demos) |
| `bun run harness briefs/example-coffee.md` | Run from the terminal. Flags: `--video`, `--motion-test N`, `--video-attempts N`, `--concepts N`, `--finalists K`, `--iters N` |
| `bun run check` | Typecheck and tests (always mock, never spends) |
| `bun run smoke --video` / `--all` | Also test the video model and the video verifier / every model |
| `bun run verify-video clip.mp4` | Measure every frame of any clip, file or URL. No key, no cost |
| `bun run verify-video clip.mp4 --idea "..."` | Full check: measurements plus the vision-model checks |
| `bun run verify-video clip.mp4 --inject all` | Put known faults into the clip and report which are caught |
| `bun run verify-video <runId>` | Re-check a saved run's clips with the current rubric and prompts |
| `bun run recritique <runs>` | Re-score saved renders with the current critic and rubric (one vision call each) |
| `bun run compare --a <runs> --b <runs>` | Blind A/B test of saved runs' final images, both orders (about half a cent per judgement) |

LLM calls go through fal's OpenRouter router, so one `FAL_KEY` covers image, video and text. Set `LLM_MODEL` or `VISION_MODEL` in `.env` to swap models.

## Layout

| Path | Role |
|---|---|
| `src/harness/director.ts` | Writes diverse concepts |
| `src/harness/selector.ts` | Pairwise judge, Swiss and round-robin tournaments |
| `src/harness/critic.ts` | Vision critic, rubric enforcement, reviser |
| `src/harness/verifier.ts` | Video verifier: chooses frames, asks the model, decides the verdict in code; motion reviser |
| `src/video/signals.ts` | Measurements on every frame, and the thresholds |
| `src/video/clip.ts`, `src/video/inject.ts` | ffmpeg: decode a clip, pull stills; inject known faults |
| `src/harness/loop.ts` | Orchestration, failure handling |
| `src/models.ts` | Every fal model: input builder, output picker, cost estimate. `ROLES` maps jobs to models |
| `src/prompts.ts`, `rubric.md`, `rubric.video.md` | All prompt wording and the judging criteria for stills and for motion, kept out of the loop code |
| `src/llm.ts`, `src/fal.ts` | LLM calls with JSON validation and retry; the rate-limited fal client |
| `src/trace.ts` | Run state and events, saved to `runs/<id>.json` |
| `src/server.ts`, `public/index.html` | API and single-page live UI |
| `src/util/stock.ts` | Strips stock-photography vocabulary from image prompts |
| `scripts/compare.ts`, `scripts/recritique.ts` | Blind pairwise A/B test of saved runs; re-score saved renders |
| `scripts/verify-video.ts` | Check any clip outside a run; test the verifier against injected faults |
| `src/mock.ts` | Offline mock LLM with failure injection and scriptable critic |
| `test/` | Tournament fairness, rubric enforcement, end-to-end and failure-path tests |

## Cost and speed

Measured over seven live runs with defaults (8 concepts, 3 finalists, up to 3 revisions each): **159 to 280 seconds, $0.30 to $0.39, 50 to 64 calls**. Most of the time goes on LLM calls at concurrency 2. Video adds two cheap motion tests (about $0.15 plus their checks), then about $0.20 per 5-second final clip plus up to six vision calls to check it, and a flagged final clip is rendered again (two attempts by default). Those video figures are estimates from fal's prices, not measured. The spend counter uses fal's reported LLM cost plus per-model estimates, so treat it as a guide.

## Ideas not built yet

- **Revise with image edits, not re-rolls**: pass the previous image and fixes to an edit model so v2 keeps what worked.
- **Attention predictor**: a separate judge that only scores "would I stop scrolling in the first second".
- **Storyboarded video**: Kling v4 takes start, end and middle keyframes.
- **Sound**: voiceover, music, or audio added to a silent clip. The video verifier does not listen to the clip either.
- **Check the verifier against people**: have a few people mark faults in the same clips and report how often the verifier agrees.
- **Gradual faults by measurement**: a slow morph leaves no spike. Tracking an area over a second, not a frame, might find them.
- **Learn across runs**: keep the critic fixes that raised scores and feed them to the director next time.

## Licence

[MIT](LICENSE)
