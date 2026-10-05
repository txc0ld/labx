"use client";

import { useEffect, useState } from "react";
import Lottie from "lottie-react";

export function FlowMark() {
  const [data, setData] = useState<object | null>(null);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(media.matches);
    if (!media.matches) {
      fetch("/lab/flow.json")
        .then((response) => response.json())
        .then(setData)
        .catch(() => setData(null));
    }
  }, []);

  if (reduce || !data) {
    return <span className="lamp mint" aria-hidden="true"><i /> live</span>;
  }
  return (
    <Lottie
      animationData={data}
      loop={false}
      style={{ width: 88, height: 22 }}
      aria-hidden="true"
    />
  );
}
