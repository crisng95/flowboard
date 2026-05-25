import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Camera, Check, Image, Layers, Palette, Search, Sparkles, Upload, User, WandSparkles, X, PersonStanding } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CHARACTER_GENDERS,
  CHARACTER_COUNTRIES,
  CHARACTER_VIBES,
  type GenderKey,
  type CountryKey,
  type VibeKey,
} from "../../../constants/character";
import type { CharacterConfig } from "./buildCharacterPrompt";

export type { CharacterConfig } from "./buildCharacterPrompt";

export interface ReferencePreset {
  key: string;
  title: string;
  hint: string;
  tag: "Trained" | "Prompt";
  thumbnail: string;
  prompt: string;
  refType: string;
  category: ReferenceCategoryKey;
}

export type ReferenceCategoryKey =
  | "style"
  | "character"
  | "pose"
  | "element"
  | "structure"
  | "effects"
  | "camera"
  | "color_palette";

const CATEGORIES: Array<{ key: ReferenceCategoryKey; label: string; icon: typeof Sparkles }> = [
  { key: "style", label: "Style", icon: Sparkles },
  { key: "character", label: "Character", icon: User },
  { key: "pose", label: "Pose", icon: PersonStanding },
  { key: "element", label: "Element", icon: WandSparkles },
  { key: "structure", label: "Structure", icon: Layers },
  { key: "effects", label: "Effects", icon: Box },
  { key: "camera", label: "Camera", icon: Camera },
  { key: "color_palette", label: "Color palette", icon: Palette },
];

export function referenceCategoryLabel(key: string | undefined): string {
  return CATEGORIES.find((category) => category.key === key)?.label ?? "Style";
}

