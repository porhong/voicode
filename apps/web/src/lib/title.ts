/**
 * The page title and the iOS home screen title carry the PC's name, like the manifest the
 * agent serves, so tabs and installed apps for several PCs can be told apart. Safari's
 * "Add to Home Screen" reads `apple-mobile-web-app-title` from the live page.
 */
const PRODUCT = 'VoiceCode';
let pcName: string | undefined;
let pending = 0;

function render(): void {
  const base = pcName ? `${pcName} · ${PRODUCT}` : PRODUCT;
  document.title = pending ? `(${pending}) ${base}` : base;
}

export function setTitlePcName(name: string | undefined): void {
  pcName = name || undefined;
  document
    .querySelector('meta[name="apple-mobile-web-app-title"]')
    ?.setAttribute('content', pcName ?? PRODUCT);
  render();
}

/** Approval requests waiting; shown as a count in front of the title. */
export function setTitlePending(count: number): void {
  pending = count;
  render();
}
