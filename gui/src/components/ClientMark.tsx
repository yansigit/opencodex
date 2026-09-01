/** Render a decorative client mark consistently across dashboard surfaces. */
import { MASKED_MARKS } from "./integration-marks";

export default function ClientMark({
  src,
  label,
  size = 20,
  className,
}: {
  src: string | null;
  label: string;
  size?: number;
  className?: string;
}) {
  const classes = className ? `client-mark ${className}` : "client-mark";
  const style = { "--client-mark-size": String(size) + "px" } as React.CSSProperties;
  if (!src) {
    return (
      <span className={`${classes} client-mark--monogram`} style={style} aria-hidden="true">
        {label.slice(0, 1)}
      </span>
    );
  }
  if (MASKED_MARKS.has(src)) {
    return (
      <span
        className={`${classes} client-mark--mask`}
        style={{ ...style, maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span className={`${classes} client-mark--img`} style={style} aria-hidden="true">
      <img src={src} alt="" width={size} height={size} />
    </span>
  );
}
