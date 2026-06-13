/**
 * motion.tsx — Premium Framer Motion animation presets for Flowboard app shell.
 *
 * Usage:
 *   import { FadeIn, ScaleIn, StaggerChildren, StaggerItem, SlideFromLeft } from "@/ui/motion";
 *
 *   <FadeIn><YourContent /></FadeIn>
 *   <StaggerChildren><StaggerItem>…</StaggerItem></StaggerChildren>
 *
 * IMPORTANT: These are for the APP SHELL only (Spaces, dialogs, sidebar panels).
 * Canvas nodes follow canvas-v2-design-rules.md — do NOT use these inside node components.
 */
import { motion, type Variants, type HTMLMotionProps } from "framer-motion";
import { type ReactNode } from "react";

// ── Shared spring config ─────────────────────────────────────────────────────
const SPRING_SNAPPY = { type: "spring", stiffness: 400, damping: 32 } as const;
const SPRING_SMOOTH = { type: "spring", stiffness: 280, damping: 28 } as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// ── FadeIn ────────────────────────────────────────────────────────────────────
const fadeInVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_OUT } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.15, ease: "easeIn" } },
};

interface MotionDivProps extends HTMLMotionProps<"div"> {
  children: ReactNode;
  delay?: number;
}

export function FadeIn({ children, delay = 0, ...props }: MotionDivProps) {
  return (
    <motion.div
      variants={fadeInVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ delay }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ── ScaleIn ───────────────────────────────────────────────────────────────────
// Used for dialogs, modals, dropdowns — appears from center.
const scaleInVariants: Variants = {
  hidden: { opacity: 0, scale: 0.94, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { ...SPRING_SNAPPY, opacity: { duration: 0.18 } },
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: 4,
    transition: { duration: 0.15, ease: "easeIn" },
  },
};

export function ScaleIn({ children, delay = 0, ...props }: MotionDivProps) {
  return (
    <motion.div
      variants={scaleInVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ delay }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ── SlideFromLeft ─────────────────────────────────────────────────────────────
// Used for sidebar panels, drawers.
const slideFromLeftVariants: Variants = {
  hidden: { opacity: 0, x: -18 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { ...SPRING_SMOOTH, opacity: { duration: 0.2 } },
  },
  exit: { opacity: 0, x: -12, transition: { duration: 0.18, ease: "easeIn" } },
};

export function SlideFromLeft({ children, delay = 0, ...props }: MotionDivProps) {
  return (
    <motion.div
      variants={slideFromLeftVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ delay }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ── StaggerChildren ───────────────────────────────────────────────────────────
// Container that staggers its children's animations.
// Wrap with <StaggerChildren> and give each child <StaggerItem>.

const staggerContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.05,
    },
  },
};

const staggerItemVariants: Variants = {
  hidden: { opacity: 0, y: 10, scale: 0.98 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...SPRING_SNAPPY, opacity: { duration: 0.2 } },
  },
};

interface StaggerChildrenProps extends HTMLMotionProps<"div"> {
  children: ReactNode;
}

export function StaggerChildren({ children, ...props }: StaggerChildrenProps) {
  return (
    <motion.div
      variants={staggerContainerVariants}
      initial="hidden"
      animate="visible"
      {...props}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, ...props }: MotionDivProps) {
  return (
    <motion.div variants={staggerItemVariants} {...props}>
      {children}
    </motion.div>
  );
}

// ── PageTransition ────────────────────────────────────────────────────────────
// Wraps a full page/view — used with AnimatePresence for route-like switches.
const pageVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.18, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.12, ease: "easeIn" } },
};

export function PageTransition({ children, ...props }: MotionDivProps) {
  return (
    <motion.div
      variants={pageVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      style={{ width: "100%", height: "100%" }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

// ── Hover Lift ────────────────────────────────────────────────────────────────
// Thin wrapper for cards that should lift on hover.
export function HoverLift({ children, ...props }: MotionDivProps) {
  return (
    <motion.div
      whileHover={{ y: -2, transition: { duration: 0.15 } }}
      whileTap={{ scale: 0.98, transition: { duration: 0.1 } }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
