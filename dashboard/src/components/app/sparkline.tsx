import { useId } from "react";

// A tiny area chart. The y range has a floor so a flat healthy line does not
// wobble across the whole card from noise.
export function Sparkline({
  values,
  color,
  floor = 0,
  height = 28,
}: {
  values: number[];
  color: string;
  floor?: number;
  height?: number;
}) {
  const id = useId();
  const width = 100;
  if (values.length < 2) {
    return <div style={{ height }} className="w-full rounded bg-muted/40" />;
  }
  const max = Math.max(floor, ...values) || 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => [index * step, height - 2 - (value / max) * (height - 4)] as const);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
