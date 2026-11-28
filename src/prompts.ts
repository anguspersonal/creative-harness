import { readFileSync } from 'node:fs'
import type { Concept, Critique, MotionConcept, VideoFlag } from './types.ts'
import type { Moment, Signals } from './video/signals.ts'

// All prompt wording lives here so you can tune it on the day without touching the loop.

/** Re-read on every call so edits to rubric.md apply to the next run without a restart. */
export function rubric(): string {
  try {
    return readFileSync('rubric.md', 'utf8')
  } catch {
    return '(rubric.md missing)'
  }
}

export const DIRECTOR_SYSTEM = `You are a sharp creative director. You turn a brief into concepts that would make a real person stop scrolling.
Rules:
- Every concept explores a DIFFERENT axis (emotional register, format, hook mechanism, visual style, point of view). Name the axis.
- First, list in "cliches" the 6 images anyone would make first for this brief's category (for coffee: latte art, a pour, beans scattered on wood, a flat lay, a mug in bed...). No concept may be built on one of them.
- Something must be HAPPENING in the frame: an action caught halfway, an interruption, a consequence, or one detail that is wrong in an interesting way. Nicely arranged objects are not a concept. Say what is happening in "moment".
- Specific beats generic: concrete places, objects, gestures. Real-world mess beats styling.
- visualPrompt is a production-ready prompt for an image model. Write it like a photographer's caption of a real moment, not a styling brief: who or what, doing what, where in the frame (state what is cropped and the vantage point; never a centred subject), light source, palette.
- Never use stock-photography vocabulary in visualPrompt: shallow depth of field, bokeh, soft focus, blurred background, golden hour, cozy, moody, cinematic, rustic, flat lay, styled. These words make the image model produce the stock look the critic rejects.
- The idea must read with NO text: never hinge it on a clock time, a screen, a label, a sign or a number. Image models get those wrong and the idea collapses. Show it with bodies, objects and consequences.
- Every concept must work as ONE still frame, because even video is animated from a single keyframe. No montages, cuts, sequences, split screens, panels or before/after layouts.
- Do not invent brand names, logos or packaging text the brief does not give you.
- medium: "video" only when motion is the point of the idea; otherwise "image".
- Keep it tight: visualPrompt under 80 words, every other field one or two sentences.`

/** Stock-photography phrases stripped from every image prompt before rendering (see util/stock.ts). */
export const STOCK_PHRASES: RegExp[] = [
  /\b(?:with |a |an )?(?:very |extremely )?shallow depth[- ]of[- ]field\b/gi,
  /\b(?:soft |creamy |warm |dreamy )?bokeh(?: lights?| background)?\b/gi,
  /\b(?:softly |slightly |heavily )?(?:soft[- ]focus|blurred|out[- ]of[- ]focus) background\b/gi,
  /\bbackground (?:softly |slightly |heavily )?(?:blurred|out of focus|in soft focus)\b/gi,
  /\bsoft[- ]focus\b/gi,
  /\bgolden[- ]hour(?: light(?:ing)?| glow)?\b/gi,
  /\b(?:cozy|cosy|moody|cinematic|rustic)\b/gi,
  /\bflat[- ]lay\b/gi,
  /\b(?:carefully |beautifully )?styled\b/gi,
  // Image models take placement words literally and pose the subject dead centre.
  /\b(?:perfectly |dead[- ]|neatly |directly )?(?:cent(?:ered|red)|symmetrical(?:ly)?)\b/gi,
]

/** Added to the hero render only: the stronger final model leans glossy and posed without it. */
export function heroPrompt(prompt: string) {
  return `${prompt} Candid, unposed documentary photograph taken in the moment, subject off-centre, natural uneven light, real-world imperfections.`
}

export function directorPrompt(brief: string, n: number, video: boolean) {
  const medium = video ? '' : '\nVideo is switched off for this run: every concept is a still image (medium "image").'
  return `BRIEF:\n${brief}\n\nGenerate ${n} concepts.${medium}\n\nJSON shape: {"cliches":["..."],"concepts":[{"title":"","hook":"","idea":"","moment":"","axis":"","medium":"image"|"video","visualPrompt":"","whyItWorks":""}]}`
}

export const JUDGE_SYSTEM = `You judge creative work for a brief. You pick the one more likely to win human attention AND deliver the brief.
Judge on: first-second hook, originality, specificity, brief fit. Ignore which option is listed first.
Be decisive. Use the rubric.`

export function compareTextPrompt(brief: string, a: Concept, b: Concept) {
  return `RUBRIC:\n${rubric()}\n\nBRIEF:\n${brief}\n\nOPTION A:\n${describe(a)}\n\nOPTION B:\n${describe(b)}\n\nWhich concept should we make? JSON: {"winner":"A"|"B","reason":"one sentence","confidence":0-1}`
}

