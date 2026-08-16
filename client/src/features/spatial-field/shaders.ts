export const fullscreenVertexShader = /* glsl */ `
  void main() { gl_Position = vec4(position, 1.0); }
`;

export const advectFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D positions;
  uniform sampler3D velocityField;
  uniform float deltaTime;
  uniform float elapsedTime;
  uniform float velocityScale;
  uniform vec3 fieldSize;
  uniform vec2 stateSize;
  uniform float seed;
  out vec4 nextPosition;

  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  vec3 respawn(float id, float cycle) {
    return vec3(hash(vec3(id, cycle, seed)), hash(vec3(id + 17.0, cycle, seed)), hash(vec3(id + 43.0, cycle, seed)));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / stateSize;
    vec4 state = texture(positions, uv);
    vec3 velocity = (texture(velocityField, clamp(state.xyz, 0.0, 1.0)).rgb * 2.0 - 1.0) * velocityScale;
    vec3 position = state.xyz + velocity * deltaTime / fieldSize;
    float age = state.a + deltaTime;
    float life = 4.0 + hash(vec3(gl_FragCoord.xy, seed)) * 8.0;
    bool outside = any(lessThan(position, vec3(0.0))) || any(greaterThan(position, vec3(1.0)));
    if (outside || age > life) {
      float id = gl_FragCoord.x + gl_FragCoord.y * stateSize.x;
      position = respawn(id, floor(elapsedTime / max(life, 0.001)));
      age = 0.0;
    }
    nextPosition = vec4(position, age);
  }
`;

/**
 * Speed reaches the screen three ways: hue, trail length, and now population.
 *
 * `densityFloor` is the fraction of particles still drawn where the flow has stopped. Each
 * particle holds one fixed lottery number for its lifetime and is drawn only while the local
 * speed buys it in, so a wake core is visibly *emptier* than the free stream and not merely
 * a different colour. `P4-PROJECT-BIBLE.md` §5 requires this — "speed maps to colour **and**
 * particle density, so the data survives monochrome vision" — and persona Rowan is the only
 * persona driving it, which is exactly the kind of row that gets cut.
 *
 * The threshold is crossed through a smoothstep rather than as a step, because a fixed
 * lottery with a hard cutoff makes particles blink in and out as they drift across a speed
 * contour, and blinking is the one thing a reduced-motion setting cannot fix.
 *
 * ## Why the response is cubic
 *
 * Because the data does not use the bottom of the scale. `speedHint` is speed over
 * `velocityScale`, and `velocityScale` is the KFLD quantization scale, so a histogram of the
 * demonstration volume (32 x 32 x 8, scale 11.75 m/s) puts **47% of cells at 1.0 or above and
 * 99% above 0.5** — the wakes live between 0.6 and 0.9 and nothing at all lives below it.
 *
 * A linear ramp therefore spends almost its whole range on values the field never takes, and
 * separates a deep wake from the free stream by about 24% of particle density. The cubic
 * spends its range where the data is and separates them by about 52%, which is the difference
 * between an encoding a colourblind user can read and one they cannot.
 *
 * It stays monotonic in absolute speed, so "faster is denser" remains true — this is a choice
 * of response curve, the same choice picking a colour scale's domain makes, not a different
 * variable.
 *
 * ⚠️ The same histogram says the **colour** encoding saturates over half the volume, since
 * viridis is driven by the same clamped `speedHint`. That is a property of the KFLD scale
 * rather than of this shader, and changing it means changing the volume format and both
 * persistent caches. Recorded rather than fixed here.
 */
export const trailVertexShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  #define DENSITY_GAMMA 3.0
  uniform sampler2D currentPositions;
  uniform sampler2D previousPositions;
  uniform sampler3D velocityField;
  uniform float velocityScale;
  uniform float densityFloor;
  uniform vec3 fieldSize;
  in vec2 particleUv;
  out float speedHint;
  out float trailFade;
  out float densityFade;

  float lottery(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    vec3 current = texture(currentPositions, particleUv).xyz;
    vec3 previous = texture(previousPositions, particleUv).xyz;
    vec3 velocity = (texture(velocityField, clamp(current, 0.0, 1.0)).rgb * 2.0 - 1.0) * velocityScale;
    vec3 tail = clamp(current - velocity * 1.5 / fieldSize, 0.0, 1.0);
    if (length(current - previous) > 0.05) tail = current;
    vec3 normalizedPosition = mix(tail, current, position.x);
    vec3 world = (normalizedPosition - 0.5) * fieldSize;
    world.y = (normalizedPosition.z - 0.1) * fieldSize.z;
    world.z = (normalizedPosition.y - 0.5) * fieldSize.y;
    speedHint = clamp(length(velocity) / max(velocityScale, 0.001), 0.0, 1.0);
    trailFade = position.x;
    float admitted = mix(densityFloor, 1.0, pow(speedHint, DENSITY_GAMMA));
    densityFade = smoothstep(0.0, 0.12, admitted - lottery(particleUv));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

export const trailFragmentShader = /* glsl */ `
  precision highp float;
  in float speedHint;
  in float trailFade;
  in float densityFade;
  out vec4 color;

  vec3 viridis(float t) {
    vec3 c0 = vec3(0.267, 0.005, 0.329);
    vec3 c1 = vec3(0.128, 0.567, 0.551);
    vec3 c2 = vec3(0.741, 0.873, 0.150);
    return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, (t - 0.5) * 2.0);
  }

  void main() {
    float alpha = mix(0.08, 0.8, trailFade) * densityFade;
    if (alpha < 0.004) discard;
    color = vec4(viridis(speedHint), alpha);
  }
`;
