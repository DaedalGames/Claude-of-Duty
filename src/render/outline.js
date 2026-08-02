import * as THREE from 'three';
import { Pass } from './pass.js';

/**
 * Ink outline pass — the shading half of the stylised look.
 *
 * The grade, material, light and fx layers all change how the frame is coloured.
 * None of them draw a line, and a line is the single most recognisable thing
 * about a hero-shooter frame. This adds one.
 *
 * Method: edge-detect the gbuffer the renderer already produces, rather than
 * re-drawing the world inflated along its normals. An inverted-hull outline
 * costs a second draw of every mesh; this costs one full-screen pass reading two
 * textures that steps 4-5 already wrote. It also gets interior edges (a window
 * frame against a wall) that a hull silhouette cannot express at all.
 *
 * Two detectors, because either alone misses a case a viewer notices:
 *   depth  — catches silhouettes against anything further away. Blind to a fold
 *            in a surface that does not change distance.
 *   normal — catches creases where the surface turns. Blind to two parallel
 *            planes at different depths, which is exactly a doorway.
 *
 * Depth is compared as a *relative* difference. An absolute threshold draws
 * every distant surface as solid black, because at 80 m one texel of slope
 * exceeds any constant you pick that still catches a near edge.
 *
 * Runs before the tone map, so the darkening is applied in linear light and AgX
 * then rolls it off with everything else. That keeps the line from reading as a
 * sticker pasted on top of the image.
 */
const OUTLINE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tColor;
uniform sampler2D tDepth;    // R32F linear view depth, metres, positive
uniform sampler2D tNormal;   // RGBA16F, xy = oct-encoded view normal, z = coverage
uniform vec2  uTexel;
uniform float uThickness;    // outline width, in texels
uniform float uDepthEdge;    // relative depth difference that counts as an edge
uniform float uNormalEdge;   // 1 - dot() that counts as a crease
uniform float uStrength;     // how dark the line goes (1 = black)
uniform float uMaxDist;      // metres past which outlines fade out
uniform float uContrast;     // exponent that crushes weak responses to zero

vec3 octDecode(vec2 f) {
  f = f * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.xy += vec2(n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t);
  return normalize(n);
}

float depthAt(vec2 uv) { return texture2D(tDepth, uv).r; }
vec3  normalAt(vec2 uv) { return octDecode(texture2D(tNormal, uv).xy); }

void main() {
  vec3 color = texture2D(tColor, vUv).rgb;
  float d0 = depthAt(vUv);

  // Sky and anything past the fade distance keep their silhouette from the
  // world behind them, not from a line drawn around the horizon.
  if (d0 <= 0.0 || d0 > uMaxDist) { gl_FragColor = vec4(color, 1.0); return; }

  vec2 o = uTexel * uThickness;
  vec2 uvL = vUv - vec2(o.x, 0.0), uvR = vUv + vec2(o.x, 0.0);
  vec2 uvD = vUv - vec2(0.0, o.y), uvU = vUv + vec2(0.0, o.y);

  vec3 n0 = normalAt(vUv);

  // Depth: relative, so the threshold means the same thing near and far.
  float dL = depthAt(uvL), dR = depthAt(uvR), dD = depthAt(uvD), dU = depthAt(uvU);
  float dDiff = (abs(d0 - dL) + abs(d0 - dR) + abs(d0 - dD) + abs(d0 - dU)) / d0;

  // Slope compensation. A surface seen edge-on changes depth fast across a texel
  // without there being an edge there at all, so a flat threshold paints a haze
  // over every grazing wall and road — measured as 92% of the frame tinted when
  // only 12% of it was line. Scale the threshold by how oblique the surface is,
  // so the test asks "is this a discontinuity" instead of "is this steep".
  // n0.z is the view-space normal toward the camera: 1 head-on, 0 edge-on.
  float ndv = max(abs(n0.z), 0.08);
  float depthThresh = uDepthEdge / ndv;
  float depthEdge = smoothstep(depthThresh, depthThresh * 1.6, dDiff);

  // Normal: sum of angular deviation across the cross.
  float nDiff = (1.0 - dot(n0, normalAt(uvL))) + (1.0 - dot(n0, normalAt(uvR)))
              + (1.0 - dot(n0, normalAt(uvD))) + (1.0 - dot(n0, normalAt(uvU)));
  float normalEdge = smoothstep(uNormalEdge, uNormalEdge * 2.0, nDiff);

  // Crush the tail. smoothstep returns something above zero for any input past
  // its lower bound, and on a textured surface almost every texel clears the
  // bound by a little: measured, 90% of the frame picked up a faint wash while
  // only 12% was actually line. A line is close to binary, so raise the response
  // to a power — small responses collapse to nothing, real edges stay.
  float rawEdge = max(depthEdge, normalEdge);

  // Distance ramp, applied to the edge itself rather than to the final multiply.
  // Relative depth difference grows with distance, so past ~40 m the detector
  // reports the whole far field as edge: the raw map is a solid white blob out
  // there. Fading only the final darkening leaves that blob as a broad wash over
  // most of the frame. Folding the ramp in before the crush kills it instead.
  float fade = 1.0 - smoothstep(uMaxDist * 0.45, uMaxDist, d0);

  // Crush the tail. smoothstep returns something above zero for any input past
  // its lower bound, and a line should be close to binary: small responses need
  // to collapse to nothing while real edges survive.
  float edge = pow(rawEdge * fade, uContrast);

  gl_FragColor = vec4(color * (1.0 - edge * uStrength), 1.0);
}
`;

export const OUTLINE_DEFAULTS = {
  thickness: 1.15,
  depthEdge: 0.035,
  normalEdge: 0.55,
  strength: 0.85,
  maxDist: 55,
  contrast: 2.2,
};

export function createOutlinePass(opts = {}) {
  const o = { ...OUTLINE_DEFAULTS, ...opts };
  const pass = new Pass('ow-outline', OUTLINE_FRAG, {
    tColor: { value: null },
    tDepth: { value: null },
    tNormal: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uThickness: { value: o.thickness },
    uDepthEdge: { value: o.depthEdge },
    uNormalEdge: { value: o.normalEdge },
    uStrength: { value: o.strength },
    uMaxDist: { value: o.maxDist },
    uContrast: { value: o.contrast },
  });

  // Late enough to sit on the resolved world, before the tone map.
  pass.order = 90;

  pass.render = (renderer, inTex, outTarget, r) => {
    const u = pass.uniforms;
    u.tColor.value = inTex;
    u.tDepth.value = r.depthTexture;
    u.tNormal.value = r.normalTexture;
    // Without both gbuffer targets there is nothing to detect an edge from, so
    // pass the frame through untouched rather than drawing garbage.
    if (!u.tDepth.value || !u.tNormal.value) {
      u.uStrength.value = 0;
    } else {
      u.uStrength.value = o.strength;
    }
    u.uTexel.value.set(1 / r.screenSize.width, 1 / r.screenSize.height);
    Pass.prototype.render.call(pass, renderer, outTarget, false);
  };

  pass.resize = (w, h) => pass.uniforms.uTexel.value.set(1 / w, 1 / h);
  return pass;
}