// The showdown compares drafts, so it must ignore the same render faults the draft critic ignores.
const SHOWDOWN_NOTE = `These are fast drafts. The winner will be re-rendered on a stronger model that draws text and hands properly.
Do NOT judge garbled text, lettering or anatomy glitches. Judge idea, composition, focal point, lighting and brief fit.`

export function compareImagePrompt(brief: string, a: Concept, b: Concept) {
  return `RUBRIC:\n${rubric()}\n\nBRIEF:\n${brief}\n\n${SHOWDOWN_NOTE}\n\nImage 1 is OPTION A ("${a.title}"). Image 2 is OPTION B ("${b.title}").\nWhich draft should we take to the final render? JSON: {"winner":"A"|"B","reason":"one sentence","confidence":0-1}`
}

/** For scripts/compare.ts: two finished posts, no titles, so the judge can't tell which run made which. */
export function compareFinalPrompt(brief: string) {
  return `RUBRIC:\n${rubric()}\n\nBRIEF:\n${brief}\n\nImage 1 is OPTION A. Image 2 is OPTION B. Both are finished posts for this brief.\nWhich would you rather post? JSON: {"winner":"A"|"B","reason":"one sentence","confidence":0-1}`
}

export const CRITIC_SYSTEM = `You are a ruthless but fair creative critic. You look at the actual image, not the intention.
Flag slop with specific visual evidence. Give fixes that a prompt can actually achieve.
verdict: "ship" if it meets the bar, "revise" if fixable, "kill" if the idea itself does not work.`

/** Drafts come from a fast, cheap model; the winner is re-rendered on a stronger one. */
export type CritiqueStage = 'draft' | 'final'

const DRAFT_NOTE = `STAGE: DRAFT. This is a fast, cheap draft. The winner will be re-rendered on a stronger model that draws text and hands properly.
Judge the idea, composition, focal point, lighting and brief fit. Do NOT flag or mark down garbled text, lettering or anatomy glitches at this stage.
Fixes must be things a single-frame image prompt can achieve. Prefer removing distractions over adding elements. Never suggest adding text, captions, labels, panels or montages.`

const FINAL_NOTE = 'STAGE: FINAL. This is the finished render. Judge everything, including text and anatomy.'

// The critic is deliberately NOT shown the image prompt. When it was, it checked the image against the
// prompt word by word and flagged "concept and image disagree" for any detail that differed, even in
// images that delivered the idea (the film brief's best image lost points for a chair facing sideways).
const JUDGE_THE_RESULT = `Judge the image as a finished piece: does it deliver the concept's idea and moment to someone scrolling past?
Details that differ from the concept's description are fine, even better, if the idea still lands.
Flag "Concept and image disagree" only when a viewer would not get the idea from the picture.`

export function criticPrompt(brief: string, c: Concept, version: number, stage: CritiqueStage) {
  return `RUBRIC:\n${rubric()}\n\nBRIEF:\n${brief}\n\nCONCEPT:\n${describe(c)}\n\n${JUDGE_THE_RESULT}\n\n${stage === 'draft' ? DRAFT_NOTE : FINAL_NOTE}\n\nVERSION: ${version}\n\nCritique the attached image. JSON: {"score":0-10,"slop":[],"strengths":["..."],"fixes":["..."],"verdict":"ship"|"revise"|"kill"}
Leave "slop" as [] if there is none. Otherwise each entry is {"flag":"<which rubric slop flag>","evidence":"<what in the image shows it>"}.`
}

export const REVISER_SYSTEM = `You rewrite image prompts to fix specific critique points while keeping what works.
Rules:
- Change at most the two most important things. Keep everything listed under Keep.
- Prefer removing or simplifying over adding. A prompt that grows every round gets worse.
- If the critique says stock-photo composition, generic, or nothing happening: change WHAT is happening (an action in progress, a consequence, one out-of-place detail), not where things sit. Moving the subject off-centre does not fix it.
- Never use stock vocabulary: shallow depth of field, bokeh, soft focus, blurred background, golden hour, cozy, moody, cinematic, rustic, flat lay, styled.
- One single frame. Never add or enlarge text, captions, title cards, labels, clock faces, screens, numbers, signage, panels, split screens or montages. If the critique wants a message spelled out, show it with an object, gesture or composition instead. If the idea currently depends on text, replace that text with a visual.
- Never invent brand names or logos.
- Keep the prompt under 80 words. Be concrete: composition, subject detail, lighting, palette.
Name what you changed in one sentence.`

