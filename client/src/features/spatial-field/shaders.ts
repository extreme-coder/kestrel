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

export const trailVertexShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  uniform sampler2D currentPositions;
  uniform sampler2D previousPositions;
  uniform sampler3D velocityField;
  uniform float velocityScale;
  uniform vec3 fieldSize;
  in vec2 particleUv;
  out float speedHint;
  out float trailFade;

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
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

export const trailFragmentShader = /* glsl */ `
  precision highp float;
  in float speedHint;
  in float trailFade;
  out vec4 color;

  vec3 viridis(float t) {
    vec3 c0 = vec3(0.267, 0.005, 0.329);
    vec3 c1 = vec3(0.128, 0.567, 0.551);
    vec3 c2 = vec3(0.741, 0.873, 0.150);
    return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, (t - 0.5) * 2.0);
  }

  void main() { color = vec4(viridis(speedHint), mix(0.08, 0.8, trailFade)); }
`;
