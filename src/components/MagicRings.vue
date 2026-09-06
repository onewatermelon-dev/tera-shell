<script setup lang="ts">
/**
 * 启动加载动画：同心光环 + 辉光效果（React Bits MagicRings 的 Vue 移植版）。
 *
 * 用 Three.js 全屏四边形渲染圆形着色器，光环从内向外扩散并循环淡入淡出。
 * 挂在应用启动加载层中，主界面就绪后由父组件淡出销毁。
 */
import * as THREE from "three";

const props = withDefaults(
  defineProps<{
    color?: string;
    colorTwo?: string;
    ringCount?: number;
    speed?: number;
    attenuation?: number;
    lineThickness?: number;
    baseRadius?: number;
    radiusStep?: number;
    scaleRate?: number;
    opacity?: number;
    blur?: number;
    noiseAmount?: number;
    rotation?: number;
    ringGap?: number;
    fadeIn?: number;
    fadeOut?: number;
    followMouse?: boolean;
    mouseInfluence?: number;
    hoverScale?: number;
    parallax?: number;
    clickBurst?: boolean;
    alphaMode?: "luminance" | "coverage";
  }>(),
  {
    color: "#fc42ff",
    colorTwo: "#42fcff",
    ringCount: 6,
    speed: 1,
    attenuation: 10,
    lineThickness: 2,
    baseRadius: 0.35,
    radiusStep: 0.1,
    scaleRate: 0.1,
    opacity: 1,
    blur: 0,
    noiseAmount: 0.1,
    rotation: 0,
    ringGap: 1.5,
    fadeIn: 0.7,
    fadeOut: 0.5,
    followMouse: false,
    mouseInfluence: 0.2,
    hoverScale: 1.2,
    parallax: 0.05,
    clickBurst: false,
    alphaMode: "luminance"
  }
);

const vertexShader = `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime, uAttenuation, uLineThickness;
uniform float uBaseRadius, uRadiusStep, uScaleRate;
uniform float uOpacity, uNoiseAmount, uRotation, uRingGap;
uniform float uFadeIn, uFadeOut;
uniform float uMouseInfluence, uHoverAmount, uHoverScale, uParallax, uBurst;
uniform float uCoverageAlpha;
uniform vec2 uResolution, uMouse;
uniform vec3 uColor, uColorTwo;
uniform int uRingCount;

const float HP = 1.5707963;
const float CYCLE = 3.45;

float fade(float t) {
  return t < uFadeIn ? smoothstep(0.0, uFadeIn, t) : 1.0 - smoothstep(uFadeOut, CYCLE - 0.2, t);
}

float ring(vec2 p, float ri, float cut, float t0, float px) {
  float t = mod(uTime + t0, CYCLE);
  float r = ri + t / CYCLE * uScaleRate;
  float d = abs(length(p) - r);
  float a = atan(abs(p.y), abs(p.x)) / HP;
  float th = max(1.0 - a, 0.5) * px * uLineThickness;
  float h = (1.0 - smoothstep(th, th * 1.5, d)) + 1.0;
  d += pow(cut * a, 3.0) * r;
  return h * exp(-uAttenuation * d) * fade(t);
}

void main() {
  float px = 1.0 / min(uResolution.x, uResolution.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution.xy) * px;
  float cr = cos(uRotation), sr = sin(uRotation);
  p = mat2(cr, -sr, sr, cr) * p;
  p -= uMouse * uMouseInfluence;
  float sc = mix(1.0, uHoverScale, uHoverAmount) + uBurst * 0.3;
  p /= sc;
  vec3 c = vec3(0.0);
  float coverage = 0.0;
  float rcf = max(float(uRingCount) - 1.0, 1.0);
  for (int i = 0; i < 10; i++) {
    if (i >= uRingCount) break;
    float fi = float(i);
    vec2 pr = p - fi * uParallax * uMouse;
    vec3 rc = mix(uColor, uColorTwo, fi / rcf);
    float ringAmount = ring(pr, uBaseRadius + fi * uRadiusStep, pow(uRingGap, fi), i == 0 ? 0.0 : 2.95 * fi, px);
    c = mix(c, rc, vec3(ringAmount));
    coverage = max(coverage, ringAmount);
  }
  c *= 1.0 + uBurst * 2.0;
  float n = fract(sin(dot(gl_FragCoord.xy + uTime * 100.0, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) * uNoiseAmount;
  float intensity = max(c.r, max(c.g, c.b));
  vec3 emissiveColor = intensity > 0.0001 ? clamp(c / intensity, 0.0, 1.0) : vec3(0.0);
  vec3 outputColor = mix(emissiveColor, clamp(c, 0.0, 1.0), uCoverageAlpha);
  float outputAlpha = mix(intensity, coverage, uCoverageAlpha);
  gl_FragColor = vec4(outputColor, clamp(outputAlpha * uOpacity, 0.0, 1.0));
}
`;

const mountRef = ref<HTMLDivElement>();

// 只在 WebGL2 可用时启用动画，否则加载层退化为纯色背景，保证启动不白屏。
let renderer: THREE.WebGLRenderer | undefined;
let material: THREE.ShaderMaterial | undefined;