/** A revision that scored no better than the version it came from, so the reviser tries something else. */
export type FailedAttempt = { changeSummary: string; score: number }

export function revisePrompt(c: Concept, prompt: string, critique: Critique, failed: FailedAttempt[] = []) {
  const tried = failed.length
    ? `\n\nALREADY TRIED FROM THIS PROMPT (did not help, do something different):\n${failed.map((f) => `- ${f.changeSummary} (scored ${f.score}/10)`).join('\n')}`
    : ''
  return `CONCEPT:\n${describe(c)}\n\nCURRENT PROMPT:\n${prompt}\n\nCRITIQUE (score ${critique.score}/10):\nSlop: ${critique.slop.map((s) => `${s.flag} (${s.evidence})`).join('; ') || 'none'}\nKeep: ${critique.strengths.join('; ')}\nFix: ${critique.fixes.join('; ')}${tried}\n\nJSON: {"visualPrompt":"","changeSummary":""}`
}

export function motionPrompt(c: Concept) {
  return `${c.idea}. ${c.hook}. Subtle, purposeful camera movement; the key action happens in the first second.`
}

// ---- Video verifier. The measurements in video/signals.ts decide WHEN to look; these prompts ask
// one narrow question each about the frames chosen. None of them asks "is this video good?".

/** Re-read on every call, like rubric.md, so motion criteria can be tuned while the server runs. */
export function videoRubric(): string {
  try {
    return readFileSync('rubric.video.md', 'utf8')
  } catch {
    return '(rubric.video.md missing)'
  }
}

export const VERIFIER_SYSTEM = `You inspect still frames taken from a short generated video clip. Report only what is visible in the frames you are shown.
The frames were chosen by measuring the pixels of every frame, and each comes with its timestamp. Compare them with each other closely: small differences between neighbouring frames are the point.
Generated video fails in ways camera footage never does: things appear from nowhere, vanish, melt, merge, or change shape, count or identity, and the shot can jump. Name these precisely when you see them. Do not invent them when you do not: ordinary fast movement and motion blur are not faults.`

const seconds = (ts: number[]) => ts.map((t) => `${t.toFixed(2)}s`).join(', ')

function videoContext(c: MotionConcept) {
  const moment = c.moment ? `\nMoment: ${c.moment}` : ''
  return `VIDEO RUBRIC:\n${videoRubric()}\n\nCONCEPT:\nTitle: ${c.title}\nHook: ${c.hook}\nIdea: ${c.idea}${moment}`
}

/** What the measurements say about the opening, in words the model can use. */
function measuredStart(s: Signals) {
  const moving = Math.round((1 - s.firstSecondStill) * 100)
  const start = s.firstMoveAt === null ? 'no sustained movement was measured anywhere' : `sustained movement was first measured at ${s.firstMoveAt.toFixed(2)}s`
  return `MEASURED FROM THE PIXELS: the picture changes in ${moving}% of the first second's frames; ${start}; the first second holds ${s.hookRatio}x the movement of the rest of the clip.`
}

export function hookCheckPrompt(c: MotionConcept, times: number[], s: Signals) {
  return `${videoContext(c)}

These ${times.length} images are frames from the FIRST SECOND of the clip, in order, at ${seconds(times)}.
${measuredStart(s)}

1. "changes": what visibly changes between the first image and the last? If nothing does, say so.
2. "eventStarted": by the last image, has someone or something in the scene started doing something a person scrolling past would notice? Camera drift, flicker and tiny shifts do not count.

JSON: {"changes":"one sentence","eventStarted":true|false}`
}

const WHY: Record<Moment['kind'], (m: Moment) => string> = {
  jump: (m) => `the whole picture changed suddenly, ${m.ratio} times more than in the frames around it`,
  pop: (m) => `part of the picture changed for a single frame and changed back, ${m.ratio} times more than in the frames around it`,
  // Says only what was measured. Telling the model that faults are likely here would invite it to find one.
  fastest: () => 'the picture was changing faster than anywhere else in the clip',
}

export function inspectPrompt(c: MotionConcept, m: Moment, times: number[], zoomed: boolean) {
  const shown = zoomed
    ? `Images 1 to ${times.length} show the SAME zoomed-in area of the frame at ${seconds(times)}, in order. The last image is the whole frame at ${m.t.toFixed(2)}s, for context.`
    : `The images are whole frames at ${seconds(times)}, in order.`
  return `${videoContext(c)}

Every frame of this clip was measured. At ${m.t.toFixed(2)}s ${WHY[m.kind](m)}.
${shown}

1. "changed": describe exactly what is different between the images: what moved, appeared, vanished or changed shape.
2. "kind": classify it.
   - "motion": something moved the way it would in camera footage. Speed and motion blur are fine.
   - "cut": the shot changed to a different framing, angle or scene.
   - "fault": a generation fault. Something appears from nowhere, vanishes, flickers, melts, merges, or changes shape, count or identity.
3. "flag": if "fault", the motion slop flag from the rubric that fits best. Otherwise "".
4. "confidence": how sure you are of the classification.

JSON: {"changed":"one sentence","kind":"motion"|"cut"|"fault","flag":"","confidence":0-1}`
}

