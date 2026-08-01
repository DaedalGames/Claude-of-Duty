/**
 * Look presets: the art-direction axis, orthogonal to QUALITY_PRESETS.
 *
 * QUALITY_PRESETS decides how much the frame costs. This decides what the frame
 * looks like. They compose: `?look=stylized&q=low` is a cheap stylised frame.
 *
 * A look is not a colour grade. The grade is the cheapest and shallowest layer;
 * what actually separates a hero-shooter frame from a photographic one lives in
 * the surfaces. This repo has no art assets — every texture is baked from noise
 * parameters at load — so a look can be expressed as a *transform over those
 * parameters* rather than a second set of hand-authored textures.
 *
 * The transform is deliberately multiplicative and applied to the merged params,
 * so it rides on top of all 62 surface definitions without any of them being
 * rewritten, and `realistic` is exactly the engine's original numbers.
 */

/**
 * The layers, cheapest first. Each one can be switched on alone, so the
 * contribution of every layer is separable rather than bundled:
 *
 *   L1 grade      post-process colour only. No geometry or material change.
 *   L2 material   the noise parameters every surface is baked from.
 *   L3 light      ambient lift and shadow softening; painted art has fill light
 *                 where a photographic frame has occlusion.
 *   L4 fx         particle and impact palette.
 *
 * `?layers=grade,material` turns on exactly those. `?look=stylized` is the
 * shorthand for all of them; `?look=realistic` is none.
 */
export const LAYERS = ['grade', 'material', 'light', 'fx'];

export const LOOK_PRESETS = {
  // The engine as authored: photographic PBR, AgX, cinematic grade.
  realistic: {
    grade: 'default',
    layers: [],
    mat: null,
  },

  // Hero-shooter: painted surfaces, saturated grade, less grime.
  stylized: {
    grade: 'stylized',
    layers: LAYERS,
    mat: {
      // Fewer fBm octaves. High-frequency noise is what reads as "photographed
      // concrete"; a painted surface carries large shapes and almost no grain.
      octaves: 0.55,
      // Roughness variance flattens. Stylised materials pick one specular
      // behaviour per surface instead of breaking it up per-texel.
      roughVar: 0.30,
      // Weathering and patch grime are the two channels that most read as
      // "used, real, dirty". Keep some so surfaces are not plastic.
      weather: 0.35,
      patch: 0.40,
      // Albedo lift. Stylised art sits brighter than scene-referred albedo and
      // relies on the grade's contrast rather than dark base colours.
      albedo: 0.16,
    },
  },
};

export const DEFAULT_LOOK = 'realistic';

export function resolveLook(name) {
  return LOOK_PRESETS[name] ? name : DEFAULT_LOOK;
}

/**
 * Which layers are active for this run.
 * `?layers=` wins when present so a single layer can be isolated for comparison;
 * otherwise the look's own set applies.
 */
export function activeLayers(search = (typeof location === 'undefined' ? '' : location.search)) {
  const qs = new URLSearchParams(search);
  const explicit = qs.get('layers');
  if (explicit !== null) {
    const want = explicit.split(',').map(s => s.trim()).filter(Boolean);
    return new Set(want.filter(l => LAYERS.includes(l)));
  }
  return new Set(LOOK_PRESETS[resolveLook(qs.get('look'))].layers);
}

export function hasLayer(layer, search) {
  return activeLayers(search).has(layer);
}

/** Ambient lift and shadow softening for the light layer. */
export const LIGHT_STYLIZED = {
  // Painted art fills its shadows. A photographic frame lets them go to
  // occlusion; a hero-shooter frame keeps readable colour in there, which is
  // why characters stay legible against any backdrop.
  ambientMul: 1.55,
  // Ambient occlusion is the single strongest "this is a photograph" cue in the
  // shadowed corners. Halve rather than remove: at zero, geometry stops reading.
  aoMul: 0.45,
};

/**
 * Apply a look's material transform to one merged parameter set.
 * Returns the same object shape; unknown or absent keys are left alone so a
 * surface that does not use a channel is unaffected.
 */
export function applyLookToMat(p, lookName) {
  const look = LOOK_PRESETS[resolveLook(lookName)];
  const m = look?.mat;
  if (!m) return p;

  const out = { ...p };

  // detail: [octaves, gain, lacunarity, ...] — only the octave count moves.
  if (Array.isArray(out.detail) && out.detail.length) {
    const d = out.detail.slice();
    d[0] = Math.max(2, Math.round(d[0] * m.octaves));
    out.detail = d;
  }

  // roughness: [base, slope, variance] — flatten the variance, keep the base.
  if (Array.isArray(out.roughness) && out.roughness.length >= 3) {
    const r = out.roughness.slice();
    r[2] = r[2] * m.roughVar;
    out.roughness = r;
  }

  // weather / patch are amplitude vectors; scale them uniformly.
  for (const key of ['weather', 'patch']) {
    if (Array.isArray(out[key])) out[key] = out[key].map(v => v * m[key]);
  }

  // macro variation is what keeps a long wall from being one flat value. Halve
  // it rather than removing it: at zero the surface reads as untextured plastic.
  if (Array.isArray(out.macro)) out.macro = out.macro.map(v => v * 0.6);

  // Albedo lift, applied to the tint colours the bake multiplies through.
  if (m.albedo) {
    for (const key of ['wearColor', 'dustColor', 'grimeColor']) {
      if (typeof out[key] === 'number') out[key] = liftHex(out[key], m.albedo);
    }
  }

  return out;
}

function liftHex(hex, amount) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const up = c => Math.min(255, Math.round(c + (255 - c) * amount));
  return (up(r) << 16) | (up(g) << 8) | up(b);
}
