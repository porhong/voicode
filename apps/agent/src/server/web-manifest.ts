/**
 * The web app manifest, served by the agent rather than as a static file so an installed
 * app is named after its PC. Each PC is its own origin and so its own install; with
 * several PCs on one phone, the home screen then says which PC each icon controls.
 * `short_name` (the home screen label) is the PC name alone; `name` (install prompt, app
 * switcher) adds the product.
 *
 * The PC name is given where `/api/info` gives it: to paired devices and on the LAN,
 * never to an unpaired visitor through the tunnel, who gets the plain template.
 */
export function webManifest(
  template: Record<string, unknown>,
  pcName: string | undefined,
): Record<string, unknown> {
  if (!pcName) return template;
  return { ...template, name: `${pcName} · VoiceCode`, short_name: pcName };
}
