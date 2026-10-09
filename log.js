
export function log(level, message) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${String(level).toUpperCase()}] ${message}`;

  if (level === 'error') {
    console.error(entry);
  } else if (level === 'warn') {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}
