import React from "react";

const LINES = ["Pieces, linked", "on the bench."] as const;

export function ResolvedTitle() {
  let characterOffset = 0;

  return (
    <h1 id="hero-title" className="resolved-title">
      <span className="sr">Pieces, linked on the bench.</span>
      <span className="resolved-title-visual" aria-hidden="true">
        {LINES.map((line) => {
          const lineOffset = characterOffset;
          characterOffset += line.length;
          return (
            <span className="resolved-title-line" key={line}>
              {Array.from(line, (character, index) => (
                <span
                  className="resolved-title-character"
                  key={`${line}-${index}`}
                  style={{ animationDelay: `${160 + (lineOffset + index) * 22}ms` }}
                >
                  {character === " " ? "\u00a0" : character}
                </span>
              ))}
            </span>
          );
        })}
      </span>
    </h1>
  );
}
