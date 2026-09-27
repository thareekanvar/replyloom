// Ambient declaration for an optional native/WASM crypto bridge used only by the
// /crypto-test diagnostic endpoint (src/index.ts). It is not a real dependency —
// the endpoint dynamically imports it inside a try/catch and reports "ERROR" if
// it's missing. This stub only silences `tsc --noEmit`; it has no runtime effect.
declare module "whatsapp-rust-bridge" {
  export function hkdf(input: Buffer, length: number, options: { salt: Buffer; info: string }): Buffer;
  export function md5(input: Buffer): Buffer;
}