const PRESETS: ReferencePreset[] = [
  {
    key: "photo",
    title: "#photo",
    hint: "Photographic realism with natural lens response",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=520&auto=format&fit=crop&q=82",
    prompt: "Photographic reference style, natural lens response, realistic skin and material detail, soft studio light",
    refType: "photo",
    category: "style",
  },
  {
    key: "fantasyanime",
    title: "#fantasyanime",
    hint: "Painted fantasy anime scenery and key-art color",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=520&auto=format&fit=crop&q=82",
    prompt: "Hand-painted fantasy anime style, saturated skies, dreamy color script, crisp character key-art finish",
    refType: "style",
    category: "style",
  },
  {
    key: "editorial",
    title: "#editorial",
    hint: "Polished editorial image language",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?w=520&auto=format&fit=crop&q=82",
    prompt: "High-end editorial art direction, crisp composition, premium lighting, refined contemporary color grading",
    refType: "style",
    category: "style",
  },
  {
    key: "illustration",
    title: "#illustration",
    hint: "Flat illustration with clean shapes",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=520&auto=format&fit=crop&q=82",
    prompt: "Clean editorial illustration style, flattened shapes, refined color blocks, sharp design silhouettes",
    refType: "style",
    category: "style",
  },
  {
    key: "minimaltypo",
    title: "#minimaltypo",
    hint: "Minimal design-forward typography mood",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=520&auto=format&fit=crop&q=82",
    prompt: "Minimal design-forward visual language, restrained layout, editorial typography feeling, quiet premium finish",
    refType: "style",
    category: "style",
  },
  {
    key: "risoprint",
    title: "#risoprint",
    hint: "Halftone grain and layered ink",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?w=520&auto=format&fit=crop&q=82",
    prompt: "Riso print style, layered ink colors, offset registration, halftone grain, poster-like graphic simplicity",
    refType: "style",
    category: "style",
  },
  {
    key: "character3d",
    title: "#character3d",
    hint: "Stylized 3D character finish",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1618172193763-c511deb635ca?w=520&auto=format&fit=crop&q=82",
    prompt: "Stylized 3D character reference, clean PBR surfaces, readable silhouette, soft toy-like material finish",
    refType: "3d_render",
    category: "character",
  },
  {
    key: "classic_anime",
    title: "#classicanime",
    hint: "Classic cel anime reference",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=520&auto=format&fit=crop&q=82",
    prompt: "Classic anime character reference, cel-shaded linework, expressive face, clean color regions, crisp rim light",
    refType: "style",
    category: "character",
  },
  {
    key: "pose_reference",
    title: "#pose",
    hint: "Pose and body mechanics guide",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=520&auto=format&fit=crop&q=82",
    prompt: "Pose reference, clear skeletal body mechanics, readable silhouette, full-body framing, neutral background",
    refType: "pose",
    category: "pose",
  },
  {
    key: "vitro",
    title: "#vitro",
    hint: "Glossy glass material and red refraction",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1579547944212-c4f4961a8dd8?w=520&auto=format&fit=crop&q=82",
    prompt: "Glossy vitreous glass material, translucent red refraction, polished specular highlights, sculptural surface",
    refType: "texture",
    category: "element",
  },
  {
    key: "product_glass",
    title: "#gtproduct",
    hint: "Product material lighting",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1544145945-f90425340c7e?w=520&auto=format&fit=crop&q=82",
    prompt: "Premium product material reference, glossy liquid surfaces, controlled studio highlights, crisp commercial finish",
    refType: "texture",
    category: "element",
  },
  {
    key: "aged_leather",
    title: "#agedleather",
    hint: "Cracked leather surface",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1587080266227-677cd237c267?w=520&auto=format&fit=crop&q=82",
    prompt: "Aged leather material, cracked full-grain surface, matte worn finish, organic wrinkles and edge wear",
    refType: "texture",
    category: "element",
  },
  {
    key: "blueprint",
    title: "#blueprint",
    hint: "Technical orthographic guide",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=520&auto=format&fit=crop&q=82",
    prompt: "Technical blueprint reference, orthographic construction lines, grid alignment, precise structural annotations",
    refType: "blueprint",
    category: "structure",
  },
  {
    key: "linocut_noir",
    title: "#linocutnoir",
    hint: "Bold black ink structure",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1605721911519-3dfeb3be25e7?w=520&auto=format&fit=crop&q=82",
    prompt: "Noir linocut reference, bold structural ink cuts, high contrast linework, handmade print texture",
    refType: "sketch",
    category: "structure",
  },
  {
    key: "historical",
    title: "#historical",
    hint: "Historic armor and silhouette language",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1599930113854-d6d7fd521f10?w=520&auto=format&fit=crop&q=82",
    prompt: "Historical structure reference, period-accurate armor silhouette, grounded construction details, authentic proportions",
    refType: "sketch",
    category: "structure",
  },
  {
    key: "action_pose",
    title: "#actionpose",
    hint: "Dynamic runner active pose template",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=520&auto=format&fit=crop&q=82",
    prompt: "Dynamic character action pose, athletic runner sprinting pose template, side-view bipedal skeleton wireframe, high contrast motion silhouette, solid grey backdrop",
    refType: "pose",
    category: "pose",
  },
  {
    key: "studio_portrait",
    title: "#studio-portrait",
    hint: "Editorial studio portrait pose posture",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1507679799987-c73779587ccf?w=520&auto=format&fit=crop&q=82",
    prompt: "Classic editorial portrait pose, female fashion model studio portrait posture, bipedal skeletal anchor, clean high-fashion visual outline, minimalist light grey studio backdrop",
    refType: "pose",
    category: "pose",
  },
  {
    key: "mecha_pose",
    title: "#mecha-a-pose",
    hint: "Futuristic robotic bipedal A-pose sheet",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=520&auto=format&fit=crop&q=82",
    prompt: "Hard-surface armor A-pose guide, futuristic mecha robot bipedal skeletal pose template, symmetrical mechanical joint lines, neutral technical backdrop",
    refType: "pose",
    category: "pose",
  },
  {
    key: "hero_lowangle",
    title: "#heroview",
    hint: "Cinematic low-angle hero silhouette",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=520&auto=format&fit=crop&q=82",
    prompt: "Dramatic low-angle hero pose silhouette, bipedal skeletal layout guide, cinematic perspective outline, powerful dynamic framing, solid dark grey backdrop",
    refType: "pose",
    category: "pose",
  },
  {
    key: "sparkling",
    title: "#sparkling",
    hint: "Iridescent sparkle and glow",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1614851099511-773084f6911d?w=520&auto=format&fit=crop&q=82",
    prompt: "Iridescent sparkling effect reference, pearlescent highlights, soft glow, luminous micro glitter and translucent finish",
    refType: "mood",
    category: "effects",
  },
  {
    key: "popsurrealism",
    title: "#popsurrealism",
    hint: "Bright surreal atmosphere",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=520&auto=format&fit=crop&q=82",
    prompt: "Pop surreal atmosphere, saturated dreamlike color, playful geometry, soft impossible lighting, polished fantasy finish",
    refType: "mood",
    category: "effects",
  },
  {
    key: "lowkeycinema",
    title: "#lowkeycinema",
    hint: "Deep shadow cinematic lighting",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=520&auto=format&fit=crop&q=82",
    prompt: "Low-key cinematic lighting, deep shadow falloff, controlled rim light, moody contrast, filmic black levels",
    refType: "lighting",
    category: "camera",
  },
  {
    key: "fashioninfluencer",
    title: "#fashioninfluen",
    hint: "Street camera editorial angle",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=520&auto=format&fit=crop&q=82",
    prompt: "Street editorial camera reference, candid lens feel, natural perspective, fashion-forward framing and lifestyle composition",
    refType: "photo",
    category: "camera",
  },
  {
    key: "teal_orange",
    title: "#tealorange",
    hint: "Cinematic teal-orange palette",
    tag: "Prompt",
    thumbnail: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=520&auto=format&fit=crop&q=82",
    prompt: "Cinematic teal and orange color palette, warm skin highlights, cool shadow balance, polished graded contrast",
    refType: "mood",
    category: "color_palette",
  },
  {
    key: "vividcrayon",
    title: "#vividcrayon",
    hint: "Highly saturated playful color",
    tag: "Trained",
    thumbnail: "https://images.unsplash.com/photo-1541701494587-cb58502866ab?w=520&auto=format&fit=crop&q=82",
    prompt: "Vivid crayon color palette, saturated playful hues, rough handmade texture, bright graphic contrast",
    refType: "mood",
    category: "color_palette",
  },
];