export function driftCheckPrompt(c: MotionConcept, times: number[]) {
  return `${videoContext(c)}

These ${times.length} images are the first frame, the middle frame and the last frame of the clip (${seconds(times)}).
The clip is meant to be one continuous shot. Things are supposed to move; they are not supposed to turn into something else.

Compare the first and last images closely. List anything that is no longer the same person, object, text or place: a face, hair or clothing that changed; an object that changed shape, colour or count; a hand with a different number of fingers; lettering that changed; a background that became somewhere else.
Do not list the action itself or its natural results (something poured, picked up, opened, moved, or a camera that moved).

JSON: {"consistent":true|false,"changes":[{"what":"","evidence":""}]}
Leave "changes" as [] if everything stays itself.`
}

export function actionCheckPrompt(c: MotionConcept, times: number[]) {
  return `${videoContext(c)}

These ${times.length} images are frames spread evenly across the whole clip, in order, at ${seconds(times)}.

1. "beats": what happens, one short line per step, using only what the frames show.
2. "sceneChanges": does anything IN the scene move or change (true), or does only the camera move (false)?
3. "deliversMoment": is what happens the concept's moment, or its direct consequence?
4. "impossible": anything camera footage could not show: things passing through each other, liquid going the wrong way, objects arriving from nowhere, movement running backwards. [] if none.
5. "score": 0-10 against the rubric's Motion criteria. Do not lower it for faults: report those in the fields above.
6. "fixes": at most two changes to the motion prompt that would help. [] if none.

JSON: {"beats":["..."],"sceneChanges":true|false,"deliversMoment":true|false,"impossible":[{"what":"","evidence":""}],"score":0-10,"fixes":["..."]}`
}

export const MOTION_REVISER_SYSTEM = `You rewrite the motion prompt for an image-to-video model. The first frame is fixed, so describe only what moves.
Rules:
- One continuous shot. One subject does one physical action, named with a plain verb, starting on the first frame.
- Under 50 words. Do not describe how the scene looks: the image already decides that.
- Frozen, dead first second, or only the camera moves: say who or what moves and how, say it begins at once, and lock the camera off.
- Pop, flicker, morphing, identity drift or impossible motion: ask for less. Fewer things moving, smaller and slower movement, camera locked off, hands and faces kept simple. Never ask for anything to transform.
- Unintended cut: say "single continuous shot, fixed camera, no cuts".
- Motion misses the idea: make the movement the concept's moment.
- Never ask for text, captions or new objects to appear.
Name what you changed in one sentence.`

/** An earlier motion prompt and what the verifier found wrong with the clip it produced. */
export type FailedMotion = { prompt: string; flags: string[] }

export function motionRevisePrompt(c: MotionConcept, prompt: string, flags: VideoFlag[], fixes: string[], tried: FailedMotion[] = []) {
  const earlier = tried.length ? `\n\nEARLIER ATTEMPTS (do something different):\n${tried.map((t) => `- "${t.prompt}" -> ${t.flags.join('; ') || 'no flags'}`).join('\n')}` : ''
  const found = flags.map((f) => `- ${f.flag}${f.at ? ` at ${f.at.toFixed(2)}s` : ''}: ${f.evidence}`).join('\n')
  const moment = c.moment ? `\nMoment: ${c.moment}` : ''
  return `CONCEPT:\nTitle: ${c.title}\nHook: ${c.hook}\nIdea: ${c.idea}${moment}\n\nCURRENT MOTION PROMPT:\n${prompt}\n\nTHE VERIFIER FOUND:\n${found || '- nothing specific'}\nSuggested: ${fixes.join('; ') || 'none'}${earlier}\n\nJSON: {"motionPrompt":"","changeSummary":""}`
}

function describe(c: Concept) {
  // Runs saved before concepts had a "moment" still load (scripts/recritique.ts re-scores old runs).
  const moment = c.moment ? `\nMoment: ${c.moment}` : ''
  return `Title: ${c.title}\nHook: ${c.hook}\nIdea: ${c.idea}${moment}\nAxis: ${c.axis}\nMedium: ${c.medium}\nWhy it works: ${c.whyItWorks}`
}
