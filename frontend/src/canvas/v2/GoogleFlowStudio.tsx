'use client';

import React, { useState, useEffect, useRef } from 'react';

// Nhúng mã CSS tối ưu cho màng lỏng chuyển động bằng GPU Compositor
export const FluidGradientStyles = ({ speedModifier = 1 }) => (
  <style dangerouslySetInnerHTML={{__html: `
    @keyframes fluid-blob-1 {
      0%, 100% { transform: translate(0px, 0px) scale(1) rotate(0deg); }
      33% { transform: translate(12% , -10%) scale(1.15) rotate(120deg); }
      66% { transform: translate(-10%, 8%) scale(0.9) rotate(240deg); }
    }
    @keyframes fluid-blob-2 {
      0%, 100% { transform: translate(0px, 0px) scale(1.05) rotate(0deg); }
      50% { transform: translate(-15%, 12%) scale(0.85) rotate(-180deg); }
    }
    @keyframes fluid-blob-3 {
      0%, 100% { transform: translate(0px, 0px) scale(0.9) rotate(0deg); }
      40% { transform: translate(10%, 15%) scale(1.15) rotate(90deg); }
    }
    .animate-fluid-1 {
      animation: fluid-blob-1 ${18 / speedModifier}s ease-in-out infinite;
      will-change: transform;
    }
    .animate-fluid-2 {
      animation: fluid-blob-2 ${22 / speedModifier}s ease-in-out infinite;
      will-change: transform;
    }
    .animate-fluid-3 {
      animation: fluid-blob-3 ${16 / speedModifier}s ease-in-out infinite;
      will-change: transform;
    }
    @keyframes fadeIn {
      from { opacity: 1; filter: none; }
      to { opacity: 1; filter: none; }
    }
    .animate-flow-reveal {
      animation: fadeIn 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
  `}} />
);

// Canvas sao đêm tự lấp lánh không đồng pha, spotlight tự động lơ lửng tại tâm cực kỳ tiết kiệm tài nguyên
interface StarfieldProps {
  glowSize: number;
  glowColor: 'indigo' | 'emerald' | 'amber' | 'white';
  transformX?: number;
  transformY?: number;
  zoom?: number;
}

