import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  DataTexture,
  FloatType,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LineSegments,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import type { VelocityField } from "./field";
import { createFieldTexture } from "./field";
import { advectFragmentShader, fullscreenVertexShader, trailFragmentShader, trailVertexShader } from "./shaders";

export type SpatialFieldProps = {
  field: VelocityField;
  particleCount?: number;
  paused?: boolean;
  reducedMotion?: boolean;
  onFrame?: (milliseconds: number) => void;
};

function makeTarget(size: number) {
  const target = new WebGLRenderTarget(size, size, {
    format: RGBAFormat,
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.generateMipmaps = false;
  return target;
}

function makeInitialPositions(size: number, seed = 0x6b657374) {
  const values = new Float32Array(size * size * 4);
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < size * size; i++) {
    values[i * 4] = random();
    values[i * 4 + 1] = random();
    values[i * 4 + 2] = random();
    values[i * 4 + 3] = random() * 8;
  }
  const texture = new DataTexture(values, size, size, RGBAFormat, FloatType);
  texture.needsUpdate = true;
  return texture;
}

export function SpatialField({ field, particleCount = 65_536, paused = false, reducedMotion = false, onFrame }: SpatialFieldProps) {
  const { gl } = useThree();
  const lines = useRef<LineSegments>(null);
  const accumulator = useRef(0);
  const resources = useMemo(() => {
    const count = Math.max(1, Math.floor(particleCount));
    const stateSize = Math.ceil(Math.sqrt(count));
    const velocityTexture = createFieldTexture(field);
    const initialPositions = makeInitialPositions(stateSize);
    const targets = [makeTarget(stateSize), makeTarget(stateSize)] as const;
    const simulationScene = new Scene();
    const simulationCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const simulationGeometry = new PlaneGeometry(2, 2);
    const fieldSize = new Vector3(
      Math.max(field.cellSizeEastingM * (field.columns - 1), 1),
      Math.max(field.cellSizeNorthingM * (field.rows - 1), 1),
      Math.max(field.topElevationM, 1),
    );
    const simulationMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertexShader,
      fragmentShader: advectFragmentShader,
      uniforms: {
        positions: { value: initialPositions },
        velocityField: { value: velocityTexture },
        deltaTime: { value: 0 },
        elapsedTime: { value: 0 },
        velocityScale: { value: field.velocityScaleMs },
        fieldSize: { value: fieldSize },
        stateSize: { value: new Vector2(stateSize, stateSize) },
        seed: { value: 0.618 },
      },
    });
    simulationScene.add(new Mesh(simulationGeometry, simulationMaterial));

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0]), 3));
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uvs[i * 2] = ((i % stateSize) + 0.5) / stateSize;
      uvs[i * 2 + 1] = (Math.floor(i / stateSize) + 0.5) / stateSize;
    }
    geometry.setAttribute("particleUv", new InstancedBufferAttribute(uvs, 2));
    geometry.instanceCount = count;
    const material = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: trailVertexShader,
      fragmentShader: trailFragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        currentPositions: { value: initialPositions },
        previousPositions: { value: initialPositions },
        velocityField: { value: velocityTexture },
        velocityScale: { value: field.velocityScaleMs },
        fieldSize: { value: fieldSize },
      },
    });
    return { velocityTexture, initialPositions, targets, simulationScene, simulationCamera, simulationGeometry, simulationMaterial, geometry, material, readIndex: 0 as 0 | 1, initialized: false };
  }, [field, particleCount]);

  useEffect(() => () => {
    resources.velocityTexture.dispose();
    resources.initialPositions.dispose();
    resources.targets.forEach((target) => target.dispose());
    resources.simulationGeometry.dispose();
    resources.simulationMaterial.dispose();
    resources.geometry.dispose();
    resources.material.dispose();
  }, [resources]);

  useFrame((state, frameDelta) => {
    if (paused) return;
    const started = performance.now();
    const delta = Math.min(frameDelta, 1 / 30);
    const fixedStep = 1 / 90;
    accumulator.current = Math.min(accumulator.current + delta, fixedStep * 3);
    const steps = reducedMotion ? 0 : Math.floor(accumulator.current / fixedStep);
    for (let step = 0; step < steps; step++) {
      const writeIndex: 0 | 1 = resources.readIndex === 0 ? 1 : 0;
      const previous = resources.initialized ? resources.targets[resources.readIndex].texture : resources.initialPositions;
      resources.simulationMaterial.uniforms.positions!.value = previous;
      resources.simulationMaterial.uniforms.deltaTime!.value = fixedStep;
      resources.simulationMaterial.uniforms.elapsedTime!.value = state.clock.elapsedTime;
      gl.setRenderTarget(resources.targets[writeIndex]);
      gl.render(resources.simulationScene, resources.simulationCamera);
      gl.setRenderTarget(null);
      resources.material.uniforms.previousPositions!.value = previous;
      resources.material.uniforms.currentPositions!.value = resources.targets[writeIndex].texture;
      resources.readIndex = writeIndex;
      resources.initialized = true;
      accumulator.current -= fixedStep;
    }
    if (reducedMotion) {
      resources.material.uniforms.currentPositions!.value = resources.initialPositions;
      resources.material.uniforms.previousPositions!.value = resources.initialPositions;
    }
    onFrame?.(performance.now() - started);
  });

  return <lineSegments ref={lines} geometry={resources.geometry} material={resources.material} frustumCulled={false} />;
}
