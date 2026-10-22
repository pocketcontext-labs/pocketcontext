import logo from "./assets/brand/logo.svg?no-inline";
import "./brand.css";

/** Shared PocketContext website mark and locally bundled IBM Plex wordmark. */
export default function Brand({ href }: { href?: string }) {
  const content = <><img src={logo} width="34" height="34" alt="" /><span>PocketContext</span></>;
  return href ? <a className="product-brand" href={href}>{content}</a> : <div className="product-brand">{content}</div>;
}
