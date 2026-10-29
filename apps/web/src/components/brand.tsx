/** The opensteer brand: gradient orb mark + lowercase Inter wordmark. */
export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <span className={large ? "brand brand--large" : "brand"} aria-hidden>
      <span className="brand__mark">
        <img alt="" decoding="async" src="/opensteer.png" />
      </span>
    </span>
  );
}

export function Brand({ withWord = true }: { withWord?: boolean }) {
  return (
    <span className="brand">
      <span className="brand__mark" aria-hidden>
        <img alt="" decoding="async" src="/opensteer.png" />
      </span>
      {withWord ? <span className="brand__word">opensteer</span> : null}
    </span>
  );
}
