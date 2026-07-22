import { useEffect, useRef } from 'react';

const MAX_DEVICE_PIXEL_RATIO = 2;
const MAX_PARTICLES = 120;
const CONNECTION_DISTANCE = 110;

export default function EffectsBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: -1000, y: -1000, targetX: -1000, targetY: -1000, radius: 180 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    let animationFrameId: number | null = null;
    let resizeFrameId: number | null = null;
    let width = window.innerWidth;
    let height = window.innerHeight;
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let prefersReducedMotion = reducedMotionQuery.matches;

    class Particle {
      x: number;
      y: number;
      baseX: number;
      baseY: number;
      readonly vx: number;
      readonly vy: number;
      readonly size: number;
      readonly density: number;

      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
        this.baseX = x;
        this.baseY = y;
        this.vx = (Math.random() - 0.5) * 0.4;
        this.vy = (Math.random() - 0.5) * 0.4;
        this.size = Math.random() * 1.5 + 0.5;
        this.density = Math.random() * 30 + 10;
      }

      update(pointerX: number, pointerY: number, pointerRadius: number) {
        this.baseX += this.vx;
        this.baseY += this.vy;

        if (this.baseX < 0) this.baseX = width;
        if (this.baseX > width) this.baseX = 0;
        if (this.baseY < 0) this.baseY = height;
        if (this.baseY > height) this.baseY = 0;

        const dx = pointerX - this.baseX;
        const dy = pointerY - this.baseY;
        const distanceSquared = dx * dx + dy * dy;
        const radiusSquared = pointerRadius * pointerRadius;
        let targetX = this.baseX;
        let targetY = this.baseY;

        // Coincident coordinates have no direction; skipping that frame avoids NaN propagation.
        if (distanceSquared > Number.EPSILON && distanceSquared < radiusSquared) {
          const distance = Math.sqrt(distanceSquared);
          const force = (pointerRadius - distance) / pointerRadius;
          targetX = this.baseX - (dx / distance) * force * this.density;
          targetY = this.baseY - (dy / distance) * force * this.density;
        }

        this.x += (targetX - this.x) * 0.1;
        this.y += (targetY - this.y) * 0.1;
      }

      draw(drawingContext: CanvasRenderingContext2D) {
        drawingContext.beginPath();
        drawingContext.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        drawingContext.fill();
      }
    }

    let particles: Particle[] = [];

    const initializeParticles = () => {
      const particleCount = Math.min(Math.floor((width * height) / 11000), MAX_PARTICLES);
      particles = Array.from(
        { length: particleCount },
        () => new Particle(Math.random() * width, Math.random() * height),
      );
    };

    const sizeCanvas = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);

      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      initializeParticles();
    };

    const drawScene = (advance: boolean) => {
      context.clearRect(0, 0, width, height);

      const pointer = pointerRef.current;
      if (advance) {
        pointer.x += (pointer.targetX - pointer.x) * 0.1;
        pointer.y += (pointer.targetY - pointer.y) * 0.1;
      }

      if (pointer.x > -500 && !prefersReducedMotion) {
        const gradient = context.createRadialGradient(
          pointer.x,
          pointer.y,
          10,
          pointer.x,
          pointer.y,
          pointer.radius * 1.5,
        );
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.05)');
        gradient.addColorStop(0.5, 'rgba(168, 85, 247, 0.02)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(pointer.x, pointer.y, pointer.radius * 1.5, 0, Math.PI * 2);
        context.fill();
      }

      context.fillStyle = 'rgba(255, 255, 255, 0.18)';
      for (const particle of particles) {
        if (advance) particle.update(pointer.x, pointer.y, pointer.radius);
        particle.draw(context);
      }

      const maxDistanceSquared = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
      context.lineWidth = 0.5;
      for (let index = 0; index < particles.length; index += 1) {
        for (let targetIndex = index + 1; targetIndex < particles.length; targetIndex += 1) {
          const source = particles[index];
          const target = particles[targetIndex];
          const dx = source.x - target.x;
          const dy = source.y - target.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= maxDistanceSquared) continue;

          const opacity = (1 - Math.sqrt(distanceSquared) / CONNECTION_DISTANCE) * 0.12;
          context.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
          context.beginPath();
          context.moveTo(source.x, source.y);
          context.lineTo(target.x, target.y);
          context.stroke();
        }
      }
    };

    const stopAnimation = () => {
      if (animationFrameId === null) return;
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    };

    const render = () => {
      animationFrameId = null;
      if (document.visibilityState !== 'visible' || prefersReducedMotion) return;
      drawScene(true);
      animationFrameId = requestAnimationFrame(render);
    };

    const startAnimation = () => {
      if (animationFrameId !== null || document.visibilityState !== 'visible' || prefersReducedMotion) return;
      animationFrameId = requestAnimationFrame(render);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointerRef.current.targetX = event.clientX;
      pointerRef.current.targetY = event.clientY;
    };

    const resetPointer = () => {
      pointerRef.current.targetX = -1000;
      pointerRef.current.targetY = -1000;
    };

    const handleResize = () => {
      if (resizeFrameId !== null) return;
      resizeFrameId = requestAnimationFrame(() => {
        resizeFrameId = null;
        sizeCanvas();
        drawScene(false);
        startAnimation();
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (prefersReducedMotion) drawScene(false);
        else startAnimation();
      } else {
        stopAnimation();
      }
    };

    const handleReducedMotionChange = (event: MediaQueryListEvent) => {
      prefersReducedMotion = event.matches;
      if (prefersReducedMotion) {
        stopAnimation();
        resetPointer();
        drawScene(false);
      } else {
        startAnimation();
      }
    };

    sizeCanvas();
    drawScene(false);
    startAnimation();

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerleave', resetPointer);
    window.addEventListener('blur', resetPointer);
    window.addEventListener('resize', handleResize, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    reducedMotionQuery.addEventListener('change', handleReducedMotionChange);

    return () => {
      stopAnimation();
      if (resizeFrameId !== null) cancelAnimationFrame(resizeFrameId);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerleave', resetPointer);
      window.removeEventListener('blur', resetPointer);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      id="effects-background-canvas"
      aria-hidden="true"
      className="fixed inset-0 z-0 h-full w-full pointer-events-none"
      style={{ mixBlendMode: 'screen' }}
    />
  );
}