export const StarfieldCanvas: React.FC<StarfieldProps> = ({ 
  glowSize, 
  glowColor,
  transformX = 0,
  transformY = 0,
  zoom = 1
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const starsRef = useRef<any[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  
  // Use a mutable ref to store coordinates to prevent re-running useEffect at 60FPS
  const transformRef = useRef({ x: transformX, y: transformY, zoom });
  useEffect(() => {
    transformRef.current = { x: transformX, y: transformY, zoom };
  }, [transformX, transformY, zoom]);

  const initStars = (width: number, height: number) => {
    const spacing = 16; 
    const stars = [];
    const cols = Math.ceil(width / spacing);
    const rows = Math.ceil(height / spacing);

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x = c * spacing + spacing / 2;
        const y = r * spacing + spacing / 2;
        
        stars.push({
          x,
          y,
          baseOpacity: Math.random() * 0.75 + 0.05, 
          twinkleSpeed: Math.random() * 0.015 + 0.005, 
          phaseOffset: Math.random() * Math.PI * 2, 
          size: Math.random() * 0.7 + 0.5 
        });
      }
    }
    starsRef.current = stars;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const parent = canvas.parentElement;
    if (!parent || !ctx) return;
    
    const resizeCanvas = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = rect.width || 400;
      const height = rect.height || 440;
      
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      initStars(width, height);
    };

    resizeCanvas();
    const resizeTimeout = setTimeout(resizeCanvas, 60);
    window.addEventListener('resize', resizeCanvas);

    const getGlowColorRGB = () => {
      switch (glowColor) {
        case "emerald": return "16, 185, 129";
        case "amber": return "245, 158, 11";
        case "white": return "255, 255, 255";
        case "indigo":
        default:
          return "99, 102, 241";
      }
    };

    let time = 0;
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const rgb = getGlowColorRGB();
      const w = parent.clientWidth || 400;
      const h = parent.clientHeight || 440;
      
      // Quỹ đạo tự lơ lửng chậm rãi của Spotlight tại tâm
      const targetMouseX = w / 2 + Math.cos(time * 0.008) * 12;
      const targetMouseY = h / 2 + Math.sin(time * 0.006) * 12;

      const { x: tX, y: tY, zoom: z } = transformRef.current;

      starsRef.current.forEach(star => {
        const twinkleFactor = Math.sin(time * star.twinkleSpeed + star.phaseOffset);
        const normalizedTwinkle = 0.25 + 0.75 * ((twinkleFactor + 1) / 2);
        const dynamicStarOpacity = star.baseOpacity * normalizedTwinkle;

        // Apply pan (tX, tY) and wrap coordinates infinitely!
        let screenX = (star.x * z + tX) % w;
        if (screenX < 0) screenX += w;
        let screenY = (star.y * z + tY) % h;
        if (screenY < 0) screenY += h;

        // Distance from fixed screen-space spotlight
        const dist = Math.hypot(screenX - targetMouseX, screenY - targetMouseY);
        let spotlightIntensity = 0;

        if (dist < glowSize) {
          const ratio = 1 - (dist / glowSize);
          spotlightIntensity = Math.pow(ratio, 2.2); 
        }

        const finalOpacity = Math.min(1, dynamicStarOpacity * (0.12 + spotlightIntensity * 3.2));

        ctx.beginPath();
        // Scale star sizes matching zoom levels
        ctx.arc(screenX, screenY, star.size * Math.max(0.5, Math.min(z, 1.8)), 0, Math.PI * 2);
        
        if (spotlightIntensity > 0) {
          ctx.fillStyle = `rgba(${rgb}, ${finalOpacity})`;
        } else {
          ctx.fillStyle = `rgba(110, 115, 125, ${finalOpacity * 0.38})`;
        }
        ctx.fill();
      });

      time += 1;
      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', resizeCanvas);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [glowSize, glowColor]); 

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0" />;
};

// Component chính
export interface GoogleFlowLoadingProps {
  progress: number;
  size?: number;
  aspectRatio?: '1:1' | '16:9' | '4:5';
  speedModifier?: number;
  glowSize?: number;
  glowColor?: 'indigo' | 'emerald' | 'amber' | 'white';
  targetImageUrl?: string;
  viewMode?: 'genuine' | 'legacy';
}