interface ReferenceLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (presets: ReferencePreset[]) => void;
  onUploadCustom?: () => void;
  onGenerateCharacter?: (config: CharacterConfig) => void;
  initialCategory?: ReferenceCategoryKey;
}

export function ReferenceLibraryModal({
  isOpen,
  onClose,
  onSelect,
  onUploadCustom,
  onGenerateCharacter,
  initialCategory = "style",
}: ReferenceLibraryModalProps) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<ReferenceCategoryKey>(initialCategory);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // Character builder state
  const [charGender, setCharGender] = useState<GenderKey | null>(null);
  const [charCountry, setCharCountry] = useState<CountryKey | null>(null);
  const [charVibe, setCharVibe] = useState<VibeKey>("clean");
  const [charExtras, setCharExtras] = useState("");
  const isCharacterTab = activeCategory === "character";
  const canGenChar = charGender !== null || charCountry !== null || charExtras.trim().length > 0;

  useEffect(() => {
    if (!isOpen) return;
    setActiveCategory(initialCategory);
    setSelectedKeys([]);
    setSearch("");
    // Reset character builder
    setCharGender(null);
    setCharCountry(null);
    setCharVibe("clean");
    setCharExtras("");
  }, [initialCategory, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const filteredPresets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return PRESETS.filter((preset) => {
      const matchesCategory = preset.category === activeCategory;
      const matchesSearch =
        !q ||
        preset.title.toLowerCase().includes(q) ||
        preset.hint.toLowerCase().includes(q) ||
        preset.prompt.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [activeCategory, search]);

  const selectedPresets = selectedKeys
    .map((key) => PRESETS.find((preset) => preset.key === key))
    .filter((preset): preset is ReferencePreset => Boolean(preset));

  function togglePreset(key: string) {
    setSelectedKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  function removePreset(key: string) {
    setSelectedKeys((current) => current.filter((item) => item !== key));
  }

  if (!isOpen) return null;

  const modal = (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/75 p-4 font-sans backdrop-blur-md nodrag nowheel"
        onWheel={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <motion.button
          type="button"
          aria-label="Close references"
          onClick={onClose}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="fixed right-5 top-5 z-[100000] flex size-10 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.08] text-white/80 shadow-2xl transition-colors hover:bg-white/[0.14] hover:text-white"
        >
          <X size={20} strokeWidth={1.75} />
        </motion.button>

        <motion.div
          initial={{ opacity: 0, scale: 0.985, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.985, y: 12 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="relative grid h-[86vh] w-[92vw] max-w-[1800px] grid-cols-[240px_minmax(0,1fr)_264px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#1d1d1d] shadow-[0_40px_120px_rgba(0,0,0,0.65)]"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <aside className="border-r border-white/[0.06] bg-[#191919] p-4">
            <div className="px-2 pb-3 pt-5 text-[11px] font-semibold text-white/35">
              All references
            </div>
            <div className="flex flex-col gap-1.5">
              {CATEGORIES.map((category) => {
                const Icon = category.icon;
                const active = activeCategory === category.key;
                return (
                  <button
                    key={category.key}
                    type="button"
                    onClick={() => {
                      setActiveCategory(category.key);
                    }}
                    className={[
                      "flex h-9 items-center gap-2 rounded-lg px-3 text-left text-xs font-semibold transition-colors",
                      active
                        ? "bg-white/[0.14] text-white"
                        : "text-white/70 hover:bg-white/[0.08] hover:text-white",
                    ].join(" ")}
                  >
                    <Icon size={14} strokeWidth={1.75} />
                    {category.label}
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="flex min-w-0 flex-col bg-[#202020]">
            <div className="flex items-center justify-center border-b border-white/[0.04] px-6 py-6">
              <div className="relative h-10 w-full max-w-[780px] rounded-lg border border-white/[0.08] bg-white/[0.06] px-4">
                <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-white/45" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search for styles"
                  className="h-full w-full bg-transparent pl-8 pr-8 text-sm text-white outline-none placeholder:text-white/45"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/45 transition-colors hover:text-white"
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between px-6 pb-4 pt-6">
              <h3 className="text-base font-semibold text-white">
                {CATEGORIES.find((c) => c.key === activeCategory)?.label}
              </h3>
              <button
                type="button"
                onClick={() => {
                  onUploadCustom?.();
                  onClose();
                }}
                className="flex h-8 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold text-black transition-transform active:scale-95"
              >
                <Upload size={14} strokeWidth={2} />
                Upload custom
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 nowheel img-gen-prompt">
              {/* ── Character Builder (only on Character tab) ── */}
              {isCharacterTab && (
                <div className="mb-8">
                  <div
                    className="rounded-xl border border-white/[0.08] p-5"
                    style={{ backgroundColor: "#1a1a1a" }}
                  >
                    <h4 className="mb-4 text-sm font-semibold text-white/90">
                      ✨ Character Builder
                    </h4>

                    {/* Gender */}
                    <div className="mb-4">
                      <span className="mb-2 block text-xs font-medium text-white/50">Gender</span>
                      <div className="flex flex-wrap gap-2">
                        {CHARACTER_GENDERS.map((g) => (
                          <button
                            key={g.key}
                            type="button"
                            onClick={() => setCharGender(charGender === g.key ? null : g.key)}
                            className={[
                              "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
                              charGender === g.key
                                ? "border-[#5574ff] bg-[#5574ff]/20 text-white"
                                : "border-white/[0.08] bg-white/[0.04] text-white/70 hover:border-white/[0.15] hover:text-white",
                            ].join(" ")}
                          >
                            {g.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Country */}
                    <div className="mb-4">
                      <span className="mb-2 block text-xs font-medium text-white/50">Quốc gia</span>
                      <div className="flex flex-wrap gap-2">
                        {CHARACTER_COUNTRIES.map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            onClick={() => setCharCountry(charCountry === c.key ? null : c.key)}
                            className={[
                              "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
                              charCountry === c.key
                                ? "border-[#5574ff] bg-[#5574ff]/20 text-white"
                                : "border-white/[0.08] bg-white/[0.04] text-white/70 hover:border-white/[0.15] hover:text-white",
                            ].join(" ")}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Vibe */}
                    <div className="mb-4">
                      <span className="mb-2 block text-xs font-medium text-white/50">Vibe</span>
                      <div className="flex flex-wrap gap-2">
                        {CHARACTER_VIBES.map((v) => (
                          <button
                            key={v.key}
                            type="button"
                            onClick={() => setCharVibe(v.key)}
                            className={[
                              "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all",
                              charVibe === v.key
                                ? "border-[#5574ff] bg-[#5574ff]/20 text-white"
                                : "border-white/[0.08] bg-white/[0.04] text-white/70 hover:border-white/[0.15] hover:text-white",
                            ].join(" ")}
                          >
                            {v.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Extras */}
                    <div className="mb-5">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-white/50">Mô tả thêm (tuỳ chọn)</span>
                        <span className="text-[10px] text-white/30">{charExtras.length}/200</span>
                      </div>
                      <textarea
                        value={charExtras}
                        onChange={(e) => setCharExtras(e.target.value)}
                        maxLength={200}
                        rows={2}
                        placeholder="Tuổi, kiểu tóc, trang phục, biểu cảm…"
                        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/[0.15] transition-colors resize-none"
                      />
                    </div>

                    {/* Generate button */}
                    <button
                      type="button"
                      disabled={!canGenChar}
                      onClick={() => {
                        if (!canGenChar) return;
                        onGenerateCharacter?.({
                          gender: charGender,
                          country: charCountry,
                          vibe: charVibe,
                          extras: charExtras,
                        });
                        onClose();
                      }}
                      className={[
                        "flex h-10 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold transition-all",
                        canGenChar
                          ? "bg-[#566cff] text-white hover:bg-[#667aff] active:scale-[0.98]"
                          : "cursor-not-allowed bg-white/[0.06] text-white/30",
                      ].join(" ")}
                    >
                      <Sparkles size={14} strokeWidth={2} />
                      Generate Character
                    </button>

                    <p className="mt-3 text-[10px] leading-relaxed text-white/35">
                      Auto-build prompt: portrait headshot · vibe styling · photorealistic — tối ưu cho character reference.
                    </p>
                  </div>

                  {/* Divider */}
                  <div className="mt-8 flex items-center gap-4">
                    <span className="h-px flex-1 bg-white/[0.06]" />
                    <span className="text-[10px] font-medium text-white/30">hoặc chọn preset</span>
                    <span className="h-px flex-1 bg-white/[0.06]" />
                  </div>
                </div>
              )}

              {/* ── Preset grid ── */}
              {filteredPresets.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-6 gap-y-8">
                  {filteredPresets.map((preset) => {
                    const active = selectedKeys.includes(preset.key);
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => togglePreset(preset.key)}
                        className="group min-w-0 text-left"
                      >
                        <span
                          className={[
                            "relative block aspect-square overflow-hidden rounded-lg border bg-[#2a2a2a] transition-all",
                            active
                              ? "border-[#5574ff] ring-2 ring-[#5574ff]/75"
                              : "border-white/[0.06] group-hover:border-white/[0.18]",
                          ].join(" ")}
                        >
                          <img
                            src={preset.thumbnail}
                            alt={preset.title}
                            loading="lazy"
                            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.035]"
                          />
                          {active && (
                            <span className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-[#7667ff] text-white shadow-lg">
                              <Check size={14} strokeWidth={3} />
                            </span>
                          )}
                          <span
                            className={[
                              "absolute left-2 top-2 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none text-white shadow",
                              preset.tag === "Prompt" ? "bg-sky-500/85" : "bg-violet-500/85",
                            ].join(" ")}
                          >
                            {preset.tag}
                          </span>
                        </span>
                        <span className="mt-2 block truncate text-xs font-medium text-white/90">
                          {preset.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 text-white/35">
                  <Image size={34} strokeWidth={1.4} />
                  <span className="text-sm">No references match your search</span>
                </div>
              )}
            </div>
          </main>

          <aside className="flex min-h-0 flex-col border-l border-white/[0.08] bg-[#151515] p-4">
            <div className="mb-4 text-sm font-semibold text-white/82">{selectedPresets.length} selected</div>
            {selectedPresets.length > 0 ? (
              <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-3 overflow-y-auto pr-1 nowheel img-gen-prompt">
                {selectedPresets.map((preset) => (
                  <div key={preset.key} className="group relative">
                    <div className="aspect-square overflow-hidden rounded-lg border border-white/[0.08] bg-[#242424]">
                      <img src={preset.thumbnail} alt={preset.title} className="size-full object-cover" />
                    </div>
                    <button
                      type="button"
                      onClick={() => removePreset(preset.key)}
                      className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-black/60 text-white/75 opacity-0 backdrop-blur-sm transition-opacity hover:text-white group-hover:opacity-100"
                      aria-label={`Remove ${preset.title}`}
                    >
                      <X size={12} strokeWidth={2.2} />
                    </button>
                    <div className="mt-1.5 truncate text-[11px] font-medium text-white/70">{preset.title}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.03] text-center text-white/35">
                <Image size={30} strokeWidth={1.4} />
                <span className="max-w-[160px] text-xs leading-relaxed">Choose one or more references</span>
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setSelectedKeys([])}
                className="h-10 flex-1 rounded-lg bg-white/[0.08] text-xs font-semibold text-white/80 transition-colors hover:bg-white/[0.12] hover:text-white"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={() => {
                  if (selectedPresets.length === 0) return;
                  onSelect(selectedPresets);
                  onClose();
                }}
                disabled={selectedPresets.length === 0}
                className="h-10 flex-1 rounded-lg bg-[#566cff] text-xs font-semibold text-white transition-colors hover:bg-[#667aff] disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-white/30"
              >
                Add
              </button>
            </div>
          </aside>
        </motion.div>
      </div>
    </AnimatePresence>
  );

  return createPortal(modal, document.body);
}