onMounted(() => {
  const mount = mountRef.value;
  if (!mount) return;

  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true
    });
  } catch {
    return;
  }
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    renderer = undefined;
    return;
  }

  renderer.setClearColor(0x000000, 0);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(
    -0.5,
    0.5,
    0.5,
    -0.5,
    0.1,
    10
  );
  camera.position.z = 1;

  const uniforms = {
    uTime: { value: 0 },
    uAttenuation: { value: 0 },
    uResolution: { value: new THREE.Vector2() },
    uColor: { value: new THREE.Color() },
    uColorTwo: { value: new THREE.Color() },
    uLineThickness: { value: 0 },
    uBaseRadius: { value: 0 },
    uRadiusStep: { value: 0 },
    uScaleRate: { value: 0 },
    uRingCount: { value: 0 },
    uOpacity: { value: 1 },
    uNoiseAmount: { value: 0 },
    uRotation: { value: 0 },
    uRingGap: { value: 1.6 },
    uFadeIn: { value: 0.5 },
    uFadeOut: { value: 0.75 },
    uMouse: { value: new THREE.Vector2() },
    uMouseInfluence: { value: 0 },
    uHoverAmount: { value: 0 },
    uHoverScale: { value: 1 },
    uParallax: { value: 0 },
    uBurst: { value: 0 },
    uCoverageAlpha: { value: 0 }
  };

  material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true
  });
  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    material
  );
  scene.add(quad);

  const resize = () => {
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    const dpr = Math.min(
      window.devicePixelRatio,
      2
    );
    renderer?.setSize(w, h);
    renderer?.setPixelRatio(dpr);
    uniforms.uResolution.value.set(
      w * dpr,
      h * dpr
    );
  };
  resize();
  window.addEventListener("resize", resize);

  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  // 鼠标跟随对启动动画没有实际用途，但保留以与原始组件行为一致。
  const mouse = { x: 0, y: 0 };
  const smoothMouse = { x: 0, y: 0 };
  const onMouseMove = (event: MouseEvent) => {
    const rect = mount.getBoundingClientRect();
    mouse.x =
      (event.clientX - rect.left) / rect.width -
      0.5;
    mouse.y = -(
      (event.clientY - rect.top) / rect.height -
      0.5
    );
  };
  const onMouseLeave = () => {
    mouse.x = 0;
    mouse.y = 0;
  };
  mount.addEventListener(
    "mousemove",
    onMouseMove
  );
  mount.addEventListener(
    "mouseleave",
    onMouseLeave
  );

  let frameId = 0;
  let elapsed = 0;
  let lastT = 0;
  let isVisible = false;
  let isPageVisible = !document.hidden;

  const animate = (t: number) => {
    frameId = requestAnimationFrame(animate);
    const dt =
      lastT === 0 ? 0 : Math.min(t - lastT, 100);
    lastT = t;
    elapsed += dt * 0.001 * props.speed;

    smoothMouse.x +=
      (mouse.x - smoothMouse.x) * 0.08;
    smoothMouse.y +=
      (mouse.y - smoothMouse.y) * 0.08;

    uniforms.uTime.value = elapsed;
    uniforms.uAttenuation.value =
      props.attenuation;
    uniforms.uColor.value.set(props.color);
    uniforms.uColorTwo.value.set(props.colorTwo);
    uniforms.uLineThickness.value =
      props.lineThickness;
    uniforms.uBaseRadius.value = props.baseRadius;
    uniforms.uRadiusStep.value = props.radiusStep;
    uniforms.uScaleRate.value = props.scaleRate;
    uniforms.uRingCount.value = props.ringCount;
    uniforms.uOpacity.value = props.opacity;
    uniforms.uNoiseAmount.value =
      props.noiseAmount;
    uniforms.uRotation.value =
      (props.rotation * Math.PI) / 180;
    uniforms.uRingGap.value = props.ringGap;
    uniforms.uFadeIn.value = props.fadeIn;
    uniforms.uFadeOut.value = props.fadeOut;
    uniforms.uMouse.value.set(
      smoothMouse.x,
      smoothMouse.y
    );
    uniforms.uMouseInfluence.value =
      props.followMouse
        ? props.mouseInfluence
        : 0;
    uniforms.uHoverAmount.value = 0;
    uniforms.uHoverScale.value = props.hoverScale;
    uniforms.uParallax.value = props.parallax;
    uniforms.uBurst.value = 0;
    uniforms.uCoverageAlpha.value =
      props.alphaMode === "coverage" ? 1 : 0;

    renderer?.render(scene, camera);
  };

  const tryStart = () => {
    if (
      isVisible &&
      isPageVisible &&
      frameId === 0
    ) {
      lastT = 0;
      frameId = requestAnimationFrame(animate);
    }
  };
  const tryStop = () => {
    if (frameId !== 0) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  };

  const io = new IntersectionObserver(
    entries => {
      const entry = entries[0];
      isVisible = entry?.isIntersecting ?? false;
      isVisible ? tryStart() : tryStop();
    },
    { threshold: 0 }
  );
  io.observe(mount);

  const onVisibility = () => {
    isPageVisible = !document.hidden;
    isPageVisible ? tryStart() : tryStop();
  };
  document.addEventListener(
    "visibilitychange",
    onVisibility
  );

  tryStart();

  onBeforeUnmount(() => {
    tryStop();
    io.disconnect();
    document.removeEventListener(
      "visibilitychange",
      onVisibility
    );
    window.removeEventListener("resize", resize);
    ro.disconnect();
    mount.removeEventListener(
      "mousemove",
      onMouseMove
    );
    mount.removeEventListener(
      "mouseleave",
      onMouseLeave
    );
    renderer?.domElement.remove();
    renderer?.dispose();
    material?.dispose();
  });
});
</script>

<template>
  <div
    ref="mountRef"
    class="magic-rings"
    :style="
      blur > 0
        ? { filter: `blur(${blur}px)` }
        : undefined
    "
  ></div>
</template>

<style scoped>
.magic-rings {
  width: 100%;
  height: 100%;
}
</style>
