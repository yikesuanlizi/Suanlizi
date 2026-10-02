import { useEffect, useRef } from 'react';

type IdleTheme = 'light' | 'dark';
type Vector = { x: number; y: number; z: number };
type Particle = Vector & { target: Vector; phase: number };

const COUNT = 100;
const LINE_DIST_SQ = 10000;
const MORPH_MIN_MS = 10000;
const MORPH_RANGE_MS = 15000;

/** A faithful, dependency-free rendering of docs/previews/code.html. */
export function ConversationIdleAnimation({ theme }: { theme: IdleTheme }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef(false);
  const dragPointRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let frame = 0;
    let morphTimer: number | undefined;
    let elapsed = 0;
    let previousTime = performance.now();
    let rotationY = 0;
    let rotationX = 0;
    let shrinking = false;
    let shrinkScale = 1;
    let shrinkOpacity = 1;
    let shrinkRestoreTimer: number | undefined;
    let pointerMoved = false;
    const particles: Particle[] = Array.from({ length: COUNT }, (_, index) => {
      const position = getSpherePosition();
      return { ...position, target: position, phase: index * 0.6180339887 + Math.random() * 0.4 };
    });

    const palette = theme === 'dark'
      ? { bg: '#0d1117', particle: '#58a6ff', line: '#58a6ff', opacity: 0.6, composite: 'lighter' as GlobalCompositeOperation }
      : { bg: '#f6f8fa', particle: '#0969da', line: '#0969da', opacity: 0.4, composite: 'source-over' as GlobalCompositeOperation };
    const glow = document.createElement('canvas');
    glow.width = 64;
    glow.height = 64;
    const glowContext = glow.getContext('2d');
    if (!glowContext) return undefined;
    const glowColor = hexRgb(palette.particle);
    const gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, `rgba(${glowColor.join(',')},1)`);
    gradient.addColorStop(0.2, `rgba(${glowColor.join(',')},0.8)`);
    gradient.addColorStop(0.5, `rgba(${glowColor.join(',')},0.2)`);
    gradient.addColorStop(1, `rgba(${glowColor.join(',')},0)`);
    glowContext.fillStyle = gradient;
    glowContext.fillRect(0, 0, 64, 64);

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const scheduleMorph = () => {
      morphTimer = window.setTimeout(() => {
        for (const particle of particles) particle.target = getRandomShapePosition();
        scheduleMorph();
      }, MORPH_MIN_MS + Math.random() * MORPH_RANGE_MS);
    };
    scheduleMorph();

    const render = (now: number) => {
      const delta = Math.min(48, now - previousTime);
      previousTime = now;
      elapsed += delta * 0.01;
      if (shrinking) {
        shrinkScale += (0.035 - shrinkScale) * 0.14;
        shrinkOpacity *= 0.91;
        rotationY += 0.006 * delta;
      } else {
        shrinkScale += (1 - shrinkScale) * 0.12;
        shrinkOpacity += (1 - shrinkOpacity) * 0.12;
        if (!draggingRef.current) rotationY += 0.001 * delta;
      }

      context.globalCompositeOperation = 'source-over';
      context.fillStyle = palette.bg;
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = palette.composite;

      const projected = particles.map((particle) => {
        particle.x += (particle.target.x - particle.x) * 0.02;
        particle.y += (particle.target.y - particle.y) * 0.02;
        particle.z += (particle.target.z - particle.z) * 0.02;
        const yRotatedX = particle.x * Math.cos(rotationY) - particle.z * Math.sin(rotationY);
        const yRotatedZ = particle.x * Math.sin(rotationY) + particle.z * Math.cos(rotationY);
        const xRotatedY = particle.y * Math.cos(rotationX) - yRotatedZ * Math.sin(rotationX);
        const depth = particle.y * Math.sin(rotationX) + yRotatedZ * Math.cos(rotationX);
        const cameraDistance = 500 + depth;
        const perspective = Math.max(0.2, Math.min(2, 500 / cameraDistance));
        const focalLength = 0.866 * Math.min(width, height);
        return {
          x: width / 2 + yRotatedX * focalLength / cameraDistance * shrinkScale,
          y: height / 2 + xRotatedY * focalLength / cameraDistance * shrinkScale,
          z: depth,
          scale: perspective,
        };
      });

      context.lineWidth = 1;
      for (let index = 0; index < COUNT; index += 1) {
        for (let other = index + 1; other < COUNT; other += 1) {
          const first3d = particles[index];
          const second3d = particles[other];
          const dx = first3d.x - second3d.x;
          const dy = first3d.y - second3d.y;
          const dz = first3d.z - second3d.z;
          if (dx * dx + dy * dy + dz * dz >= LINE_DIST_SQ) continue;
          const first = projected[index];
          const second = projected[other];
          const distance = Math.hypot(first.x - second.x, first.y - second.y);
          const alpha = Math.max(0.02, 0.2 * (1 - Math.min(distance / Math.max(width, height), 1)) * shrinkOpacity);
          context.strokeStyle = withAlpha(palette.line, alpha);
          context.beginPath();
          context.moveTo(first.x, first.y);
          context.lineTo(second.x, second.y);
          context.stroke();
        }
      }

      for (let index = 0; index < COUNT; index += 1) {
        const point = projected[index];
        const particle = particles[index];
        const pulse = 0.92 + Math.sin(elapsed * 1.5 + particle.phase) * 0.08;
        const size = 20 * point.scale * pulse * shrinkScale;
        const alpha = palette.opacity * Math.max(0.22, Math.min(1, point.scale)) * shrinkOpacity;
        context.globalAlpha = alpha;
        context.drawImage(glow, point.x - size / 2, point.y - size / 2, size, size);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'source-over';
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    const onPointerDown = (event: PointerEvent) => {
      draggingRef.current = true;
      pointerMoved = false;
      dragPointRef.current = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!draggingRef.current) return;
      const deltaX = event.clientX - dragPointRef.current.x;
      const deltaY = event.clientY - dragPointRef.current.y;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 3) pointerMoved = true;
      rotationY += deltaX * 0.003;
      rotationX += deltaY * 0.003;
      dragPointRef.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = () => {
      draggingRef.current = false;
      if (!pointerMoved && !shrinking) {
        shrinking = true;
        if (shrinkRestoreTimer !== undefined) window.clearTimeout(shrinkRestoreTimer);
        shrinkRestoreTimer = window.setTimeout(() => {
          shrinking = false;
          shrinkRestoreTimer = undefined;
        }, 900);
      }
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    return () => {
      cancelAnimationFrame(frame);
      if (morphTimer !== undefined) window.clearTimeout(morphTimer);
      if (shrinkRestoreTimer !== undefined) window.clearTimeout(shrinkRestoreTimer);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [theme]);

  return (
    <div className="conversationIdleAnimation" aria-label={theme === 'light' ? 'Suanlizi 空闲状态' : 'Suanlizi idle state'}>
      <canvas ref={canvasRef} className="conversationIdleAnimationCanvas" />
      <div className="conversationIdleCopy" aria-hidden="true">
        <strong>Suanlizi</strong>
        <span>等待新的对话</span>
      </div>
    </div>
  );
}

function getSpherePosition(): Vector {
  const radius = 200 + Math.random() * 100;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  return {
    x: radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.sin(phi) * Math.sin(theta),
    z: radius * Math.cos(phi),
  };
}

function getTorusPosition(): Vector {
  const torusRadius = 200;
  const tubeRadius = 60;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.random() * Math.PI * 2;
  const x = (torusRadius + tubeRadius * Math.cos(phi)) * Math.cos(theta);
  const y = (torusRadius + tubeRadius * Math.cos(phi)) * Math.sin(theta);
  const z = tubeRadius * Math.sin(phi);
  return { x, y: z, z: y };
}

function getGalaxyPosition(): Vector {
  const radius = 80 + Math.random() * 200;
  const spinAngle = radius * 0.5;
  const armOffset = (Math.floor(Math.random() * 2) / 2) * Math.PI * 2;
  return {
    x: Math.cos(spinAngle + armOffset) * radius + (Math.random() - 0.5) * 30,
    y: (Math.random() - 0.5) * 30,
    z: Math.sin(spinAngle + armOffset) * radius + (Math.random() - 0.5) * 30,
  };
}

function getRandomShapePosition(): Vector {
  const value = Math.random();
  if (value < 0.4) return getSpherePosition();
  if (value < 0.7) return getTorusPosition();
  return getGalaxyPosition();
}

function withAlpha(hex: string, alpha: number): string {
  return `rgba(${hexRgb(hex).join(', ')}, ${alpha})`;
}

function hexRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}
