"use client";

import React, { useEffect, useState } from "react";
import { TextScramble } from "./text-scramble/text-scramble";

const TITLE = "The collection";

export function ResolvedTitle() {
  const [motionEnabled, setMotionEnabled] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotionEnabled(!preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  return (
    <h1 id="hero-title" className="resolved-title">
      <span className="sr">{TITLE}</span>
      <span className="resolved-title-slot" aria-hidden="true">
        <span className="resolved-title-measure">{TITLE}</span>
        {motionEnabled ? (
          <TextScramble
            duration={0.7}
            scrambleFps={30}
            playOnMount={true}
            playOnHover={true}
            render={<span className="resolved-title-visual" />}
          >
            {TITLE}
          </TextScramble>
        ) : (
          <span className="resolved-title-visual">{TITLE}</span>
        )}
      </span>
    </h1>
  );
}
