/**
 * Short unique ids that work everywhere the page can be opened. The page is
 * often reached over plain http on a LAN address — no secure context, so
 * `crypto.randomUUID` is absent there — and an id that throws while React is
 * rendering takes the whole tree down with it.
 */
let counter = 0;

export function mintId(prefix: string): string {
  counter += 1;
  const random = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}${random}${counter.toString(36)}`;
}