export default function GoogleFlowLoading({
  progress,
  size = 340,
  aspectRatio = '1:1',
  speedModifier = 1,
  glowSize = 220,
  glowColor = 'indigo',
  targetImageUrl,
  viewMode = 'genuine'
}: GoogleFlowLoadingProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const getCardDimensions = (customSize = size) => {
    switch (aspectRatio) {
      case '16:9': return { width: customSize, height: Math.round(customSize * 9 / 16) };
      case '4:5': return { width: Math.round(customSize * 4 / 5), height: customSize };
      case '1:1':
      default: return { width: customSize, height: customSize };
    }
  };

  const renderCard = (customSize: number) => {
    const dim = getCardDimensions(customSize);
    return (
      <div 
        className="relative overflow-hidden rounded-[24px] border border-zinc-800/80 shadow-2xl transition-all duration-300 z-10 bg-zinc-950 flex flex-col"
        style={{ width: dim.width, height: dim.height }}
      >
        {progress < 100 ? (
          <div className="absolute inset-0 flex flex-col justify-between p-5 z-10 overflow-hidden">
            <div className="absolute inset-0 bg-[#16171a]" />
            
            {/* Màng lỏng chuyển động dập dềnh */}
            <div className="absolute inset-0 filter blur-[60px] mix-blend-screen opacity-[0.95]">
              <div className="absolute -bottom-[20%] -left-[15%] w-[75%] h-[75%] rounded-full bg-gradient-to-tr from-[#8a8c94] to-[#3a3c40] animate-fluid-1 opacity-80" />
              <div className="absolute -top-[15%] -right-[10%] w-[65%] h-[65%] rounded-full bg-[#404248] animate-fluid-2 opacity-60" />
              <div className="absolute top-[25%] left-[20%] w-[55%] h-[55%] rounded-full bg-[#242528] animate-fluid-3 opacity-50" />
            </div>

            <div className="absolute inset-0 bg-[radial-gradient(#27272a_0.6px,transparent_1px)] bg-[length:2.5px_2.5px] opacity-[0.22] pointer-events-none mix-blend-overlay" />
            <div className="absolute inset-0 bg-gradient-to-tr from-black/20 via-transparent to-black/10 pointer-events-none" />

            {/* Overlays tối giản góc trên */}
            <div className="flex items-start justify-between z-20 pointer-events-none">
              <div className="text-white/60 p-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-[18px] w-[18px] opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2.5" ry="2.5" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </div>

              <div className="text-white/60 font-sans text-xs font-semibold tracking-tight opacity-95">
                {Math.floor(progress)}%
              </div>
            </div>

            {viewMode === 'legacy' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center z-10 pointer-events-none animate-flow-reveal">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-zinc-900/45 border border-zinc-800/30 backdrop-blur-sm text-zinc-400 animate-spin">
                  <svg className="h-5 w-5 text-zinc-300" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-300">Generating</p>
                  <p className="text-[9px] text-zinc-500 font-mono mt-0.5">with Veo • Imagen 4</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Trạng thái hoàn thành */
          <div className="relative w-full h-full animate-flow-reveal">
            {targetImageUrl ? (
              <img src={targetImageUrl} alt="Finished Output" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-zinc-900 flex items-center justify-center text-xs text-zinc-600">No Target Image</div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent flex flex-col justify-end p-4">
              <div className="flex justify-between items-center bg-black/70 backdrop-blur-md p-2.5 rounded-xl border border-zinc-800/40">
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase font-bold text-emerald-400 tracking-wider">Processed</span>
                  <span className="text-[10px] text-zinc-300 font-medium truncate max-w-[140px]">Imagen Output</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 font-mono text-zinc-400">100%</span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="relative w-full flex flex-col items-center justify-center p-6 bg-[#0c0d10] rounded-[32px] overflow-hidden min-h-[460px]">
      <FluidGradientStyles speedModifier={speedModifier} />
      
      {/* Nền sao lấp lánh tự động tại tâm */}
      <StarfieldCanvas glowSize={glowSize} glowColor={glowColor} />

      {/* Nút phóng to lơ lửng góc trên bên phải */}
      <button 
        onClick={() => setIsFullscreen(true)}
        className="absolute top-4 right-4 px-3.5 py-1.5 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800/60 rounded-xl text-xs font-semibold backdrop-blur-md transition-all flex items-center gap-1.5 shadow-xl z-20"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
        Phóng To
      </button>

      {/* Render card ở trạng thái chuẩn */}
      {renderCard(size)}

      {/* --- MÀN HÌNH FULLSCREEN MODE --- */}
      {isFullscreen && (
        <div className="fixed inset-0 bg-[#060709] z-50 flex flex-col items-center justify-center p-6 animate-flow-reveal overflow-hidden select-none">
          <StarfieldCanvas glowSize={glowSize * 1.5} glowColor={glowColor} />
          
          <button 
            onClick={() => setIsFullscreen(false)}
            className="absolute top-6 right-6 px-4 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800/80 rounded-xl text-xs font-semibold backdrop-blur-md transition-all flex items-center gap-2 z-50 shadow-xl"
          >
            Thoát Phóng To
          </button>

          <div className="relative z-10">
            {/* Phóng to card 1.25 lần trên màn hình Fullscreen */}
            {renderCard(Math.round(size * 1.25))}
          </div>
        </div>
      )}
    </div>
  );
}
