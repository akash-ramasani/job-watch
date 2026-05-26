import React, { useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * Wraps any clickable element with a "magnetic" cursor-tracking spring effect.
 * The wrapped element subtly follows the cursor when hovered, releasing back
 * to centre on mouse leave.  Pair with the global springy hover CSS in
 * index.css to get the full hero-CTA feel on any button.
 *
 * Usage:
 *   <MagneticButton>
 *     <button className="...">Click me</button>
 *   </MagneticButton>
 */
export default function MagneticButton({ children, className = "", strength = 0.15 }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleMouse = (e) => {
    if (!ref.current) return;
    const { clientX, clientY } = e;
    const { height, width, left, top } = ref.current.getBoundingClientRect();
    const middleX = clientX - (left + width / 2);
    const middleY = clientY - (top + height / 2);
    setPosition({ x: middleX * strength, y: middleY * strength });
  };

  const reset = () => setPosition({ x: 0, y: 0 });

  return (
    <motion.div
      ref={ref}
      onMouseMove={handleMouse}
      onMouseLeave={reset}
      animate={{ x: position.x, y: position.y }}
      transition={{ type: "spring", stiffness: 150, damping: 15, mass: 0.1 }}
      className={`inline-block ${className}`}
    >
      {children}
    </motion.div>
  );
}
