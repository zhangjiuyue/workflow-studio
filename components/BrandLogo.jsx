export const BRAND_LOGO_SRC = "/brand/logo.svg";
export const BRAND_MARK_SRC = "/brand/mark.svg";

export default function BrandLogo({ className = "", alt = "Workflow Studio" }) {
  return (
    <img
      className={["brand-logo-image", className].filter(Boolean).join(" ")}
      src={BRAND_LOGO_SRC}
      alt={alt}
      decoding="async"
    />
  );
}

export function BrandMark({ className = "", alt = "" }) {
  return (
    <img
      className={["brand-mark", className].filter(Boolean).join(" ")}
      src={BRAND_MARK_SRC}
      alt={alt}
      decoding="async"
    />
  );
}
