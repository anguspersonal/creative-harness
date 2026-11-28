import type { MediaKind } from './types.ts'

// Every fal endpoint id and input/output shape lives here and nowhere else.
// Schemas checked against each model's https://fal.ai/models/<id>/llms.txt on 2026-11-25.
// To swap a model: add a spec, point ROLES at it, run `bun run smoke`.

export type MediaParams = {
  prompt: string
  /** Start frame for image-to-video. */
  imageUrl?: string
  /** Seconds, for video. */
  seconds?: number
}

export type MediaSpec = {
  endpoint: string
  kind: MediaKind
  build: (p: MediaParams) => Record<string, unknown>
  pick: (data: any) => string | undefined
  estUsd: (p: MediaParams) => number
}

const env = process.env

export const LLM = {
  textEndpoint: 'openrouter/router',
  visionEndpoint: 'openrouter/router/vision',
  // Model strings are passed through to OpenRouter. Both appear on fal's router pages.
  textModel: env.LLM_MODEL ?? 'anthropic/claude-sonnet-5',
  visionModel: env.VISION_MODEL ?? 'anthropic/claude-sonnet-5',
}

export const SPECS = {
  /** FLUX.1 schnell: ~1-2s, $0.003/MP. Drafts and critique rounds. */
  fluxSchnell: {
    endpoint: 'fal-ai/flux/schnell',
    kind: 'image',
    build: (p) => ({ prompt: p.prompt, image_size: 'portrait_16_9', num_images: 1 }),
    pick: (d) => d?.images?.[0]?.url,
    estUsd: () => 0.003 * 0.59, // 576x1024
  },
  /** FLUX.2 dev: better quality, $0.012/MP. */
  flux2: {
    endpoint: 'fal-ai/flux-2',
    kind: 'image',
    build: (p) => ({ prompt: p.prompt, image_size: 'portrait_16_9', num_images: 1 }),
    pick: (d) => d?.images?.[0]?.url,
    estUsd: () => 0.012 * 0.59,
  },
  /** Nano Banana (Gemini 2.5 Flash Image): $0.0398/image. Final hero image. */
  nanoBanana: {
    endpoint: 'fal-ai/nano-banana',
    kind: 'image',
    build: (p) => ({ prompt: p.prompt, aspect_ratio: '9:16', num_images: 1 }),
    pick: (d) => d?.images?.[0]?.url,
    estUsd: () => 0.0398,
  },
  /** Nano Banana edit: fix a specific image instead of re-rolling. Needs imageUrl. */
  nanoBananaEdit: {
    endpoint: 'fal-ai/nano-banana/edit',
    kind: 'image',
    build: (p) => ({ prompt: p.prompt, image_urls: p.imageUrl ? [p.imageUrl] : [], aspect_ratio: 'auto', num_images: 1 }),
    pick: (d) => d?.images?.[0]?.url,
    estUsd: () => 0.0398,
  },
  /** MiniMax H3 Max Turbo i2v: vendor says ~2s for 5s. $0.04/s at 768P. Cheapest motion. */
  h3TurboI2V: {
    endpoint: 'minimax/h3-max-turbo/image-to-video',
    kind: 'video',
    build: (p) => ({
      prompt: p.prompt,
      image_url: p.imageUrl,
      duration: p.seconds ?? 5,
      resolution: '768P', // uppercase P is required
      prompt_expansion_mode: 'balanced',
    }),
    pick: (d) => d?.video?.url,
    estUsd: (p) => 0.04 * (p.seconds ?? 5),
  },
  /** Same model at 480P and 3s, for cheap motion tests of finalists before the final choice. $0.025/s at 480P (standard rate from 16 Nov 2026). */
  h3TurboI2VDraft: {
    endpoint: 'minimax/h3-max-turbo/image-to-video',
    kind: 'video',
    build: (p) => ({
      prompt: p.prompt,
      image_url: p.imageUrl,
      duration: p.seconds ?? 3,
      resolution: '480P', // uppercase P is required
      prompt_expansion_mode: 'balanced',
    }),
    pick: (d) => d?.video?.url,
    estUsd: (p) => 0.025 * (p.seconds ?? 3),
  },
  /** Kling v4 i2v: high quality, $0.157/s at 720p. Note: no fal-ai/ prefix, field is start_image_url. */
  klingV4I2V: {
    endpoint: 'kling/v4/image-to-video',
    kind: 'video',
    build: (p) => ({ prompt: p.prompt, start_image_url: p.imageUrl, duration: p.seconds ?? 5, resolution: '720p' }),
    pick: (d) => d?.video?.url,
    estUsd: (p) => 0.157 * (p.seconds ?? 5),
  },
  /** FLUX 3 Max t2v with native audio. Promo $0.1105/s at 720p until 7 Dec 2026, then $0.17/s. */
  flux3MaxT2V: {
    endpoint: 'blackforestlabs/flux-3-max/text-to-video',
    kind: 'video',
    build: (p) => ({ prompt: p.prompt, duration: p.seconds ?? 5, aspect_ratio: '9:16', resolution: '720p', generate_audio: true }),
    pick: (d) => d?.video?.url,
    estUsd: (p) => 0.1105 * (p.seconds ?? 5),
  },
  /** Kokoro TTS: $0.02 per 1k chars. */
  kokoro: {
    endpoint: 'fal-ai/kokoro/american-english',
    kind: 'audio',
    build: (p) => ({ prompt: p.prompt, voice: 'af_heart' }),
    pick: (d) => d?.audio?.url,
    estUsd: (p) => (0.02 * p.prompt.length) / 1000,
  },
  /** Lyria 2 music: $0.10 per 30s clip. */
  lyria2: {
    endpoint: 'fal-ai/lyria2',
    kind: 'audio',
    build: (p) => ({ prompt: p.prompt }),
    pick: (d) => d?.audio?.url,
    estUsd: () => 0.1,
  },
} satisfies Record<string, MediaSpec>

/** Which model does which job. Change these lines to change the pipeline. */
export const ROLES: { draft: MediaSpec; final: MediaSpec; edit: MediaSpec; video: MediaSpec; motionTest: MediaSpec } = {
  draft: SPECS.fluxSchnell,
  final: SPECS.nanoBanana,
  edit: SPECS.nanoBananaEdit,
  video: SPECS.h3TurboI2V,
  motionTest: SPECS.h3TurboI2VDraft,
}
