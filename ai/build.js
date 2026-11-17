export function askOrigins(value = process.env.PAGEBORNE_ASK_ORIGINS || '') {
  return [...new Set(value.split(',').map(v => v.trim()).filter(Boolean).map(value => {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PAGEBORNE_ASK_ORIGINS must contain comma-separated HTTP(S) origins, without paths or credentials.');
    return url.origin;
  }))];
}
export function askManifest(manifest, origins = askOrigins(), modelOrigins = []) {
  const whitelist = [...new Set([...origins, ...modelOrigins])];
  return { ...manifest, permissions: [
    ...manifest.permissions.filter(p => !['network', 'g2-microphone', 'phone-microphone'].includes(p.name)),
    { name: 'g2-microphone', desc: 'Records a spoken question when you hold to ask or tap the microphone.' },
    { name: 'phone-microphone', desc: 'Records a spoken question when you hold to talk on the phone reading screen.' },
    ...(whitelist.length ? [{ name: 'network', desc: 'Downloads on-device speech models; sends questions to your chosen AI connection and recordings only to a configured speech provider.', whitelist }] : []),
  ] };
}
